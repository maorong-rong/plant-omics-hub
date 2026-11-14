/**
 * 按需展开的**证据日志**（可选，默认关闭）。
 *
 * 为什么要它在产品代码里而不是测试脚本里：验收要回答的是"服务端到底看到了什么"——
 * 哪次 initialize 开了哪个会话、`tools/list` 返回了几个名字、`hub_find_sources`
 * 展开了什么、通知有没有真的发出。这些事实只有服务端自己知道；让验收脚本从
 * 访问日志反推，等于再写一套解析器（而且访问日志刻意不记参数值）。
 *
 * 约束：
 *   - **默认关闭**：只有 `PLANTOMICS_EVIDENCE_LOG` 指向文件时才写；
 *   - 只记**工具名、数量、事件**，不记参数值、不记上游返回正文；
 *   - 写失败不让服务挂：证据是旁路，不是业务依赖；
 *   - 一行一个 JSON，便于 `jq`/脚本逐条判定。
 */

import { appendFileSync } from 'node:fs';

export const EVIDENCE_LOG_ENV = 'PLANTOMICS_EVIDENCE_LOG';

export type EvidenceEvent = Record<string, unknown>;

export type EvidenceLogger = (event: EvidenceEvent) => void;

export function readEvidenceLogger(env: NodeJS.ProcessEnv = process.env): EvidenceLogger | undefined {
  const file = (env[EVIDENCE_LOG_ENV] ?? '').trim();
  if (file === '') return undefined;
  return (event) => {
    try {
      appendFileSync(file, `${JSON.stringify({ at: new Date().toISOString(), ...event })}\n`, { mode: 0o600 });
    } catch {
      // 证据是旁路：写不进去（磁盘满/权限）不该影响正在服务的请求
    }
  };
}
