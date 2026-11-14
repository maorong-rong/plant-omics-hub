#!/usr/bin/env node
/**
 * 真实 DSH 端到端验收：HTTP 服务 + 真实宿主 + 真实模型。
 *
 * 做什么：
 *   1. 起本仓库的 HTTP 服务（`dist/service/cli.js`，随机/固定回环端口，按需展开开）；
 *   2. 在**隔离的临时 DSH_HOME**（本目录 `evidence/e2e/<case>/.dsh-home`）里初始化 headless profile，
 *      用 `--patch` 把 `plantomics-hub-mcp`（streamable-http）接上；
 *   3. 跑一次真实 headless 会话：模型先调 `hub_find_sources`，再调新展开的业务工具；
 *   4. 从服务端证据日志 + 宿主自己的 session 日志解出「前后 tools 数组、新增工具、调用次数、最终回答」；
 *   5. 写 `session-evidence.json` 与 `verdict.json`，判实验组/对照组。
 *
 * 用法：
 *   node scripts/e2e-dsh-on-demand.mjs            # 实验组：发 list_changed
 *   node scripts/e2e-dsh-on-demand.mjs --control  # 对照组：PLANTOMICS_ON_DEMAND_NOTIFY=0
 *
 * 凭据：headless 按设计不读托管凭据库。本脚本从**本机 DSH_HOME 的凭据库**取一个
 * `DSH_OPENCODE_GO_ACCOUNT_*` 引用的值，只放进**子进程环境变量** `E2E_OPENCODE_KEY`
 * （不写盘、不打印、不进仓库），provider 的 `apiKeyEnv` 指向它。取不到就直接报缺，不猜、不绕。
 *
 * 不碰：线上 profile、正在跑的三台实例、`dsh-home` 本体（只读它的一份凭据引用）。
 */

import { spawn, spawnSync } from 'node:child_process';
import { chmodSync, cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CONTROL = process.argv.includes('--control');
const CASE = CONTROL ? 'no-notify' : 'notify';
const CASE_DIR = path.join(ROOT, 'docs', 'architecture', '按需展开-2026-11-13', 'evidence', 'e2e', CASE);
const HOME = path.join(CASE_DIR, '.dsh-home');
const PROFILE = path.join(HOME, 'profiles', 'headless');
const PATCH = path.join(CASE_DIR, 'host.patch.yml');
const SERVER_EVIDENCE = path.join(CASE_DIR, 'server.jsonl');
const HOST_STDOUT = path.join(CASE_DIR, 'host.stdout.log');
const HOST_STDERR = path.join(CASE_DIR, 'host.stderr.log');
const SESSION_EVIDENCE = path.join(CASE_DIR, 'session-evidence.json');
const VERDICT = path.join(CASE_DIR, 'verdict.json');

const DSH_BIN = process.env.DSH_BIN ?? 'dsh';
const MODEL = process.env.E2E_MODEL ?? 'deepseek-v4.1-flash';
const PORT = Number(process.env.E2E_PORT ?? 8793);
const TIMEOUT_MS = Number(process.env.E2E_TIMEOUT_MS ?? 300_000);
const SOURCE_DSH_HOME = process.env.E2E_SOURCE_DSH_HOME ?? '/home/yh/ybt/superagent-omics/dsh-home';
const OPENCODE_GO_DIR = process.env.E2E_OPENCODE_GO_DIR
  ?? path.join(SOURCE_DSH_HOME, 'profiles', 'superagent-omics', 'node_modules', 'dsh-opencode-go');

const PROMPT = [
  '你在参与一次 HTTP MCP 按需展开的宿主验收。严格按顺序执行，不要跳步、不要解释计划：',
  '1) 调用工具 mcp__plantomics-hub__hub_find_sources，参数 {"question": "小麦 基因 表达 变异 同源", "species_hint": "小麦"}。',
  '2) 读它的返回，里面写明了本次已展开、现在可以直接调用的业务工具名。',
  '3) 从这些新展开的工具里挑一个最相关的，直接调用它（参数按它的 schema 给最小可用值；不确定就传空对象）。',
  '4) 把这次调用的返回原文贴出来；如果调不动，把它返回的错误原文贴出来。',
  '最后单独一行写：RESULT: OK（新展开工具调通）或 RESULT: FAIL（调不动）。',
].join('\n');

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, ...options });
  return { status: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '', error: result.error };
}

function log(message) {
  process.stdout.write(`${message}\n`);
}

/* ------------------------------------------------------------------ *
 * HTTP 服务
 * ------------------------------------------------------------------ */
function serverEnv() {
  const env = {
    ...process.env,
    PLANTOMICS_HUB_HOST: '127.0.0.1',
    PLANTOMICS_HUB_PORT: String(PORT),
    PLANTOMICS_HUB_TOKEN: '',
    PLANTOMICS_HUB_LOG: path.join(CASE_DIR, 'server-access.log'),
    PLANTOMICS_ON_DEMAND: '1',
    PLANTOMICS_ON_DEMAND_NOTIFY: CONTROL ? '0' : '1',
    PLANTOMICS_EVIDENCE_LOG: SERVER_EVIDENCE,
    PLANTOMICS_EXPAND_PER_CALL: '5',
    PLANTOMICS_SESSION_TTL_MS: String(30 * 60 * 1000),
  };
  delete env.PLANTOMICS_SOURCES;
  return env;
}

async function startService() {
  rmSync(SERVER_EVIDENCE, { force: true });
  const child = spawn(process.execPath, [path.join(ROOT, 'dist', 'service', 'cli.js')], {
    cwd: ROOT,
    env: serverEnv(),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stderr = '';
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${PORT}/healthz`, { signal: AbortSignal.timeout(1000) });
      if (response.ok) return { child, stderr: () => stderr };
    } catch {
      // 还没起来
    }
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  child.kill('SIGTERM');
  throw new Error(`HTTP 服务在 20 s 内没有起来：${stderr.slice(-800)}`);
}

/* ------------------------------------------------------------------ *
 * 临时 DSH home
 * ------------------------------------------------------------------ */
function prepareHome() {
  mkdirSync(PROFILE, { recursive: true });
  const env = { ...process.env, DSH_HOME: HOME };
  const dump = run(DSH_BIN, ['--profile', 'headless', '--dump-config'], { env, cwd: HOME });
  if (dump.status !== 0) {
    throw new Error(`无法组合 headless profile（--dump-config 失败）：${dump.stderr.slice(-800)}`);
  }
  writeFileSync(path.join(CASE_DIR, 'profile-dump.txt'), dump.stdout);

  // dsh-opencode-go 是 provider 插件，不在 dsh-base 里；从本机既装好的 profile 复制，避免联网
  const target = path.join(PROFILE, 'node_modules', 'dsh-opencode-go');
  if (!existsSync(path.join(target, 'package.json'))) {
    if (!existsSync(path.join(OPENCODE_GO_DIR, 'package.json'))) {
      throw new Error(`找不到 dsh-opencode-go：${OPENCODE_GO_DIR}；用 E2E_OPENCODE_GO_DIR 指定`);
    }
    mkdirSync(path.dirname(target), { recursive: true });
    cpSync(OPENCODE_GO_DIR, target, { recursive: true });
    log(`dsh-opencode-go：从 ${OPENCODE_GO_DIR} 复制`);
  }
}

/** 从本机凭据库取 refs（只读；值只进内存，不写盘、不打印）。 */
function readCredentialRefs() {
  const source = path.join(SOURCE_DSH_HOME, '.credentials.yaml');
  if (!existsSync(source)) {
    throw new Error(`找不到本机凭据库 ${source}；请用 E2E_SOURCE_DSH_HOME 指定，或提供模型 key`);
  }
  const text = readFileSync(source, 'utf8');
  const lines = text.split('\n');
  const start = lines.findIndex((line) => /^refs:\s*$/.test(line));
  if (start < 0) throw new Error('凭据库没有 refs 段：无法提供模型 key');
  const refs = {};
  for (let index = start + 1; index < lines.length; index += 1) {
    const line = lines[index];
    if (/^\S/.test(line)) break; // 下一个顶层键
    const match = /^\s+([A-Za-z0-9_]+):\s*(.+?)\s*$/.exec(line);
    if (match) refs[match[1]] = match[2];
  }
  // 优先用**本机在跑实例**配置的账号：凭据库里可能有多个历史账号，挑第一个未必可用（实测 401）。
  const profilePatch = path.join(SOURCE_DSH_HOME, 'profiles', 'superagent-omics', 'cordis.patch.yml');
  let preferred;
  if (existsSync(profilePatch)) {
    const configured = /apiKeyEnv:\s*(DSH_OPENCODE_GO_ACCOUNT_[A-Z0-9]+)/.exec(readFileSync(profilePatch, 'utf8'));
    if (configured && refs[configured[1]]) preferred = configured[1];
  }
  const account = preferred ?? Object.keys(refs).find((name) => name.startsWith('DSH_OPENCODE_GO_ACCOUNT_'));
  if (!account) throw new Error('凭据库里没有 DSH_OPENCODE_GO_ACCOUNT_* 引用：无法提供模型 key');
  return { account, key: refs[account] };
}

function writePatch() {
  const yaml = `# 由 scripts/e2e-dsh-on-demand.mjs 生成（临时 profile，不提交）
# 模型 provider/model：headless 不读托管凭据库，key 只来自子进程环境 E2E_OPENCODE_KEY
- id: agent-default-model
  config:
    provider: dsh-opencode-go
    model: ${MODEL}

- insert:
    - id: opencode-go
      name: dsh-opencode-go
      config:
        apiKeyEnv: E2E_OPENCODE_KEY

    # 被验证的宿主能力：HTTP MCP + notifications/tools/list_changed
    - id: plantomics-hub-mcp
      name: '@deepseek-ai/dsh-mcp-client'
      config:
        serverName: plantomics-hub
        transport: streamable-http
        url: http://127.0.0.1:${PORT}/mcp
        headers: {}
        failOnStartupError: true
`;
  writeFileSync(PATCH, yaml);
}

/* ------------------------------------------------------------------ *
 * 跑宿主
 * ------------------------------------------------------------------ */
function runHost(key) {
  const env = { ...process.env, DSH_HOME: HOME, E2E_OPENCODE_KEY: key };
  return new Promise((resolve) => {
    const child = spawn(DSH_BIN, ['--profile', 'headless', '--patch', PATCH, PROMPT], {
      env,
      cwd: HOME,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    const timer = setTimeout(() => child.kill('SIGTERM'), TIMEOUT_MS);
    child.on('close', (code) => {
      clearTimeout(timer);
      writeFileSync(HOST_STDOUT, stdout);
      writeFileSync(HOST_STDERR, stderr);
      resolve({ code, stdout, stderr });
    });
  });
}

/* ------------------------------------------------------------------ *
 * 证据解析
 * ------------------------------------------------------------------ */
function decodeSession() {
  const sessionsRoot = path.join(HOME, 'sessions');
  if (!existsSync(sessionsRoot)) return { error: '临时 home 下没有 sessions 目录' };
  const files = [];
  for (const dir of readdirSync(sessionsRoot)) {
    const sub = path.join(sessionsRoot, dir);
    if (!statSync(sub).isDirectory()) continue;
    for (const session of readdirSync(sub)) {
      const file = path.join(sub, session, 'session.v4.jsonl.zstd');
      if (existsSync(file)) files.push(file);
    }
  }
  if (files.length === 0) return { error: '没有找到 session.v4.jsonl.zstd' };
  files.sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);
  const decoded = run('zstd', ['-dc', files[0]]);
  if (decoded.status !== 0) return { error: `zstd -dc 失败：${decoded.stderr}` };
  const events = decoded.stdout.split('\n').filter(Boolean).flatMap((line) => {
    try { return [JSON.parse(line)]; } catch { return []; }
  });
  const plantomicsOf = (names) => names.filter((name) => name.startsWith('mcp__plantomics-hub__'));
  const rosters = events
    .filter((event) => event.type === 'request/header')
    .map((event, index) => {
      const names = (event.data?.header?.tools ?? []).map((tool) => tool.name);
      // 完整数组也留：ticket 要求「贴宿主侧 request/header.tools 前后数组」，
      // 只留 plantomics 子集只能证明"多了几个"，证明不了"其余没变"。
      return {
        request: index + 1,
        headerSeq: event.seq,
        time: event.time,
        toolCount: names.length,
        toolNames: names,
        plantomicsTools: plantomicsOf(names),
      };
    });
  const toolAdditions = events
    .filter((event) => event.type === 'developer/message')
    .flatMap((event) => (event.data?.message?.content ?? []))
    .filter((block) => block.type === 'tool-addition')
    .map((block) => block.toolName)
    .filter((name) => typeof name === 'string' && name.startsWith('mcp__plantomics-hub__'));
  const toolCalls = events
    .filter((event) => event.type === 'tool/call')
    .map((event) => event.data?.toolName ?? event.data?.name)
    .filter((name) => typeof name === 'string' && name.startsWith('mcp__plantomics-hub__'));
  const rejected = events
    .filter((event) => event.type === 'tool/result' && /Unknown tool/.test(JSON.stringify(event.data)))
    .map((event) => JSON.stringify(event.data).match(/Unknown tool: ([A-Za-z0-9_]+)/)?.[1] ?? 'unknown');
  return { file: files[0], rosters, toolAdditions, toolCalls, hostDispatchRejections: rejected };
}

function readServerEvidence() {
  if (!existsSync(SERVER_EVIDENCE)) return [];
  return readFileSync(SERVER_EVIDENCE, 'utf8')
    .split('\n')
    .filter(Boolean)
    .flatMap((line) => {
      try { return [JSON.parse(line)]; } catch { return []; }
    });
}

function analyze(host, session) {
  const events = readServerEvidence();
  const expandEvents = events.filter((event) => event.event === 'expand');
  const expandedTools = [...new Set(expandEvents.flatMap((event) => event.added ?? []))];
  const notifyEvents = events.filter((event) => event.event === 'notify/tools_list_changed').length;
  const serverToolCalls = [...new Set(events.filter((event) => event.event === 'tools/call' && event.found !== false && !event.name.startsWith('hub_')).map((event) => event.name))];
  const rosters = session.rosters ?? [];
  const first = rosters[0];
  const later = rosters[rosters.length - 1];
  const newToolsInLaterRequest = later && first
    ? later.plantomicsTools.filter((name) => !first.plantomicsTools.includes(name))
    : [];
  const stdout = host.stdout ?? '';
  const verdictEvidence = {
    case: CASE,
    control: CONTROL,
    model: MODEL,
    // 顶层字段给检查器直接读；server 段保留路径与同源数据，便于人工核对
    expandedTools,
    notifyEvents,
    serverToolCalls,
    server: { port: PORT, evidence: SERVER_EVIDENCE },
    providerRequests: rosters.length,
    providerRosters: rosters,
    newToolsInLaterRequest,
    hostToolAdditionMessages: session.toolAdditions ?? [],
    hostToolCalls: session.toolCalls ?? [],
    hostDispatchRejections: session.hostDispatchRejections ?? [],
    hostExitCode: host.code ?? null,
    hostFinalAnswerHasOk: /RESULT:\s*OK/.test(stdout),
    hostFinalAnswerHasFail: /RESULT:\s*FAIL/.test(stdout),
    sessionError: session.error ?? null,
    sessionFile: session.file ?? null,
  };

  let verdict;
  let reason;
  if (!CONTROL) {
    const seesNewTools = newToolsInLaterRequest.length >= 1;
    const callsNewTool = expandedTools.some((name) => serverToolCalls.includes(name));
    if (notifyEvents > 0 && seesNewTools && callsNewTool && verdictEvidence.hostFinalAnswerHasOk) {
      verdict = '支持';
      reason = `通知 ${notifyEvents} 次；宿主后一次 provider 工具数组多出 ${newToolsInLaterRequest.length} 个工具；`
        + `服务端收到新增工具调用 ${serverToolCalls.filter((name) => expandedTools.includes(name)).join(', ')}；模型答 RESULT: OK。`;
    } else {
      verdict = 'FAIL';
      reason = `实验组没走通：notify=${notifyEvents}，newToolsInLaterRequest=${newToolsInLaterRequest.length}，`
        + `expandedCalled=${callsNewTool}，finalOk=${verdictEvidence.hostFinalAnswerHasOk}。`;
    }
  } else {
    const noNewInRequest = newToolsInLaterRequest.length === 0;
    const noCalls = expandedTools.every((name) => !serverToolCalls.includes(name));
    if (notifyEvents === 0 && noNewInRequest && noCalls) {
      verdict = '对照组符合预期';
      reason = '不发通知：0 次 list_changed、后一次 provider 数组不含新增工具、新增工具一次都没到服务端。';
    } else {
      verdict = '对照组异常';
      reason = `对照组出现了不该有的信号：notify=${notifyEvents}，newToolsInLaterRequest=${newToolsInLaterRequest.length}，calls=${serverToolCalls.join(',')}。`;
    }
  }
  return {
    verdict,
    reason,
    mode: CONTROL ? 'control' : 'experiment',
    host: { exitCode: host.code ?? null, stdout: HOST_STDOUT, stderr: HOST_STDERR },
    evidence: verdictEvidence,
  };
}

/* ------------------------------------------------------------------ *
 * main
 * ------------------------------------------------------------------ */
async function main() {
  if (!existsSync(path.join(ROOT, 'dist', 'service', 'cli.js'))) {
    throw new Error('dist/ 不存在：先 npm run build');
  }
  mkdirSync(CASE_DIR, { recursive: true });
  rmSync(HOME, { recursive: true, force: true });

  prepareHome();
  const { account, key } = readCredentialRefs();
  log(`模型凭据：使用本机 ${account}（值不打印、不落盘）`);
  writePatch();

  const service = await startService();
  log(`HTTP 服务就绪：http://127.0.0.1:${PORT}/mcp（证据 ${SERVER_EVIDENCE}）`);
  try {
    log(`跑真实宿主（${CONTROL ? '对照组：不发通知' : '实验组：发通知'}）…`);
    const host = await runHost(key);
    log(`宿主退出码：${host.code}`);
    const session = decodeSession();
    const result = analyze(host, session);
    writeFileSync(SESSION_EVIDENCE, `${JSON.stringify(result.evidence, null, 2)}\n`);
    writeFileSync(VERDICT, `${JSON.stringify(result, null, 2)}\n`);
    log(`判定：${result.verdict}`);
    log(result.reason);
    process.exitCode = result.verdict === '支持' || result.verdict === '对照组符合预期' ? 0 : 1;
  } finally {
    service.child.kill('SIGTERM');
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
}

main().catch((error) => {
  process.stderr.write(`❌ 端到端验收失败：${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
