#!/usr/bin/env node
/**
 * `plant-omics-mcp` —— MCP 的 stdio 入口。
 *
 * 铁律：**stdout 只许走 MCP 协议帧**。任何一行调试输出落到 stdout 都会
 * 让客户端解析失败，且现象是「连上了但一个工具都没有」，极难查。
 * 所以这里的日志一律走 stderr。
 *
 * 2026-11-13：stdio 与 HTTP 走同一套按需展开语义——进程就是一个会话，
 * 默认只下发 2 个元工具，`hub_find_sources` 展开后发 `list_changed`（stdio 上就是本连接）。
 * 显式订阅 `PLANTOMICS_SOURCES` 或 `PLANTOMICS_ON_DEMAND=0` 时回到静态工具集。
 */

import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

async function main(): Promise<void> {
  // 刻意用动态 import：源的装配（含 PLANTOMICS_SOURCES 的 id 校验）发生在**导入期**，
  // 若用静态 import，配错一个源 id 就会变成「未捕获异常 + 一屏堆栈」，
  // 而用户真正需要看到的只有一句「未知的源 id：xxx，可用的是 yyy」。
  const [{ createMcpServer }, { registry, enabledSourcesFromEnv }, { onDemandEnabled, readOnDemandConfig }, { OnDemandToolset }] = await Promise.all([
    import('./server.js'),
    import('../sources/index.js'),
    import('../on-demand/config.js'),
    import('../on-demand/session.js'),
  ]);

  /**
   * 显式订阅是**退路**：用户点名了源，就该拿到那些源的全部工具（静态），
   * 不该再被按需展开改写——否则"显式订阅"与"默认会话"两种语义会打架。
   */
  const explicitSubset = enabledSourcesFromEnv() !== undefined;
  const onDemand = onDemandEnabled() && !explicitSubset;

  let tools: number;
  if (onDemand) {
    const config = readOnDemandConfig();
    const session = new OnDemandToolset(registry, { config });
    const server = createMcpServer(session, { listChanged: true });
    if (config.notify) {
      session.setOnToolsChanged(() => {
        // 通知失败不该带走进程：连接已断时客户端反正也收不到
        void server.sendToolListChanged().catch(() => {});
      });
    }
    await server.connect(new StdioServerTransport());
    tools = session.listTools().length;
    process.stderr.write(
      `[plant-omics] 按需展开已启用：默认 ${tools} 个元工具｜每次最多展开 ${config.perCallMax} 个`
        + `｜会话累计硬上限 ${config.hardMax} / 软建议 ${config.softMax}\n`,
    );
  } else {
    const server = createMcpServer(registry);
    await server.connect(new StdioServerTransport());
    tools = registry.listTools().length;
    process.stderr.write(`[plant-omics] 静态工具集：${tools} 个工具（${explicitSubset ? '显式订阅' : 'PLANTOMICS_ON_DEMAND=0'}）\n`);
  }

  const sources = registry.listSources().map((bundle) => bundle.manifest.id).join(', ') || '(无)';
  process.stderr.write(
    `[plant-omics] MCP server ready｜工具 ${tools} 个｜源：${sources}\n`,
  );
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`[plant-omics] 启动失败：${message}\n`);
  if (!(error instanceof Error) || error.name !== 'PlantOmicsError') {
    // 不是我们自己的配置错误，才附堆栈——否则堆栈只会淹没那句关键提示
    process.stderr.write(`[plant-omics] 原始错误：${error instanceof Error ? error.stack ?? '' : String(error)}\n`);
  }
  process.exitCode = 1;
});
