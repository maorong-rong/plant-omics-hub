import { afterEach, describe, expect, it } from 'vitest';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { ToolListChangedNotificationSchema } from '@modelcontextprotocol/sdk/types.js';

import type { OnDemandConfig } from '../src/on-demand/config.js';
import { parseServiceConfig } from '../src/service/config.js';
import { createService, type RunningService } from '../src/service/http.js';
import { registry } from '../src/sources/index.js';

/**
 * HTTP 会话态 + 按需展开的**协议级**测试（A1/A2/A3-协议侧/A5）。
 *
 * 真实宿主（DSH + 模型）那一半在 `scripts/e2e-dsh-on-demand.mjs`：
 * 这里证明"服务端把话说清楚了"，那里证明"宿主真的听懂了"。
 */

const running: RunningService[] = [];
const clients: Client[] = [];

const ON_DEMAND: OnDemandConfig = {
  enabled: true,
  notify: true,
  perCallMax: 5,
  softMax: 40,
  hardMax: 80,
  sessionTtlMs: 30 * 60 * 1000,
  sessionMax: 64,
};

afterEach(async () => {
  for (const client of clients.splice(0)) await client.close().catch(() => {});
  for (const service of running.splice(0)) await service.close().catch(() => {});
});

async function start(overrides: Partial<OnDemandConfig> = {}): Promise<RunningService> {
  const config = parseServiceConfig({
    PLANTOMICS_HUB_HOST: '127.0.0.1',
    PLANTOMICS_HUB_PORT: '0',
    PLANTOMICS_HUB_TOKEN: '',
    PLANTOMICS_HUB_LOG: 'quiet',
  } as NodeJS.ProcessEnv);
  const instance = await createService({
    registry,
    config,
    logger: () => {},
    onDemand: { ...ON_DEMAND, ...overrides },
  }).start();
  running.push(instance);
  return instance;
}

async function connect(service: RunningService): Promise<{ client: Client; transport: StreamableHTTPClientTransport }> {
  const transport = new StreamableHTTPClientTransport(new URL(service.url));
  const client = new Client({ name: 'on-demand-http', version: '0.0.0' }, { capabilities: {} });
  clients.push(client);
  await client.connect(transport);
  return { client, transport };
}

async function waitFor(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) throw new Error(`等待条件超时（${timeoutMs} ms）`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

function textOf(result: { content?: Array<{ type: string; text?: string }> }): string {
  return (result.content ?? []).map((entry) => entry.text ?? '').join('\n');
}

describe('HTTP 会话态：签发 / 复用 / 404 / DELETE', () => {
  it('initialize 签发 mcp-session-id；后续请求复用同一会话', async () => {
    const service = await start();
    const { client, transport } = await connect(service);
    expect(transport.sessionId).toBeTruthy();

    expect((await client.listTools()).tools).toHaveLength(2);
    expect((await client.listTools()).tools).toHaveLength(2);
    expect(transport.sessionId).toBeTruthy();
  });

  it('没有会话 id 的非 initialize POST → 400；未知会话 id → 404', async () => {
    const service = await start();

    const noSession = await fetch(service.url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    });
    expect(noSession.status).toBe(400);

    const unknown = await fetch(service.url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        'mcp-session-id': 'nope',
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    });
    expect(unknown.status).toBe(404);
    const payload = (await unknown.json()) as { error?: { code?: number } };
    expect(payload.error?.code).toBe(-32001);
  });

  it('DELETE 结束会话；之后旧 id 一律 404', async () => {
    const service = await start();
    const { client, transport } = await connect(service);
    const sessionId = transport.sessionId!;
    await client.close();

    const deleted = await fetch(service.url, {
      method: 'DELETE',
      headers: { 'mcp-session-id': sessionId },
    });
    expect([200, 204]).toContain(deleted.status);

    const afterDelete = await fetch(service.url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        'mcp-session-id': sessionId,
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    });
    expect(afterDelete.status).toBe(404);
  });

  it('TTL 过期：旧的 mcp-session-id 返回 404', async () => {
    const service = await start({ sessionTtlMs: 200, sessionMax: 8 });
    const { transport } = await connect(service);
    const sessionId = transport.sessionId!;
    await new Promise((resolve) => setTimeout(resolve, 450));

    const response = await fetch(service.url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        'mcp-session-id': sessionId,
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    });
    expect(response.status).toBe(404);
  });

  it('会话数上限：驱逐最久未用者，进程不崩', async () => {
    const service = await start({ sessionMax: 2 });
    const first = await connect(service);
    const firstId = first.transport.sessionId!;
    await new Promise((resolve) => setTimeout(resolve, 20));
    await connect(service);
    await new Promise((resolve) => setTimeout(resolve, 20));
    await connect(service);

    const response = await fetch(service.url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        'mcp-session-id': firstId,
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    });
    expect(response.status).toBe(404);

    // 新会话仍可用（驱逐不是"拒绝新连接"）
    const fresh = await connect(service);
    expect((await fresh.client.listTools()).tools).toHaveLength(2);
  });
});

describe('HTTP 按需展开：通知 + 重拉 + 新工具可调用', () => {
  it('find 后收到 list_changed，重拉得到 2+N，新工具可被派发', async () => {
    const service = await start();
    const { client } = await connect(service);
    expect((await client.listTools()).tools).toHaveLength(2);

    let notifications = 0;
    client.setNotificationHandler(ToolListChangedNotificationSchema, () => {
      notifications += 1;
    });
    // 打开 GET SSE 需要一点时间；等它建立再触发展开，否则通知会发在空处
    await new Promise((resolve) => setTimeout(resolve, 150));

    const found = await client.callTool({
      name: 'hub_find_sources',
      arguments: { question: '小麦 春化 已知基因', species_hint: '小麦' },
    });
    expect(found.isError).toBeFalsy();
    await waitFor(() => notifications > 0);

    const tools = (await client.listTools()).tools.map((tool) => tool.name);
    // 该问题实测 2 个业务候选：「top 3–5」是每次上限，不是结果下限
    expect(tools.length).toBeGreaterThanOrEqual(3);
    expect(tools.length).toBeLessThanOrEqual(7);
    expect(tools).toContain('hub_find_sources');
    expect(tools).toContain('hub_status');

    // 新工具至少有一个能进到工具层（离线环境会因上游失败，但不能是"未知工具"）
    const newTool = tools.find((name) => !name.startsWith('hub_'))!;
    const called = await client.callTool({ name: newTool, arguments: {} });
    expect(textOf(called)).not.toContain('未知工具');
  });

  it('两个并发会话不共享工具集', async () => {
    const service = await start();
    const a = await connect(service);
    const b = await connect(service);
    await new Promise((resolve) => setTimeout(resolve, 150));

    await a.client.callTool({
      name: 'hub_find_sources',
      arguments: { question: '小麦 春化 已知基因', species_hint: '小麦' },
    });
    expect((await a.client.listTools()).tools.length).toBeGreaterThan(2);
    expect((await b.client.listTools()).tools).toHaveLength(2);
  });

  it('对照组（不发通知）：工具集不增长，客户端永远看不到新工具', async () => {
    const service = await start({ notify: false });
    const { client } = await connect(service);
    let notifications = 0;
    client.setNotificationHandler(ToolListChangedNotificationSchema, () => {
      notifications += 1;
    });
    await new Promise((resolve) => setTimeout(resolve, 150));

    await client.callTool({
      name: 'hub_find_sources',
      arguments: { question: '小麦 春化 已知基因', species_hint: '小麦' },
    });
    await new Promise((resolve) => setTimeout(resolve, 200));
    // 关键判据：一条通知都没有。宿主不重拉，所以模型当轮手里仍是那 2 个元工具；
    // 这里显式 listTools 才能看到服务端其实已经装进去了——"装了"与"客户端知道"是两件事。
    expect(notifications).toBe(0);
    expect((await client.listTools()).tools.length).toBeGreaterThan(2);
  });
});
