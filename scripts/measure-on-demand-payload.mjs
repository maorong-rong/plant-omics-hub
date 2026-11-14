#!/usr/bin/env node
/**
 * A10：按需展开的 token 实测（不是估算）。
 *
 * 测三个**真实 payload**，单位都是「MCP `tools/list` 返回对象 `{"tools":[...]}` 的
 * cl100k_base token 数」，与客户端实际解析到的 JSON 同形：
 *   1. 默认会话：2 个元工具；
 *   2. 最坏展开：2 个元工具 + 声明最长的 5 个业务工具（按同一份声明逐条量 token 后降序取 5）；
 *   3. 目录全量：49 个工具（作对照，说明"默认只下发 2 个"省的是哪一段）。
 * 另附一次真实 `hub_find_sources` 展开后的实际 payload（不是估算的最坏值）。
 *
 * 旧值 472 / 3,976 / 4,448 只作对照，本脚本不复用它们。
 *
 * 用法：
 *   npm run build && node scripts/measure-on-demand-payload.mjs [--json]
 */

import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { encode } from 'gpt-tokenizer';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const AS_JSON = process.argv.includes('--json');

/** 与 `src/mcp/server.ts` 的 `toMcpTool` 同形：客户端拿到的就是这份声明。 */
function toMcpTool(tool) {
  return {
    name: tool.name,
    title: tool.name,
    description: tool.description,
    inputSchema: tool.parameters,
    annotations: { readOnlyHint: true, openWorldHint: true },
  };
}

function tokensOfTools(tools) {
  const payload = { tools };
  return {
    count: tools.length,
    tokens: encode(JSON.stringify(payload)).length,
    names: tools.map((tool) => tool.name),
  };
}

async function loadDist() {
  const modules = await Promise.all([
    import(pathToFileURL(path.join(ROOT, 'dist', 'sources', 'index.js')).href),
    import(pathToFileURL(path.join(ROOT, 'dist', 'service', 'config.js')).href),
    import(pathToFileURL(path.join(ROOT, 'dist', 'service', 'http.js')).href),
    import('@modelcontextprotocol/sdk/client/index.js'),
    import('@modelcontextprotocol/sdk/client/streamableHttp.js'),
  ]);
  const [{ registry }, { parseServiceConfig }, { createService }, { Client }, { StreamableHTTPClientTransport }] = modules;
  return { registry, parseServiceConfig, createService, Client, StreamableHTTPClientTransport };
}

async function connect(Client, StreamableHTTPClientTransport, url) {
  const client = new Client({ name: 'measure-on-demand-payload', version: '0.0.0' });
  await client.connect(new StreamableHTTPClientTransport(new URL(url)));
  return client;
}

async function main() {
  const { registry, parseServiceConfig, createService, Client, StreamableHTTPClientTransport } = await loadDist();
  const build = spawnSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: ROOT, encoding: 'utf8' });

  const serviceConfig = parseServiceConfig({
    PLANTOMICS_HUB_HOST: '127.0.0.1',
    PLANTOMICS_HUB_PORT: '0',
    PLANTOMICS_HUB_TOKEN: '',
    PLANTOMICS_HUB_LOG: 'quiet',
  });
  const onDemand = {
    enabled: true,
    notify: true,
    perCallMax: 5,
    softMax: 40,
    hardMax: 80,
    sessionTtlMs: 30 * 60 * 1000,
    sessionMax: 64,
  };
  const onDemandService = await createService({ registry, config: serviceConfig, logger: () => {}, onDemand }).start();
  const staticService = await createService({
    registry,
    config: serviceConfig,
    logger: () => {},
    onDemand: { ...onDemand, enabled: false },
  }).start();

  const onDemandClient = await connect(Client, StreamableHTTPClientTransport, onDemandService.url);
  const staticClient = await connect(Client, StreamableHTTPClientTransport, staticService.url);
  try {
    const initial = (await onDemandClient.listTools()).tools;
    const catalog = (await staticClient.listTools()).tools;
    if (initial.length !== 2) throw new Error(`默认会话应只有 2 个元工具，实测 ${initial.length}`);
    if (catalog.length !== 49) throw new Error(`目录应有 49 个工具，实测 ${catalog.length}`);

    const metaTools = initial;
    const business = catalog.filter((tool) => !tool.name.startsWith('hub_'));
    const businessWithTokens = business.map((tool) => ({
      tool,
      tokens: encode(JSON.stringify({ tools: [tool] })).length,
    }));
    const worstFive = [...businessWithTokens]
      .sort((a, b) => b.tokens - a.tokens || a.tool.name.localeCompare(b.tool.name))
      .slice(0, 5)
      .map((entry) => entry.tool);

    // 真实展开一次（不是估算）：用候选最多的探针问题，确保拿到 5 个
    await onDemandClient.callTool({
      name: 'hub_find_sources',
      arguments: { question: '小麦 基因 表达 变异 同源', species_hint: '小麦' },
    });
    const afterFind = (await onDemandClient.listTools()).tools;

    const result = {
      method: 'MCP tools/list 返回对象（{"tools":[...]}）的 cl100k_base token 数；gpt-tokenizer@2.9.0 实测',
      tokenizer: 'gpt-tokenizer@2.9.0 (cl100k_base)',
      build: build.status === 0 ? build.stdout.trim() : null,
      measuredAt: new Date().toISOString(),
      defaultTwo: tokensOfTools(metaTools),
      worstFive: tokensOfTools([...metaTools, ...worstFive]),
      catalogAll: tokensOfTools(catalog),
      actualAfterFind: tokensOfTools(afterFind),
    };
    result.savedVsCatalog = {
      defaultTwoTokens: result.catalogAll.tokens - result.defaultTwo.tokens,
      worstFiveTokens: result.catalogAll.tokens - result.worstFive.tokens,
    };

    if (AS_JSON) {
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    } else {
      const line = (label, entry) => `  ${label}: ${entry.count} 个工具 → ${entry.tokens} token`;
      process.stdout.write(`${result.method}\n`);
      process.stdout.write(`${line('默认会话（2 元工具）', result.defaultTwo)}\n`);
      process.stdout.write(`${line('最坏展开（2 + 最长 5）', result.worstFive)}\n`);
      process.stdout.write(`${line('目录全量', result.catalogAll)}\n`);
      process.stdout.write(`${line('真实 find 之后', result.actualAfterFind)}\n`);
      process.stdout.write(`  最坏 5: ${result.worstFive.names.filter((name) => !name.startsWith('hub_')).join(', ')}\n`);
    }
    // 判据自检：默认必须比目录便宜；最坏 5 个必须真的是 7 条
    if (result.defaultTwo.tokens >= result.catalogAll.tokens) {
      throw new Error('默认 2 个元工具的 payload 不小于目录全量，测量口径有问题');
    }
    if (result.worstFive.count !== 7) throw new Error(`最坏展开应为 7 条，实测 ${result.worstFive.count}`);
  } finally {
    await onDemandClient.close().catch(() => {});
    await staticClient.close().catch(() => {});
    await onDemandService.close().catch(() => {});
    await staticService.close().catch(() => {});
  }
}

main().catch((error) => {
  process.stderr.write(`❌ token 实测失败：${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
