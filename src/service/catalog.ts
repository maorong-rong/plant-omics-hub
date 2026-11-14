/**
 * `GET /catalog` 的响应构造（契约见 `docs/catalog契约.md`，2026-11-01 v1）。
 *
 * 定位：**市场首屏与订阅集计数的唯一运行时数据源**。只读、免鉴权、不含凭据。
 * 为什么不能读 `site/data/catalog.json` 快照：那是构建期产物，源一改就得手动重建，
 * 市场页拿它算「选中的源 → 工具总数」会算错——而算错就是给用户装一个调不动的集合。
 *
 * 两条实现纪律（契约 §四）：
 * 1. **工具集合逐一相等**：`union(sources[].tools) ∪ metaTools` 必须等于 `tools/list` 全集。
 *    元工具只计入 `totals.metaTools`，不塞进任何 `sources[]` 里凑数。
 * 2. **阈值只有一个来源**：直接取 `budget.ts` 的常量，**这里不许出现字面量 80 / 40**。
 *    否则下一次改规则又要改两处，而两处必然漂。
 */

import type { SourceBundle, ToolDefinition } from '../core/types.js';
import type { ToolRegistry } from '../core/registry.js';
import { applyPinnedOrder, loadPinnedSources, type PinnedSources } from '../core/pinned.js';
import { DEFAULT_SET_SOURCES, DEFAULT_SET_TOOLS_SOFT_MAX, SUBSET_TOOLS_HARD_MAX, defaultSetToolCount } from './budget.js';
import {
  DEFAULT_EXPAND_PER_CALL_MAX,
  DEFAULT_SESSION_EXPAND_HARD_MAX,
  DEFAULT_SESSION_EXPAND_SOFT_MAX,
  type OnDemandConfig,
} from '../on-demand/config.js';
import { SERVICES_CATALOG, isCatalogServiceKey } from '../core/catalog-services.js';
import { speciesNameZh } from './species-names.js';

/** 实测折算：37 工具 ≈ 10,274 token，约 280 token/工具（契约 §三 固定口径）。 */
export const EST_TOKENS_PER_TOOL = 280;

/** 每源最多下发的盲区条数；总数另外用 `blindSpotsTotal` 报出，页面才能说「另有 N 条」。 */
export const MAX_BLIND_SPOTS = 5;

export interface CatalogSource {
  readonly id: string;
  readonly name: string;
  readonly tier: string;
  readonly toolCount: number;
  /**
   * 覆盖范围：**按物种拆成数组**，不是一个拼好的整串。
   *
   * 2026-11-02 前端实测：整串 `覆盖物种：A、B` 到了页面上只能整体当一块文本，
   * 「按作物画标签筛选」的意图落不了（第一个标签会带着「覆盖物种：」前缀）。
   * 取不到物种时返回 `['未登记覆盖范围']`——不编造、也不留空数组。
   */
  readonly coverage: string[];
  /** 盲区原文，最多 `MAX_BLIND_SPOTS` 条（manifest.caveats 的裁剪版，不改写）。 */
  readonly blindSpots: string[];
  /** 盲区原文总条数；页面对比 `blindSpots.length` 就能说清「另有几条」。 */
  readonly blindSpotsTotal: number;
  readonly tools: string[];
  readonly homepage: string;
  /** 大众称呼，格式「中文常用名（原名简称）」——页面主标题用这个 */
  readonly displayName: string;
  /** 该源能提供的研究服务（顶层字典的 key），manifest 显式声明、不推断 */
  readonly services: readonly string[];
  /** 中文物种名（呈现层翻译；真相仍是 manifest 的拉丁名） */
  readonly species: readonly string[];
  // status 缺省 = 未记录（ProbeRecord.status 是可选的）；缺失就不写，不编一个 0。
  readonly lastProbe?: { date: string; ok: boolean; status?: number; ms?: number };
}

export interface CatalogResponse {
  readonly version: string;
  readonly generatedAt: string;
  readonly totals: { sources: number; tools: number; metaTools: number };
  readonly budget: {
    /**
     * 默认会话**实际下发**的源 id：
     * - 按需展开开启时是空数组——默认只下发元工具，业务工具靠 `hub_find_sources` 展开；
     * - 回滚时是 `DEFAULT_SET_SOURCES`（切换前的默认清单）。
     *
     * 契约判据（页面复算）：`defaultSetTools` 必须等于
     * 「这些源的工具数之和 + totals.metaTools」，两种模式都成立。
     */
    defaultSources: readonly string[];
    /** 默认会话实际下发工具数：按需展开 = 元工具数（2）；回滚 = 目录默认集（49） */
    defaultSetTools: number;
    /** 目录全量工具数（= totals.tools）；不再与 defaultSetTools 混用 */
    catalogTools: number;
    /** 目录里还能按需展开的业务工具数 = catalogTools − defaultSetTools（回滚恒为 0） */
    expandableTools: number;
    /** 本服务当前是否处于按需展开模式 */
    onDemand: boolean;
    /** 每次 `hub_find_sources` 最多展开几个 */
    expandPerCallMax: number;
    /** 会话累计展开硬上限 / 软建议 */
    sessionExpandHardMax: number;
    sessionExpandSoftMax: number;
    defaultSetSoftMax: number;
    defaultSetOverSoftMax: boolean;
    subsetToolsHardMax: number;
    estTokensPerTool: number;
    subsetToolsHardMaxTokens: number;
  };
  /** 全局服务字典，**只有一份**；源只引用 key（契约 v1.2 §三.1 规则 1） */
  readonly servicesCatalog: readonly { key: string; label: string; hint: string }[];
  readonly sources: CatalogSource[];
}

/**
 * 该源能提供的研究服务：**只认 manifest 显式声明**，不从工具名推断（契约 v1.2 §三.1 规则 2）。
 *
 * 两条硬断言在这里就抛：空数组、以及引用了字典里没有的 key。宁可启动失败，
 * 也不许把一个查不到的服务摆到页面上——那比不列更伤。
 */
function catalogServicesOf(bundle: SourceBundle): readonly string[] {
  const declared = bundle.manifest.services ?? [];
  if (declared.length === 0) {
    throw new Error(
      `源 ${bundle.manifest.id} 没有声明 services：在它的 manifest.ts 里列出真实能做的服务（`
        + `${SERVICES_CATALOG.map((entry) => entry.key).join(' / ')}），不许留空。`,
    );
  }
  const unknown = declared.filter((key) => !isCatalogServiceKey(key));
  if (unknown.length > 0) {
    throw new Error(
      `源 ${bundle.manifest.id} 声明了字典里没有的服务 key：${unknown.join(', ')}。`
        + `只能用 ${SERVICES_CATALOG.map((entry) => entry.key).join(' / ')}。`,
    );
  }
  return [...declared];
}

/**
 * 覆盖范围：按物种拆成标签数组。
 *
 * **不许为了"字段齐"编造**（契约 §五）：取不到就写「未登记覆盖范围」，返回单元素数组，
 * 既不编物种、也不返回空数组让页面自己猜。
 */
function coverageOf(bundle: SourceBundle): string[] {
  const species = bundle.manifest.species ?? [];
  if (species.length === 0) return ['未登记覆盖范围'];
  return [...species];
}

/**
 * 盲区：manifest.caveats 的裁剪版。
 *
 * 只裁剪、不改写、不合并（原文口径由源侧负责）；总数单独给，页面才能显示截断。
 */
function blindSpotsOf(bundle: SourceBundle): { blindSpots: string[]; blindSpotsTotal: number } {
  const caveats = bundle.manifest.caveats ?? [];
  return { blindSpots: caveats.slice(0, MAX_BLIND_SPOTS), blindSpotsTotal: caveats.length };
}

function probeOf(bundle: SourceBundle): CatalogSource['lastProbe'] {
  const probe = bundle.manifest.lastProbe;
  if (!probe) return undefined;
  return {
    date: probe.date,
    ok: probe.ok,
    ...(typeof probe.status === 'number' ? { status: probe.status } : {}),
    ...(typeof probe.ms === 'number' ? { ms: probe.ms } : {}),
  };
}

/**
 * 由**运行中注册表**生成 catalog。
 *
 * @param registry 服务端注册表（环境变量限定后的全集，不是本次请求的子集）
 * @param version  服务端版本，必须与 `/healthz` 的 `version` 同一个来源
 */
export function buildCatalog(
  registry: ToolRegistry,
  options: {
    version: string;
    now?: Date;
    pinnedSources?: PinnedSources;
    /**
     * 按需展开配置。不传 = **按需展开开启**（产品默认）；回滚演练的调用方必须显式传
     * `{ enabled: false }`，避免"忘了传"把回滚读数伪装成默认读数。
     */
    onDemand?: Pick<OnDemandConfig, 'enabled' | 'perCallMax' | 'hardMax' | 'softMax'>;
  },
): CatalogResponse {
  const bundles = registry.listSources();
  const tools: ToolDefinition[] = registry.listTools();
  const metaTools: ToolDefinition[] = registry.listMetaTools();
  const onDemand = options.onDemand ?? {
    enabled: true,
    perCallMax: DEFAULT_EXPAND_PER_CALL_MAX,
    hardMax: DEFAULT_SESSION_EXPAND_HARD_MAX,
    softMax: DEFAULT_SESSION_EXPAND_SOFT_MAX,
  };

  const sources: CatalogSource[] = bundles.map((bundle) => {
    const blind = blindSpotsOf(bundle);
    return {
      id: bundle.manifest.id,
      name: bundle.manifest.displayName,
      displayName: bundle.manifest.displayName,
      services: catalogServicesOf(bundle),
      species: bundle.manifest.species.map((latin) => speciesNameZh(latin)),
      tier: bundle.manifest.tier,
      toolCount: bundle.tools.length,
      coverage: coverageOf(bundle),
      blindSpots: blind.blindSpots,
      blindSpotsTotal: blind.blindSpotsTotal,
      // 只放**源工具**；元工具由 totals.metaTools 单独报（契约 §三 / §四.1）。
      tools: bundle.tools.map((tool) => tool.name),
      homepage: bundle.manifest.homepage,
      ...(probeOf(bundle) ? { lastProbe: probeOf(bundle) } : {}),
    };
  });

  /**
   * 默认会话下发数 = 不带订阅头时**实际下发**的工具数（含元工具：它们真的会进模型上下文）。
   *
   * 2026-11-13 起两种模式：
   *   - 按需展开：= 元工具数（2），`defaultSources` 为空（默认不预选任何源）；
   *   - 回滚：= `defaultSetToolCount(registry)`（清单内源 + 元工具，= 目录全量 49）。
   * 目录规模由 `catalogTools` 单独报，`defaultSetTools` 不再兼职两个含义。
   */
  const catalogTools = tools.length;
  const defaultSetTools = onDemand.enabled ? metaTools.length : defaultSetToolCount(registry);
  const expandableTools = onDemand.enabled ? Math.max(0, catalogTools - defaultSetTools) : 0;
  const defaultSources = onDemand.enabled ? [] : [...DEFAULT_SET_SOURCES];

  /**
   * 排序：与 site/ 读**同一份** src/core/pinned-sources.json（构建后 dist/core/）。
   * 这里不写任何 id 字面量——写死就成了第二份置顶规则。读不到或出现未知 id 一律抛错，
   * 不回退注册表顺序（回退会让「草莓置顶」悄悄失效，正是今天修掉的那个不一致）。
   */
  const pinned = options.pinnedSources ?? loadPinnedSources();
  const knownIds = new Set(sources.map((source) => source.id));
  const unknown = pinned.pinned.filter((id) => !knownIds.has(id));
  if (unknown.length > 0) {
    throw new Error(
      `置顶清单里有注册表中不存在的源：${unknown.join(', ')}。已登记：${[...knownIds].join(', ')}；`
        + '改 src/core/pinned-sources.json，别留着让它静默失效。',
    );
  }
  const orderedSources = applyPinnedOrder(sources, pinned.pinned);

  return {
    version: options.version,
    // 注册表快照时刻（创建时冻结）：同一实例恒定；新建实例时间可能不同，但 ETag 按内容算所以仍相同
    generatedAt: (options.now ?? new Date(registry.createdAt)).toISOString(),
    totals: { sources: bundles.length, tools: tools.length, metaTools: metaTools.length },
    budget: {
      // 契约铁律：`defaultSetTools` 必须等于「defaultSources 各源工具数之和 + totals.metaTools」。
      // 按需展开时左边是 metaTools（defaultSources 为空），回滚时是清单内源 + meta，两种模式都成立。
      defaultSources,
      defaultSetTools,
      catalogTools,
      expandableTools,
      onDemand: onDemand.enabled,
      expandPerCallMax: onDemand.perCallMax,
      sessionExpandHardMax: onDemand.hardMax,
      sessionExpandSoftMax: onDemand.softMax,
      defaultSetSoftMax: DEFAULT_SET_TOOLS_SOFT_MAX,
      defaultSetOverSoftMax: defaultSetTools > DEFAULT_SET_TOOLS_SOFT_MAX,
      subsetToolsHardMax: SUBSET_TOOLS_HARD_MAX,
      estTokensPerTool: EST_TOKENS_PER_TOOL,
      subsetToolsHardMaxTokens: SUBSET_TOOLS_HARD_MAX * EST_TOKENS_PER_TOOL,
    },
    servicesCatalog: SERVICES_CATALOG.map((entry) => ({ key: entry.key, label: entry.label, hint: entry.hint })),
    sources: orderedSources,
  };
}
