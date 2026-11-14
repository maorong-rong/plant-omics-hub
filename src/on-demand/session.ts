/**
 * 按需展开的**会话工具集**：一个会话一份，负责「装了什么、能不能调、什么时候发通知」。
 *
 * 为什么单独一个模块：
 *   - `src/core/registry.ts` 的语义是**创建后不可变**（`seal()`），那条规则不能为了
 *     "会话中途加工具"而破——破了就要再定一套失效规则，而那套规则自己会出错。
 *     所以会话不改进程级注册表，而是持有一份**已加载工具名集合**，`tools/list` 按它过滤。
 *   - HTTP 与 stdio 两个出口共用同一个实现：stdio 的一个进程就是一个会话，
 *     HTTP 的每个 `Mcp-Session-Id` 各一个会话。同一件事只有一套语义。
 *
 * 不变量（单测与验收都按这几条判）：
 *   1. 初始 `listTools()` 只有元工具（2 个），不碰注册表的不可变语义；
 *   2. 展开只加业务工具、只加一次；重复 find 不重复计数、不发多余通知；
 *   3. 每次最多 `perCallMax` 个；会话累计到 `hardMax` 就拒绝，并在结果里说明原因；
 *   4. 超过 `softMax` 只警示、不拒绝；
 *   5. 两个会话实例之间**没有任何共享可变状态**（工具集不串）。
 */

import type { ToolRegistry } from '../core/registry.js';
import type { ToolDefinition } from '../core/types.js';
import { createHubTools, type HubSessionOptions } from '../retrieval/index.js';
import type { ExpansionOutcome, ExpansionSession } from '../retrieval/find-sources.js';
import type { StatusSessionView } from '../retrieval/status.js';
import type { OnDemandConfig } from './config.js';

/** MCP 出口只需要这两件事：列工具、按名字取工具。`ToolRegistry` 天然满足。 */
export interface Toolset {
  listTools(): ToolDefinition[];
  getTool(name: string): ToolDefinition | undefined;
}

/** 通知回调：真的要把 `notifications/tools/list_changed` 发到当前连接上。 */
export type ToolsChangedHandler = (added: readonly string[]) => void;

export interface OnDemandToolsetOptions {
  readonly config: OnDemandConfig;
  /** 服务端版本串；测试可注入固定值 */
  readonly version?: string;
  /** 每次展开结算后的观察回调（证据日志/测试用；不改变返回语义） */
  readonly onExpand?: (outcome: ExpansionOutcome) => void;
}

export class OnDemandToolset implements Toolset, ExpansionSession {
  readonly #registry: ToolRegistry;
  readonly #config: OnDemandConfig;
  readonly #version: string | undefined;
  /** 目录里全部业务工具（源工具，按注册顺序），会话可从中展开 */
  readonly #businessTools: readonly ToolDefinition[];
  readonly #businessNames: ReadonlySet<string>;
  /** 本会话已加载的业务工具名 */
  readonly #loaded = new Set<string>();
  #expandedTotal = 0;
  #onToolsChanged: ToolsChangedHandler | undefined;
  readonly #metaTools: ToolDefinition[];
  readonly #onExpand: ((outcome: ExpansionOutcome) => void) | undefined;

  constructor(registry: ToolRegistry, options: OnDemandToolsetOptions) {
    this.#registry = registry;
    this.#config = options.config;
    this.#version = options.version;
    this.#onExpand = options.onExpand;
    this.#businessTools = registry.listSources().flatMap((bundle) => bundle.tools);
    this.#businessNames = new Set(this.#businessTools.map((tool) => tool.name));

    // 会话视图先于元工具构造；getter 读的是本实例的实时状态，不在构造期定格数字。
    const session: HubSessionOptions = {
      expansion: {
        loadedTools: () => [...this.#loaded],
        request: (names) => this.request(names),
      },
      status: this.statusView(),
    };
    this.#metaTools = createHubTools(registry, this.#version, session);
  }

  /** 绑定"工具集变了"的通道；由出口在创建 Server 之后调用。 */
  setOnToolsChanged(handler: ToolsChangedHandler | undefined): void {
    this.#onToolsChanged = handler;
  }

  get config(): OnDemandConfig {
    return this.#config;
  }

  /** 本会话已加载的业务工具名（按加载顺序不保证；消费方按需排序） */
  loadedTools(): readonly string[] {
    return [...this.#loaded];
  }

  /** 本会话累计展开次数（每次都只计**新装**的工具数） */
  get expandedTotal(): number {
    return this.#expandedTotal;
  }

  statusView(): StatusSessionView {
    const self = this;
    return {
      onDemand: true,
      catalogTools: this.#registry.listTools().length,
      defaultTools: this.#registry.listMetaTools().length,
      get loadedBusinessTools() {
        return [...self.#loaded];
      },
      get expandedTotal() {
        return self.#expandedTotal;
      },
      perCallMax: this.#config.perCallMax,
      softMax: this.#config.softMax,
      hardMax: this.#config.hardMax,
    };
  }

  /**
   * 把候选业务工具装进本会话。
   *
   * `names` 是**优先级顺序**（检索层按命中维度排好）；本方法负责去重、过滤未知/元工具、
   * 按每次上限与累计硬上限截断，并只在真的加进去之后才发一次通知。
   */
  request(names: readonly string[]): ExpansionOutcome {
    const alreadyLoaded: string[] = [];
    const candidates: string[] = [];
    const unknown: string[] = [];
    const seen = new Set<string>();
    for (const name of names) {
      if (seen.has(name)) continue;
      seen.add(name);
      if (!this.#businessNames.has(name)) {
        // 元工具永远不经展开获得；目录里没有的名字也不许进会话（否则 tools/list 会指一个调不动的工具）
        unknown.push(name);
        continue;
      }
      if (this.#loaded.has(name)) alreadyLoaded.push(name);
      else candidates.push(name);
    }

    const capacity = Math.max(0, this.#config.hardMax - this.#loaded.size);
    if (candidates.length > 0 && capacity === 0) {
      return {
        added: [],
        alreadyLoaded,
        rejected: candidates,
        reason: 'hard-limit',
        perCallMax: this.#config.perCallMax,
        hardMax: this.#config.hardMax,
        softMax: this.#config.softMax,
        totalLoadedBusiness: this.#loaded.size,
        softExceeded: this.#loaded.size > this.#config.softMax,
        hardReached: true,
      };
    }

    const take = candidates.slice(0, Math.min(this.#config.perCallMax, capacity));
    const rejected = [...candidates.slice(take.length), ...unknown];
    for (const name of take) this.#loaded.add(name);
    this.#expandedTotal += take.length;
    if (take.length > 0) this.#onToolsChanged?.(take);

    const totalLoadedBusiness = this.#loaded.size;
    const outcome: ExpansionOutcome = {
      added: take,
      alreadyLoaded,
      rejected,
      // 硬上限在函数开头已单独返回；走到这里说明还有容量，唯一可能的异常是目录外的工具名
      ...(unknown.length > 0 ? { reason: 'unknown-tool' as const } : {}),
      perCallMax: this.#config.perCallMax,
      hardMax: this.#config.hardMax,
      softMax: this.#config.softMax,
      totalLoadedBusiness,
      softExceeded: totalLoadedBusiness > this.#config.softMax,
      hardReached: totalLoadedBusiness >= this.#config.hardMax,
    };
    this.#onExpand?.(outcome);
    return outcome;
  }

  /** 元工具在前（顺序即 `hub_find_sources`、`hub_status`），已展开业务工具在后（注册表顺序）。 */
  listTools(): ToolDefinition[] {
    return [
      ...this.#metaTools,
      ...this.#businessTools.filter((tool) => this.#loaded.has(tool.name)),
    ];
  }

  getTool(name: string): ToolDefinition | undefined {
    const meta = this.#metaTools.find((tool) => tool.name === name);
    if (meta) return meta;
    if (!this.#loaded.has(name)) return undefined;
    return this.#businessTools.find((tool) => tool.name === name);
  }
}
