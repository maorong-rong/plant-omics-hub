/**
 * 按需展开（on-demand expansion）的运行时配置。
 *
 * 目标形态（见 docs/架构-按需展开-2026-11-08.md 与 docs/architecture/按需展开-2026-11-13/）：
 * 会话初始只下发 2 个元工具；`hub_find_sources` 选中候选后，把业务工具装进**本会话**
 * 的注册表并发 `notifications/tools/list_changed`；客户端重拉后模型当轮即可调用。
 *
 * 全是环境变量，因为这是**运行时开关**而不是构建期开关：
 *   - `PLANTOMICS_ON_DEMAND=0`  回滚到切换前的静态全量（49 工具），读数与切换前一致；
 *   - `PLANTOMICS_ON_DEMAND_NOTIFY=0` 只用于**负向对照**（不发通知），不是产品开关；
 *   - 三个上限与两个会话参数默认值来自既有常量（80/40）或本单设计（5 / 30 min / 64），
 *     验收时用环境变量压低以复现「超上限」分支——默认值本身就是判据的一部分。
 *
 * 解析失败**抛错**而不是静默回落：一个拼错的数字会让人以为"上限生效了"，实际是默认值。
 */

import { DEFAULT_SET_TOOLS_SOFT_MAX, SUBSET_TOOLS_HARD_MAX } from '../service/budget.js';

export const ON_DEMAND_ENV = 'PLANTOMICS_ON_DEMAND';
export const ON_DEMAND_NOTIFY_ENV = 'PLANTOMICS_ON_DEMAND_NOTIFY';
export const EXPAND_PER_CALL_ENV = 'PLANTOMICS_EXPAND_PER_CALL';
export const EXPAND_HARD_MAX_ENV = 'PLANTOMICS_EXPAND_HARD_MAX';
export const EXPAND_SOFT_MAX_ENV = 'PLANTOMICS_EXPAND_SOFT_MAX';
export const SESSION_TTL_ENV = 'PLANTOMICS_SESSION_TTL_MS';
export const SESSION_MAX_ENV = 'PLANTOMICS_SESSION_MAX';

/** 每次 `hub_find_sources` 最多展开几个业务工具（top 3–5 的硬顶）。 */
export const DEFAULT_EXPAND_PER_CALL_MAX = 5;
/** 会话累计展开硬上限：与「单次订阅集 ≤ 80」共用同一个既有常量，不再造第二个 80。 */
export const DEFAULT_SESSION_EXPAND_HARD_MAX = SUBSET_TOOLS_HARD_MAX;
/** 会话累计展开软建议：与既有默认集软建议同一个常量。 */
export const DEFAULT_SESSION_EXPAND_SOFT_MAX = DEFAULT_SET_TOOLS_SOFT_MAX;
/** 会话空闲 TTL：30 分钟。过期后旧 Mcp-Session-Id 一律 404（MCP 规范语义）。 */
export const DEFAULT_SESSION_TTL_MS = 30 * 60 * 1000;
/** 同时存在的会话数上限；满了按最近最少使用驱逐（不是拒绝新会话——拒绝会让用户莫名连不上）。 */
export const DEFAULT_SESSION_MAX = 64;

export interface OnDemandConfig {
  /** 总开关；false = 切换前的静态全量行为 */
  readonly enabled: boolean;
  /** 展开后是否真的发 `notifications/tools/list_changed`（负向对照用 0 关闭） */
  readonly notify: boolean;
  readonly perCallMax: number;
  readonly softMax: number;
  readonly hardMax: number;
  readonly sessionTtlMs: number;
  readonly sessionMax: number;
}

/**
 * 读一个正整数环境变量。
 *
 * `undefined` / 空串 → 默认值；其余非法值（0、负数、小数、单词）→ 抛错。
 * 这条约束是刻意的：上限类参数静默回落，等于让"我以为限制了"变成假的。
 */
function readPositiveInt(env: NodeJS.ProcessEnv, name: string, fallback: number): number {
  const raw = env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  const text = raw.trim();
  if (!/^\d+$/.test(text)) {
    throw new Error(`${name}=${JSON.stringify(raw)} 不是正整数；按需展开的上限参数不接受模糊值`);
  }
  const value = Number(text);
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${name}=${JSON.stringify(raw)} 必须是正整数（收到 ${value}）`);
  }
  return value;
}

/** 读 `PLANTOMICS_ON_DEMAND`：只有显式 `0`/`false`/`off`/`no`（不区分大小写）才关闭。 */
export function onDemandEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = (env[ON_DEMAND_ENV] ?? '').trim().toLowerCase();
  return !(raw === '0' || raw === 'false' || raw === 'off' || raw === 'no');
}

export function readOnDemandConfig(env: NodeJS.ProcessEnv = process.env): OnDemandConfig {
  const enabled = onDemandEnabled(env);
  const notifyRaw = (env[ON_DEMAND_NOTIFY_ENV] ?? '').trim().toLowerCase();
  const notify = !(notifyRaw === '0' || notifyRaw === 'false' || notifyRaw === 'off' || notifyRaw === 'no');
  const perCallMax = readPositiveInt(env, EXPAND_PER_CALL_ENV, DEFAULT_EXPAND_PER_CALL_MAX);
  const softMax = readPositiveInt(env, EXPAND_SOFT_MAX_ENV, DEFAULT_SESSION_EXPAND_SOFT_MAX);
  const hardMax = readPositiveInt(env, EXPAND_HARD_MAX_ENV, DEFAULT_SESSION_EXPAND_HARD_MAX);
  if (hardMax < 1) throw new Error(`会话展开硬上限必须 ≥ 1（收到 ${hardMax}）`);
  return {
    enabled,
    notify,
    perCallMax,
    softMax,
    hardMax,
    sessionTtlMs: readPositiveInt(env, SESSION_TTL_ENV, DEFAULT_SESSION_TTL_MS),
    sessionMax: readPositiveInt(env, SESSION_MAX_ENV, DEFAULT_SESSION_MAX),
  };
}
