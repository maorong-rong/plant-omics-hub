#!/usr/bin/env node
/**
 * 按需展开 HTTP P1+P2 的机器验收（A1–A10 + 负向对照 N1–N4）。
 *
 * 判据来自 `docs/architecture/按需展开-2026-11-13/baseline.json`（开工前落盘），
 * **不从运行时常量现场推导**：阈值被挪动时这里先红。
 *
 * 用法：
 *   npm run build && node scripts/check-on-demand.mjs
 *   node scripts/check-on-demand.mjs --json --out evidence/rounds/round-1/check.json
 *   node scripts/check-on-demand.mjs --with-install     # 末轮：连 npm ci 一起判 A9
 *   node scripts/check-on-demand.mjs --skip-e2e        # 迭代时跳过真实宿主证据（会标 SKIP→FAIL）
 *
 * 退出码：全部 PASS → 0；任一 FAIL → 1。
 */

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const EVIDENCE_DIR = path.join(ROOT, 'docs', 'architecture', '按需展开-2026-11-13', 'evidence');
const BASELINE_PATH = path.join(ROOT, 'docs', 'architecture', '按需展开-2026-11-13', 'baseline.json');
const BASELINE = JSON.parse(readFileSync(BASELINE_PATH, 'utf8'));

const ARGS = new Set(process.argv.slice(2));
const AS_JSON = ARGS.has('--json');
const SKIP_E2E = ARGS.has('--skip-e2e');
const WITH_INSTALL = ARGS.has('--with-install');
const ONLY_INDEX = process.argv.indexOf('--only');
const ONLY = ONLY_INDEX >= 0 ? (process.argv[ONLY_INDEX + 1] ?? '').split(',').filter(Boolean) : undefined;
const OUT_INDEX = process.argv.indexOf('--out');
const OUT_FILE = OUT_INDEX >= 0 ? path.resolve(ROOT, process.argv[OUT_INDEX + 1]) : undefined;

const results = [];
const logLines = [];

function stage(message) {
  if (!AS_JSON) process.stdout.write(`   … ${message}\n`);
}

function record(id, status, detail) {
  results.push({ id, status, detail });
  const mark = status === 'PASS' ? '✅ PASS' : status === 'SKIP' ? '⏭️ SKIP' : '❌ FAIL';
  const line = `${mark}  ${id}  ${detail}`;
  logLines.push(line);
  if (!AS_JSON) process.stdout.write(`${line}\n`);
}

function okay(id, detail) {
  record(id, 'PASS', detail);
}

function bad(id, detail) {
  record(id, 'FAIL', detail);
}

function skip(id, detail) {
  record(id, 'SKIP', detail);
}

/** 一个检查里的断言收集器：任何一条失败都不抛，统一记账。 */
function assertions(id, checks) {
  const failures = [];
  for (const [label, result] of checks) {
    if (result === true) continue;
    failures.push(result === false ? label : `${label}（实测 ${String(result)}）`);
  }
  if (failures.length === 0) okay(id, checks.length > 0 ? '全部断言通过' : '无断言');
  else bad(id, failures.join('；'));
}

function must(condition, message) {
  if (!condition) throw new Error(message);
}

function tryCheck(id, fn) {
  try {
    fn();
  } catch (error) {
    bad(id, error instanceof Error ? error.message : String(error));
  }
}

/* ------------------------------------------------------------------ *
 * dist 模块
 * ------------------------------------------------------------------ */
async function loadDist() {
  const modules = await Promise.all([
    import(pathToFileURL(path.join(ROOT, 'dist', 'sources', 'index.js')).href),
    import(pathToFileURL(path.join(ROOT, 'dist', 'service', 'config.js')).href),
    import(pathToFileURL(path.join(ROOT, 'dist', 'service', 'http.js')).href),
    import('@modelcontextprotocol/sdk/client/index.js'),
    import('@modelcontextprotocol/sdk/client/streamableHttp.js'),
    import('@modelcontextprotocol/sdk/types.js'),
  ]);
  const [{ registry }, { parseServiceConfig }, { createService }, { Client }, { StreamableHTTPClientTransport }, types] = modules;
  return { registry, parseServiceConfig, createService, Client, StreamableHTTPClientTransport, types };
}

const onDemandConfig = (overrides = {}) => ({
  enabled: true,
  notify: true,
  perCallMax: BASELINE.onDemand.expandPerCallMax,
  softMax: BASELINE.onDemand.sessionExpandSoftMax,
  hardMax: BASELINE.onDemand.sessionExpandHardMax,
  sessionTtlMs: BASELINE.limits.sessionTtlMsDefault,
  sessionMax: BASELINE.limits.sessionMaxDefault,
  ...overrides,
});

/* ------------------------------------------------------------------ *
 * 服务与客户端辅助
 * ------------------------------------------------------------------ */
function makeServiceFactory(dist) {
  const { registry, parseServiceConfig, createService } = dist;
  return async function start(onDemand = onDemandConfig(), envOverrides = {}) {
    const config = parseServiceConfig({
      ...process.env,
      ...envOverrides,
      PLANTOMICS_HUB_HOST: '127.0.0.1',
      PLANTOMICS_HUB_PORT: '0',
      PLANTOMICS_HUB_TOKEN: '',
      PLANTOMICS_HUB_LOG: 'quiet',
    });
    const evidence = [];
    const service = await createService({
      registry,
      config,
      logger: () => {},
      onDemand,
      evidence: (event) => evidence.push(event),
    }).start();
    return { service, evidence };
  };
}

async function connectClient(dist, url) {
  const transport = new dist.StreamableHTTPClientTransport(new URL(url));
  const client = new dist.Client({ name: 'check-on-demand', version: '0.0.0' }, { capabilities: {} });
  await client.connect(transport);
  return { client, transport };
}

function textOf(result) {
  return (result.content ?? []).map((entry) => entry.text ?? '').join('\n');
}

function hubStatusDefaultTools(text) {
  const match = /默认下发：\s*(\d+)\s*个工具/.exec(text);
  return match ? Number(match[1]) : undefined;
}

async function waitFor(predicate, timeoutMs = 10_000) {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) return false;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return true;
}

function postToolList(service, sessionId) {
  return fetch(service.url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      ...(sessionId ? { 'mcp-session-id': sessionId } : {}),
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
  });
}

/* ------------------------------------------------------------------ *
 * A1 / A2 / A3a / A6（同一服务上的协议级行为）
 * ------------------------------------------------------------------ */
async function checkProtocol(dist, start) {
  stage('启动默认服务');
  const { service, evidence } = await start();
  stage('连接客户端');
  const { client } = await connectClient(dist, service.url);
  try {
    stage('A1 初始 tools/list');
    // A1：初始 2 个元工具
    const initial = (await client.listTools()).tools.map((tool) => tool.name);
    assertions('A1', [
      ['初始 tools/list 条数为 2', initial.length === BASELINE.onDemand.defaultSessionTools],
      ['初始工具名恰为两个元工具', JSON.stringify([...initial].sort()) === JSON.stringify([...BASELINE.defaultMetaTools].sort())],
    ]);

    // A2：find 后本会话注册表 + list_changed
    let notifications = 0;
    client.setNotificationHandler(dist.types.ToolListChangedNotificationSchema, () => {
      notifications += 1;
    });
    await new Promise((resolve) => setTimeout(resolve, 150)); // 等 GET SSE 建立
    stage('A2 hub_find_sources + 等通知');
    const found = await client.callTool({
      name: 'hub_find_sources',
      arguments: { question: BASELINE.probe.question, species_hint: BASELINE.probe.speciesHint },
    });
    const foundText = textOf(found);
    const notified = await waitFor(() => notifications > 0, BASELINE.limits.notificationTimeoutMs);
    const afterFind = (await client.listTools()).tools.map((tool) => tool.name);
    const expanded = afterFind.filter((name) => !name.startsWith('hub_'));
    const expandEvents = evidence.filter((event) => event.event === 'expand');
    const lastExpand = expandEvents[expandEvents.length - 1];
    assertions('A2', [
      ['find 未报错', found.isError !== true],
      ['正文说明展开结果', foundText.includes('展开：本次新增')],
      [`客户端收到 list_changed（实测 ${notifications} 次）`, notified === true],
      [`展开数在 1..${BASELINE.onDemand.expandPerCallMax}`, expanded.length >= BASELINE.probe.minExpanded && expanded.length <= BASELINE.probe.maxExpanded],
      ['tools/list 条数 = 2 + 展开数', afterFind.length === 2 + expanded.length],
      ['服务端 expand 事件记录了本次新增', Boolean(lastExpand) && Array.isArray(lastExpand.added)],
      ['服务端新增工具名与 tools/list 一致', Boolean(lastExpand) && lastExpand.added.every((name) => afterFind.includes(name))],
    ]);

    // A2 补充：候选 ≥6 时每次只展开 5 个（top-N 上限）
    stage('A2.topN 宽问题展开');
    const broad = await client.callTool({
      name: 'hub_find_sources',
      arguments: { question: BASELINE.topNProbe.question, species_hint: BASELINE.topNProbe.speciesHint },
    });
    const broadText = textOf(broad);
    const broadAdded = /展开：本次新增 (\d+) 个业务工具/.exec(broadText);
    assertions('A2.topN', [
      ['候选 ≥6 的探针问题有一次展开动作', broad.isError !== true && broadAdded !== null],
      [`一次最多展开 ${BASELINE.topNProbe.expectedExpanded} 个`, broadAdded !== null && Number(broadAdded[1]) <= BASELINE.topNProbe.expectedExpanded],
    ]);
    const afterBroad = (await client.listTools()).tools.map((tool) => tool.name);
    const businessAfter = afterBroad.filter((name) => !name.startsWith('hub_'));
    assertions('A6.perCall', [
      [`会话累计不超过 2 + perCallMax（第一轮）`, businessAfter.length <= BASELINE.onDemand.expandPerCallMax * 2],
      ['重复 find 不重复注册（名称唯一）', new Set(afterBroad).size === afterBroad.length],
    ]);

    // A3a：新增工具可被服务端派发（离线环境可能上游失败，但不能是"未知工具"）
    stage('A3.protocol 调用新工具');
    const newTool = expanded[0];
    must(typeof newTool === 'string' && newTool !== '', '没有展开任何业务工具，A3a 无法判定');
    const called = await client.callTool({ name: newTool, arguments: {} });
    const calledText = textOf(called);
    assertions('A3.protocol', [
      ['新增工具进入 tools/list', expanded.length > 0],
      ['调用新增工具没被当成未知工具', !calledText.includes('未知工具')],
    ]);

    // A6.幂等：同一问题再问一次，本次新增 0 且不再发通知
    stage('A6.idempotent 重复 find');
    const notifyBefore = notifications;
    const again = await client.callTool({
      name: 'hub_find_sources',
      arguments: { question: BASELINE.probe.question, species_hint: BASELINE.probe.speciesHint },
    });
    const againText = textOf(again);
    const afterAgain = (await client.listTools()).tools.map((tool) => tool.name);
    assertions('A6.idempotent', [
      ['重复 find 本次新增 0 个', againText.includes('本次新增 0 个')],
      ['重复 find 不增长工具集', afterAgain.length === afterBroad.length],
      [`重复 find 不发多余通知（实测 ${notifications - notifyBefore}）`, notifications - notifyBefore === 0],
    ]);
    return { evidence };
  } finally {
    await client.close().catch(() => {});
    await service.close().catch(() => {});
  }
}

/* ------------------------------------------------------------------ *
 * A6 上限（软建议/硬上限）
 * ------------------------------------------------------------------ */
async function checkLimits(dist, start) {
  // 软建议：超过只警示
  {
    const { service } = await start(onDemandConfig({ perCallMax: 5, softMax: 4 }));
    const { client } = await connectClient(dist, service.url);
    try {
      await new Promise((resolve) => setTimeout(resolve, 120));
      const found = await client.callTool({
        name: 'hub_find_sources',
        arguments: { question: BASELINE.topNProbe.question, species_hint: BASELINE.topNProbe.speciesHint },
      });
      const text = textOf(found);
      assertions('A6.soft', [
        ['超过软建议仍继续展开', /展开：本次新增 [1-5] 个业务工具/.test(text)],
        ['正文出现软建议警示', text.includes('超过软建议')],
      ]);
    } finally {
      await client.close().catch(() => {});
      await service.close().catch(() => {});
    }
  }
  // 硬上限：拒绝继续展开、不发通知
  {
    const { service } = await start(onDemandConfig({ perCallMax: 3, hardMax: 3, softMax: 40 }));
    const { client } = await connectClient(dist, service.url);
    try {
      let notifications = 0;
      client.setNotificationHandler(dist.types.ToolListChangedNotificationSchema, () => {
        notifications += 1;
      });
      await new Promise((resolve) => setTimeout(resolve, 120));
      await client.callTool({
        name: 'hub_find_sources',
        arguments: { question: BASELINE.topNProbe.question, species_hint: BASELINE.topNProbe.speciesHint },
      });
      const afterFirst = (await client.listTools()).tools.length;
      const second = await client.callTool({
        name: 'hub_find_sources',
        arguments: { question: BASELINE.topNProbe.question, species_hint: BASELINE.topNProbe.speciesHint },
      });
      const secondText = textOf(second);
      await new Promise((resolve) => setTimeout(resolve, 250));
      const afterSecond = (await client.listTools()).tools.length;
      assertions('A6.hard', [
        [`第一次展开到 hardMax=3（实测 ${afterFirst}）`, afterFirst === 2 + 3],
        ['第二次 find 明确写「已达会话硬上限 3」', secondText.includes('已达会话硬上限 3')],
        ['第二次不再新增工具', afterSecond === afterFirst],
        [`硬上限不再发通知（实测 ${notifications}）`, notifications === 1],
      ]);
      assertions('N3', [
        ['超上限展开被拒绝且可复现', secondText.includes('已达会话硬上限 3') && afterSecond === afterFirst],
      ]);
    } finally {
      await client.close().catch(() => {});
      await service.close().catch(() => {});
    }
  }
}

/* ------------------------------------------------------------------ *
 * A5 会话态
 * ------------------------------------------------------------------ */
async function checkSessions(dist, start) {
  // 签发 / 复用 / 未知 / 缺会话
  {
    const { service } = await start();
    const { client, transport } = await connectClient(dist, service.url);
    try {
      const sessionId = transport.sessionId;
      const missing = await postToolList(service);
      const unknown = await postToolList(service, 'nope');
      const listed = (await client.listTools()).tools.length;
      assertions('A5.issue', [
        ['initialize 签发非空 mcp-session-id', typeof sessionId === 'string' && sessionId.length > 0],
        ['同一会话复用后仍能列工具', listed === 2],
        [`缺会话 id 的非 initialize POST → 400（实测 ${missing.status}）`, missing.status === 400],
        [`未知会话 id → 404（实测 ${unknown.status}）`, unknown.status === 404],
      ]);
    } finally {
      await client.close().catch(() => {});
      await service.close().catch(() => {});
    }
  }
  // 并发隔离
  {
    const { service } = await start();
    const a = await connectClient(dist, service.url);
    const b = await connectClient(dist, service.url);
    try {
      await new Promise((resolve) => setTimeout(resolve, 120));
      await a.client.callTool({
        name: 'hub_find_sources',
        arguments: { question: BASELINE.topNProbe.question, species_hint: BASELINE.topNProbe.speciesHint },
      });
      const aCount = (await a.client.listTools()).tools.length;
      const bCount = (await b.client.listTools()).tools.length;
      assertions('A5.isolation', [
        ['A 会话已展开', aCount > 2],
        [`B 会话仍是 2 个工具（实测 ${bCount}）`, bCount === 2],
      ]);
    } finally {
      await a.client.close().catch(() => {});
      await b.client.close().catch(() => {});
      await service.close().catch(() => {});
    }
  }
  // TTL 过期（N2）
  {
    const { service } = await start(onDemandConfig({ sessionTtlMs: BASELINE.negativeControls.ttlProbeMs }));
    const { transport } = await connectClient(dist, service.url);
    try {
      const sessionId = transport.sessionId;
      await new Promise((resolve) => setTimeout(resolve, BASELINE.negativeControls.ttlWaitMs));
      const expired = await postToolList(service, sessionId);
      assertions('A5.ttl', [
        [`过期会话 → 404（实测 ${expired.status}）`, expired.status === 404],
      ]);
      assertions('N2', [
        ['过期后旧会话不再可用', expired.status === 404],
      ]);
    } finally {
      await service.close().catch(() => {});
    }
  }
  // 数量上限
  {
    const { service } = await start(onDemandConfig({ sessionMax: BASELINE.negativeControls.sessionMaxProbe }));
    const first = await connectClient(dist, service.url);
    const firstId = first.transport.sessionId;
    try {
      await new Promise((resolve) => setTimeout(resolve, 25));
      const second = await connectClient(dist, service.url);
      await new Promise((resolve) => setTimeout(resolve, 25));
      const third = await connectClient(dist, service.url);
      const evicted = await postToolList(service, firstId);
      const alive = await third.client.listTools();
      assertions('A5.maxSessions', [
        [`最旧会话被驱逐（实测 ${evicted.status}）`, evicted.status === 404],
        ['新会话仍可用（不是拒绝新连接）', alive.tools.length === 2],
      ]);
      await second.client.close().catch(() => {});
      await third.client.close().catch(() => {});
    } finally {
      await first.client.close().catch(() => {});
      await service.close().catch(() => {});
    }
  }
  // DELETE
  {
    const { service } = await start();
    const { client, transport } = await connectClient(dist, service.url);
    const sessionId = transport.sessionId;
    await client.close().catch(() => {});
    try {
      const deleted = await fetch(service.url, { method: 'DELETE', headers: { 'mcp-session-id': sessionId } });
      const after = await postToolList(service, sessionId);
      assertions('A5.delete', [
        [`DELETE 返回 200/204（实测 ${deleted.status}）`, [200, 204].includes(deleted.status)],
        [`DELETE 后旧 id → 404（实测 ${after.status}）`, after.status === 404],
      ]);
    } finally {
      await service.close().catch(() => {});
    }
  }
}

/* ------------------------------------------------------------------ *
 * A7 / A8 读数与回滚
 * ------------------------------------------------------------------ */
async function checkReadings(dist, start) {
  // A7：默认模式三处一致 + 目录规模另报
  {
    const { service } = await start();
    const { client } = await connectClient(dist, service.url);
    try {
      const catalog = await (await fetch(new URL('/catalog', service.url))).json();
      const health = await (await fetch(new URL('/healthz', service.url))).json();
      const tools = (await client.listTools()).tools;
      const status = await client.callTool({ name: 'hub_status', arguments: {} });
      const hubStatus = hubStatusDefaultTools(textOf(status));
      assertions('A7.threeReadings', [
        [`/catalog.budget.defaultSetTools = 2（实测 ${catalog.budget.defaultSetTools}）`, catalog.budget.defaultSetTools === BASELINE.onDemand.defaultSessionTools],
        [`hub_status 默认下发 = 2（实测 ${hubStatus}）`, hubStatus === BASELINE.onDemand.defaultSessionTools],
        [`tools/list = 2（实测 ${tools.length}）`, tools.length === BASELINE.onDemand.defaultSessionTools],
        [`三处相等`, catalog.budget.defaultSetTools === hubStatus && hubStatus === tools.length],
        [`/catalog.budget.catalogTools = 49（实测 ${catalog.budget.catalogTools}）`, catalog.budget.catalogTools === BASELINE.onDemand.catalogTools],
        [`/catalog.budget.expandableTools = 47（实测 ${catalog.budget.expandableTools}）`, catalog.budget.expandableTools === BASELINE.onDemand.expandableTools],
        [`/healthz.tools = 49（实测 ${health.tools}）`, health.tools === BASELINE.onDemand.catalogTools],
        [`/healthz.defaultSessionTools = 2（实测 ${health.defaultSessionTools}）`, health.defaultSessionTools === BASELINE.onDemand.defaultSessionTools],
      ]);
    } finally {
      await client.close().catch(() => {});
      await service.close().catch(() => {});
    }
  }
  // A7：stats / counts / contracts 命令
  {
    const stats = runCommand(['npm', 'run', 'stats']);
    const counts = runCommand(['npm', 'run', 'check:counts']);
    const contracts = runCommand(['npm', 'run', 'check:contracts']);
    assertions('A7.commands', [
      [`npm run stats exit 0（实测 ${stats.status}）`, stats.status === 0],
      ['stats 输出「目录」口径', stats.stdout.includes('目录') && stats.stdout.includes(String(BASELINE.onDemand.catalogTools))],
      ['stats 输出「默认会话」口径', stats.stdout.includes('默认会话') && stats.stdout.includes(`${BASELINE.onDemand.defaultSessionTools} 个工具`)],
      [`npm run check:counts exit 0（实测 ${counts.status}）`, counts.status === 0],
      [`npm run check:contracts exit 0（实测 ${contracts.status}）`, contracts.status === 0],
    ]);
    // 契约文档必须记录新字段与新语义
    const doc = safeRead('docs/catalog契约.md');
    assertions('A7.contractDoc', [
      ['契约文档记录 catalogTools', doc.includes('catalogTools')],
      ['契约文档记录 expandableTools', doc.includes('expandableTools')],
      ['契约文档记录 defaultSetTools 新语义', doc.includes('默认会话实际下发')],
    ]);
  }
  // A8：回滚
  {
    const { service } = await start({ ...onDemandConfig(), enabled: false });
    const { client } = await connectClient(dist, service.url);
    try {
      const catalog = await (await fetch(new URL('/catalog', service.url))).json();
      const health = await (await fetch(new URL('/healthz', service.url))).json();
      const tools = (await client.listTools()).tools;
      const status = await client.callTool({ name: 'hub_status', arguments: {} });
      const hubStatus = hubStatusDefaultTools(textOf(status));
      const sourceTools = catalog.sources.flatMap((source) => source.tools);
      const union = new Set([...sourceTools, ...tools.filter((tool) => tool.name.startsWith('hub_')).map((tool) => tool.name)]);
      assertions('A8', [
        [`/catalog.defaultSetTools = 49（实测 ${catalog.budget.defaultSetTools}）`, catalog.budget.defaultSetTools === BASELINE.rollback.defaultSessionTools],
        [`catalogTools = 49（实测 ${catalog.budget.catalogTools}）`, catalog.budget.catalogTools === BASELINE.onDemand.catalogTools],
        [`expandableTools = 0（实测 ${catalog.budget.expandableTools}）`, catalog.budget.expandableTools === BASELINE.rollback.expandableTools],
        ['onDemand = false', catalog.budget.onDemand === false],
        [`hub_status = 49（实测 ${hubStatus}）`, hubStatus === BASELINE.rollback.defaultSessionTools],
        [`tools/list = 49（实测 ${tools.length}）`, tools.length === BASELINE.rollback.toolsList],
        [`sources[].tools ∪ 元工具 = 49（实测 ${union.size}）`, union.size === BASELINE.onDemand.catalogTools],
        [`/healthz.tools = 49（实测 ${health.tools}）`, health.tools === BASELINE.rollback.defaultSessionTools],
      ]);
      const stats = runCommand(['npm', 'run', 'stats'], { PLANTOMICS_ON_DEMAND: '0' });
      assertions('A8.stats', [
        [`回滚时 npm run stats exit 0（实测 ${stats.status}）`, stats.status === 0],
        ['回滚时 stats 报「默认推荐集」= 49', stats.stdout.includes('默认推荐集') && stats.stdout.includes('49 工具')],
      ]);
    } finally {
      await client.close().catch(() => {});
      await service.close().catch(() => {});
    }
  }
}

/* ------------------------------------------------------------------ *
 * A3b / A4 / N1 / N4：真实宿主证据
 * ------------------------------------------------------------------ */
function readJsonFile(file) {
  if (!existsSync(file)) return undefined;
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return undefined;
  }
}

async function checkE2E(dist, start) {
  if (SKIP_E2E) {
    skip('A3.host', '--skip-e2e：未读取真实宿主证据');
    skip('A4', '--skip-e2e：未读取真实宿主证据');
    skip('N4', '--skip-e2e：未读取真实宿主证据');
    return;
  }
  const notify = readJsonFile(path.join(EVIDENCE_DIR, 'e2e', 'notify', 'session-evidence.json'));
  const control = readJsonFile(path.join(EVIDENCE_DIR, 'e2e', 'no-notify', 'session-evidence.json'));

  if (!notify) {
    bad('A3.host', '缺少 evidence/e2e/notify/session-evidence.json（先跑 scripts/e2e-dsh-on-demand.mjs）');
  } else {
    const rosters = notify.providerRosters ?? [];
    const first = rosters[0];
    const later = rosters[rosters.length - 1];
    const addedToRequest = later && first
      ? later.plantomicsTools.filter((name) => !first.plantomicsTools.includes(name))
      : [];
    // 完整数组差集：证明"新增都在本服务命名空间内，其余工具没被顺手改掉"
    const fullDiff = later?.toolNames && first?.toolNames
      ? later.toolNames.filter((name) => !first.toolNames.includes(name))
      : undefined;
    const removed = later?.toolNames && first?.toolNames
      ? first.toolNames.filter((name) => !later.toolNames.includes(name))
      : undefined;
    const expanded = notify.expandedTools ?? notify.server?.expandedTools ?? [];
    const notifyServerCalls = notify.serverToolCalls ?? notify.server?.serverToolCalls ?? [];
    assertions('A3.host', [
      ['至少两次 provider 请求（前后数组可比）', rosters.length >= 2],
      ['后一次 provider 工具数组包含新增工具', addedToRequest.length >= 1],
      ['新增工具名都在 mcp__plantomics-hub__ 命名空间', addedToRequest.every((name) => name.startsWith('mcp__plantomics-hub__'))],
      ['服务端记录到新增工具的 tools/call', expanded.some((name) => notifyServerCalls.includes(name))],
      ['宿主最终答出 RESULT: OK', notify.hostFinalAnswerHasOk === true],
      ['宿主进程 exit 0', notify.hostExitCode === 0],
      ...(fullDiff
        ? [
          [`完整 request/header.tools 差集全部在本服务命名空间（实测 ${fullDiff.length} 个）`,
            fullDiff.length >= 1 && fullDiff.every((name) => name.startsWith('mcp__plantomics-hub__'))],
          ['后一次数组没有丢工具', removed !== undefined && removed.length === 0],
        ]
        : [['证据含完整 request/header.tools 前后数组', false]]),
    ]);
  }

  if (!control) {
    bad('A4', '缺少 evidence/e2e/no-notify/session-evidence.json');
    bad('N4', '缺少对照组证据，无法判定 N4');
  } else {
    const expanded = control.expandedTools ?? control.server?.expandedTools ?? [];
    const calls = control.serverToolCalls ?? control.server?.serverToolCalls ?? [];
    const controlNotify = control.notifyEvents ?? control.server?.notifyEvents ?? 0;
    const rosters = control.providerRosters ?? [];
    const anyNewInRequest = rosters.some((roster) => (roster.plantomicsTools ?? []).some((name) => expanded.some((raw) => name === `mcp__plantomics-hub__${raw}`)));
    assertions('A4', [
      ['对照组一条 list_changed 都没有', controlNotify === 0],
      ['对照组后一次 provider 数组不含新增工具', anyNewInRequest === false],
      ['对照组这些工具一次都没到服务端', expanded.every((name) => !calls.includes(name))],
    ]);
    assertions('N4', [
      ['客户端不重拉时业务工具不可达（对照组成立）', anyNewInRequest === false && expanded.every((name) => !calls.includes(name))],
    ]);
  }
}

/* ------------------------------------------------------------------ *
 * N1：协议层"不发通知"对照
 * ------------------------------------------------------------------ */
async function checkNoNotify(dist, start) {
  const { service } = await start(onDemandConfig({ notify: false }));
  const { client } = await connectClient(dist, service.url);
  try {
    let notifications = 0;
    client.setNotificationHandler(dist.types.ToolListChangedNotificationSchema, () => {
      notifications += 1;
    });
    await new Promise((resolve) => setTimeout(resolve, 150));
    await client.callTool({
      name: 'hub_find_sources',
      arguments: { question: BASELINE.topNProbe.question, species_hint: BASELINE.topNProbe.speciesHint },
    });
    await new Promise((resolve) => setTimeout(resolve, 300));
    assertions('N1', [
      [`不发通知时客户端收不到 list_changed（实测 ${notifications}）`, notifications === 0],
    ]);
  } finally {
    await client.close().catch(() => {});
    await service.close().catch(() => {});
  }
}

/* ------------------------------------------------------------------ *
 * A10 token 实测
 * ------------------------------------------------------------------ */
function checkTokens() {
  const measured = runCommand(['node', 'scripts/measure-on-demand-payload.mjs', '--json']);
  if (measured.status !== 0) {
    bad('A10', `测量脚本 exit ${measured.status}：${measured.stderr.slice(0, 300)}`);
    return;
  }
  let data;
  try {
    data = JSON.parse(measured.stdout);
  } catch {
    bad('A10', '测量脚本输出不是 JSON');
    return;
  }
  mkdirSync(EVIDENCE_DIR, { recursive: true });
  writeFileSync(path.join(EVIDENCE_DIR, 'tokens.json'), `${JSON.stringify(data, null, 2)}\n`);
  assertions('A10', [
    ['默认 2 个元工具', data.defaultTwo?.count === BASELINE.onDemand.defaultSessionTools],
    ['最坏展开 2 + 5 = 7', data.worstFive?.count === 7],
    ['目录全量 49', data.catalogAll?.count === BASELINE.onDemand.catalogTools],
    ['默认 payload 小于目录全量', Number.isInteger(data.defaultTwo?.tokens) && data.defaultTwo.tokens < data.catalogAll.tokens],
    ['最坏展开小于目录全量', data.worstFive.tokens < data.catalogAll.tokens],
  ]);
  if (!AS_JSON) {
    process.stdout.write(`   token 实测：默认 ${data.defaultTwo.tokens} / 最坏 ${data.worstFive.tokens} / 目录 ${data.catalogAll.tokens} / 真实展开 ${data.actualAfterFind.tokens}\n`);
  }
}

/* ------------------------------------------------------------------ *
 * A9：npm ci + npm run check
 * ------------------------------------------------------------------ */
function checkFullSuite() {
  if (WITH_INSTALL) {
    const ci = runCommand(['npm', 'ci'], {}, 900_000);
    assertions('A9.install', [
      [`npm ci exit 0（实测 ${ci.status}）`, ci.status === 0],
    ]);
  } else {
    skip('A9.install', '未传 --with-install：npm ci 未在本次运行中执行（末轮必须带）');
  }
  const check = runCommand(['npm', 'run', 'check'], {}, 1_800_000);
  assertions('A9.check', [
    [`npm run check exit 0（实测 ${check.status}）`, check.status === 0],
  ]);
}

/* ------------------------------------------------------------------ *
 * 命令执行
 * ------------------------------------------------------------------ */
function runCommand(argv, envOverrides = {}, timeout = 300_000) {
  const env = { ...process.env, ...envOverrides };
  delete env.PLANTOMICS_SOURCES;
  if (envOverrides.PLANTOMICS_SOURCES === undefined) delete env.PLANTOMICS_SOURCES;
  if (envOverrides.PLANTOMICS_ON_DEMAND === undefined) delete env.PLANTOMICS_ON_DEMAND;
  const result = spawnSync(argv[0], argv.slice(1), {
    cwd: ROOT,
    env,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    timeout,
  });
  return { status: result.status ?? 1, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
}

function safeRead(relative) {
  try {
    return readFileSync(path.join(ROOT, relative), 'utf8');
  } catch {
    return '';
  }
}

/* ------------------------------------------------------------------ *
 * main
 * ------------------------------------------------------------------ */
async function main() {
  const dist = await loadDist();
  const start = makeServiceFactory(dist);

  const suite = [
    ['A9', () => checkFullSuite()],
    ['A1/A2/A3/A6', () => checkProtocol(dist, start)],
    ['A5', () => checkSessions(dist, start)],
    ['A6-limit', () => checkLimits(dist, start)],
    ['A7/A8', () => checkReadings(dist, start)],
    ['N1', () => checkNoNotify(dist, start)],
    ['A3b/A4/N4', () => checkE2E(dist, start)],
    ['A10', () => checkTokens()],
  ];
  for (const [label, run] of suite) {
    if (ONLY && !ONLY.some((needle) => label.split('/').some((part) => part.trim().toLowerCase() === needle.toLowerCase()))) continue;
    if (!AS_JSON) process.stdout.write(`\n── ${label} ──\n`);
    try {
      // 单个检查最多 10 分钟：卡住要报出来，而不是把验收器永远挂着
      await Promise.race([
        run(),
        new Promise((_, reject) => setTimeout(() => reject(new Error(`检查 ${label} 超过 10 分钟未结束`)), 600_000)),
      ]);
    } catch (error) {
      bad(`suite/${label}`, error instanceof Error ? error.message : String(error));
    }
  }

  const failed = results.filter((entry) => entry.status !== 'PASS');
  const summary = {
    baseline: { frozenAt: BASELINE.frozenAt, baseCommit: BASELINE.baseCommit },
    ranAt: new Date().toISOString(),
    withInstall: WITH_INSTALL,
    skipE2E: SKIP_E2E,
    results,
    passed: results.filter((entry) => entry.status === 'PASS').length,
    failed: failed.map((entry) => entry.id),
    verdict: failed.length === 0 ? 'ALL_PASS' : 'FAIL',
  };
  if (OUT_FILE) {
    mkdirSync(path.dirname(OUT_FILE), { recursive: true });
    writeFileSync(OUT_FILE, `${JSON.stringify(summary, null, 2)}\n`);
    writeFileSync(OUT_FILE.replace(/\.json$/, '.log'), `${logLines.join('\n')}\n`);
  }
  if (AS_JSON) {
    process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
  } else {
    process.stdout.write(`\n${'-'.repeat(60)}\nPASS ${summary.passed} / ${results.length}`);
    if (failed.length > 0) process.stdout.write(`｜FAIL：${failed.map((entry) => entry.id).join(', ')}\n`);
    else process.stdout.write('\n末轮判定：ALL PASS\n');
  }
  // 显式退出：检查脚本会留下 MCP 客户端/HTTP keep-alive 句柄，等事件循环自然清空会永久挂住。
  // 证据文件与判定已在上面写完，这里强制退出是安全的。
  process.exit(failed.length === 0 ? 0 : 1);
}

main().catch((error) => {
  process.stderr.write(`❌ 验收器异常：${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exitCode = 1;
});
