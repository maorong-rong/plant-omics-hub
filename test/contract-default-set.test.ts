import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { CallToolResult, TextContent } from '@modelcontextprotocol/sdk/types.js';
import { afterEach, describe, expect, it } from 'vitest';

import { createMcpServer } from '../src/mcp/server.js';
import { OnDemandToolset } from '../src/on-demand/session.js';
import { readOnDemandConfig } from '../src/on-demand/config.js';
import { DEFAULT_SET_SOURCES } from '../src/service/budget.js';
import { buildCatalog } from '../src/service/catalog.js';
import { parseServiceConfig } from '../src/service/config.js';
import { createService, type RunningService } from '../src/service/http.js';
import { registry } from '../src/sources/index.js';

/**
 * 默认集契约的离线测试（stdio / HTTP 各一次）。
 *
 * 2026-11-13 起契约的**同一个数**是「默认会话实际下发数」：
 *   - 按需展开开启（产品默认）：`tools/list` = 2 == `/catalog.budget.defaultSetTools`
 *     == `hub_status` 正文「默认下发：N 个工具」；
 *   - 回滚（`PLANTOMICS_ON_DEMAND=0`）：三处都 = 49。
 * 目录规模（49）由 `budget.catalogTools` 单独报，可展开数由 `budget.expandableTools` 报。
 *
 * 刻意不 import `defaultSetToolCount` 来和 `/catalog` 自比：三个读数分别走三条
 * 运行时路径（协议 / HTTP 字段 / 文本正文），任何一处另写一份数字都会让这条红。
 */

const EXPECTED_ON_DEMAND_TOOLS = 2;
const EXPECTED_CATALOG_TOOLS = 49;

const running: RunningService[] = [];
const clients: Client[] = [];

afterEach(async () => {
  for (const client of clients.splice(0)) await client.close().catch(() => {});
  for (const service of running.splice(0)) await service.close().catch(() => {});
});

function textOf(result: CallToolResult): string {
  return (result.content ?? [])
    .filter((entry): entry is TextContent => entry.type === 'text')
    .map((entry) => entry.text)
    .join('\n');
}

/** 与 `scripts/status-report.mjs` 同一段正文口径：只认「默认下发：N 个工具」。 */
function defaultSetFromStatus(text: string): number {
  const match = /默认下发：\s*(\d+)\s*个工具/.exec(text);
  if (!match) throw new Error('hub_status 正文里找不到「默认下发：N 个工具」');
  return Number(match[1]);
}

function staticConfig() {
  return {
    enabled: false,
    notify: true,
    perCallMax: 5,
    softMax: 40,
    hardMax: 80,
    sessionTtlMs: 1_800_000,
    sessionMax: 64,
  } as const;
}

async function stdioReadings(onDemand: boolean): Promise<{ toolsList: number; hubStatus: number }> {
  const toolset = onDemand
    ? new OnDemandToolset(registry, { config: readOnDemandConfig({}) })
    : registry;
  const server = createMcpServer(toolset, onDemand ? { listChanged: true } : {});
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'contract-default-set-stdio', version: '0.0.0' });
  clients.push(client);
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  try {
    const tools = (await client.listTools()).tools;
    const status = await client.callTool({ name: 'hub_status', arguments: {} });
    expect(status.isError).toBeFalsy();
    return { toolsList: tools.length, hubStatus: defaultSetFromStatus(textOf(status)) };
  } finally {
    await client.close().catch(() => {});
    await server.close().catch(() => {});
  }
}

async function httpReadings(onDemand: boolean) {
  const config = parseServiceConfig({
    PLANTOMICS_HUB_HOST: '127.0.0.1',
    PLANTOMICS_HUB_PORT: '0',
    PLANTOMICS_HUB_TOKEN: '',
    PLANTOMICS_HUB_LOG: 'quiet',
  } as NodeJS.ProcessEnv);
  const service = await createService({
    registry,
    config,
    logger: () => {},
    onDemand: onDemand ? readOnDemandConfig({}) : staticConfig(),
  }).start();
  running.push(service);

  const response = await fetch(new URL('/catalog', service.url));
  expect(response.status).toBe(200);
  const catalog = (await response.json()) as {
    budget: { defaultSetTools: number; catalogTools: number; expandableTools: number; onDemand: boolean };
  };

  const client = new Client({ name: 'contract-default-set-http', version: '0.0.0' });
  clients.push(client);
  await client.connect(new StreamableHTTPClientTransport(new URL(service.url)));
  const tools = (await client.listTools()).tools;
  const status = await client.callTool({ name: 'hub_status', arguments: {} });
  expect(status.isError).toBeFalsy();
  return { catalog, toolsList: tools.length, hubStatus: defaultSetFromStatus(textOf(status)) };
}

describe('默认集契约：三处读数必须相同', () => {
  it('DEFAULT_SET_SOURCES 是回滚模式的默认清单，覆盖全部已登记源', () => {
    expect(new Set(DEFAULT_SET_SOURCES)).toEqual(
      new Set(registry.listSources().map((bundle) => bundle.manifest.id)),
    );
  });

  it('stdio（按需展开）：tools/list == /catalog.defaultSetTools == hub_status == 2', async () => {
    const catalog = buildCatalog(registry, { version: '0.1.1+svc.test' });
    const stdio = await stdioReadings(true);

    expect(stdio.toolsList).toBe(EXPECTED_ON_DEMAND_TOOLS);
    expect(catalog.budget.defaultSetTools).toBe(stdio.toolsList);
    expect(catalog.budget.catalogTools).toBe(EXPECTED_CATALOG_TOOLS);
    expect(catalog.budget.expandableTools).toBe(EXPECTED_CATALOG_TOOLS - EXPECTED_ON_DEMAND_TOOLS);
    expect(stdio.hubStatus).toBe(stdio.toolsList);
  });

  it('HTTP（按需展开）：tools/list == /catalog.defaultSetTools == hub_status == 2', async () => {
    const readings = await httpReadings(true);
    expect(readings.toolsList).toBe(EXPECTED_ON_DEMAND_TOOLS);
    expect(readings.catalog.budget.defaultSetTools).toBe(readings.toolsList);
    expect(readings.catalog.budget.catalogTools).toBe(EXPECTED_CATALOG_TOOLS);
    expect(readings.catalog.budget.expandableTools).toBe(EXPECTED_CATALOG_TOOLS - EXPECTED_ON_DEMAND_TOOLS);
    expect(readings.catalog.budget.onDemand).toBe(true);
    expect(readings.hubStatus).toBe(readings.toolsList);
  });

  it('回滚（PLANTOMICS_ON_DEMAND=0）：三处读数都回到 49', async () => {
    const catalog = buildCatalog(registry, { version: '0.1.1+svc.test', onDemand: staticConfig() });
    const stdio = await stdioReadings(false);
    expect(stdio.toolsList).toBe(EXPECTED_CATALOG_TOOLS);
    expect(catalog.budget.defaultSetTools).toBe(EXPECTED_CATALOG_TOOLS);
    expect(catalog.budget.expandableTools).toBe(0);
    expect(catalog.budget.onDemand).toBe(false);
    expect(stdio.hubStatus).toBe(EXPECTED_CATALOG_TOOLS);

    const http = await httpReadings(false);
    expect(http.toolsList).toBe(EXPECTED_CATALOG_TOOLS);
    expect(http.catalog.budget.defaultSetTools).toBe(EXPECTED_CATALOG_TOOLS);
    expect(http.catalog.budget.expandableTools).toBe(0);
    expect(http.hubStatus).toBe(EXPECTED_CATALOG_TOOLS);
  });
});
