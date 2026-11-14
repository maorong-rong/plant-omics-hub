/**
 * Gramene 源自己的零值诊断（issue #94 / RC-04）。
 *
 * 上游「查无」是 HTTP 200 + 空数组，不是 404。把这种 0 直接写成「没有这个基因」
 * 是结论性错误：水稻至少有三套常用 ID 空间（RAP-DB `Os…g…`、MSU `LOC_Os…g…`、
 * Ensembl Plants 的水稻基因复用 `Os…g…`），而 `gramene_gene` 的 `/genes` 入口
 * 只接受精确的基因文档 ID。实测 3 个 MSU `LOC_Os…` 一次查询返回 5 字节空数组，
 * 换同一基因的 RAP-DB `Os…` 就能返回记录——所以回 0 必须先说明「输入 ID 空间」，
 * 再给下一步，不能把它写成记录不存在。
 *
 * 边界：
 *   - 本文件在源层，不改 `src/core/`；也不 import WheatOmics 的 diagnosis（跨源耦合）。
 *   - 本文件不做任何 ID 换算、不保存映射表；只识别前缀并给出诊断与下一步。
 *   - 零值原因四值枚举，与 #89 的源层实现同构，但第一项换成本源需要的
 *     `unsupported_id_space`：这里要区分的是「编号空间不认」，不是「代次不支持」。
 */

export type GrameneIdSpace = 'rapdb' | 'msu' | 'ensembl' | 'unknown';

/** 单次查询里可能同时出现多个空间；`mixed` 只用于聚合后的结构化字段。 */
export type GrameneZeroSpace = GrameneIdSpace | 'mixed';

/** 四值枚举：ID 空间不匹配 / 本次未取到 / 端点故障 / 未知。 */
export type GrameneZeroReason = 'unsupported_id_space' | 'no_record' | 'endpoint_error' | 'unknown';

type SpaceSupport = 'supported' | 'unsupported' | 'unknown';

export interface IdSpaceInfo {
  space: GrameneIdSpace;
  label: string;
  support: SpaceSupport;
}

export interface ZeroCheck {
  step: number;
  item: string;
  status: 'done' | 'not_run' | 'not_applicable';
  note: string;
}

export interface GrameneZeroFacts {
  /** 本次请求的精确 ID（保持输入顺序）。 */
  ids: string[];
  /** 端点（含主机与路径，不含查询串，如 `https://data.gramene.org/v69/genes`）。 */
  endpoint: string;
  status: number;
  durationMs: number;
  attempts?: number;
  /** 非 2xx / 网络失败：此时连「上游回了空数组」都不可判定。 */
  endpointFailed?: boolean;
}

export interface GrameneZeroDiagnosis {
  reason: GrameneZeroReason;
  label: string;
  id_space: GrameneZeroSpace;
  id_space_label: string;
  id_spaces: GrameneIdSpace[];
  endpoint: string;
  http_status: number;
  duration_ms: number;
  attempts: number | null;
  detail: string;
  next_step: string;
  checklist: ZeroCheck[];
}

const SPACE_LABELS: Record<GrameneIdSpace, string> = {
  rapdb: 'RAP-DB（Os…g；Ensembl Plants 水稻基因复用该形态）',
  msu: 'MSU（LOC_Os…）',
  ensembl: 'Ensembl（转录本/ENS…）',
  unknown: '未知',
};

const SPACE_SUPPORT: Record<GrameneIdSpace, SpaceSupport> = {
  rapdb: 'supported',
  msu: 'unsupported',
  ensembl: 'unsupported',
  unknown: 'unknown',
};

const REASON_LABELS: Record<GrameneZeroReason, string> = {
  unsupported_id_space: 'ID 空间不匹配',
  no_record: '本次未取到',
  endpoint_error: '端点/网络故障',
  unknown: '未知',
};

const STATUS_MARK: Record<ZeroCheck['status'], string> = {
  done: '已做',
  not_run: '未做',
  not_applicable: '不适用',
};

/**
 * 只按**前缀形态**识别 ID 空间，不按数据库是否存在猜：
 *   - MSU：`LOC_Os` + 2 位染色体 + `g` + 5 位数字（如 LOC_Os03g11614）
 *   - RAP-DB：`Os` + 2 位染色体 + `g` + 7 位数字（如 Os03g0215400）
 *   - Ensembl：`ENS…` 或水稻转录本 `Os…t…`（与基因 ID 空间不同）
 *   - 其余：unknown
 *
 * RAP-DB 与 Ensembl Plants 的水稻**基因**都用 `Os…g…` 形态，前缀无法再分；
 * 因此这一类在 label 里同时写明两者，不把「同名形态」误当成同一数据库。
 */
export function classifyIdSpace(id: string): IdSpaceInfo {
  const value = id.trim();
  if (/^LOC_Os\d{2}g\d{5}$/i.test(value)) {
    return { space: 'msu', label: SPACE_LABELS.msu, support: SPACE_SUPPORT.msu };
  }
  if (/^Os\d{2}g\d{7}$/i.test(value)) {
    return { space: 'rapdb', label: SPACE_LABELS.rapdb, support: SPACE_SUPPORT.rapdb };
  }
  if (/^ENS[A-Z]*\d{11}$/i.test(value) || /^Os\d{2}t\d{7}(?:-\d+)?$/i.test(value)) {
    return { space: 'ensembl', label: SPACE_LABELS.ensembl, support: SPACE_SUPPORT.ensembl };
  }
  return { space: 'unknown', label: SPACE_LABELS.unknown, support: SPACE_SUPPORT.unknown };
}

/** 端点去掉查询串：正文只需要可复现的路径，ID 参数留在完整出处里。 */
export function endpointOf(url: string): string {
  const parsed = new URL(url);
  return `${parsed.origin}${parsed.pathname}`;
}

function uniqueSpaces(infos: IdSpaceInfo[]): GrameneIdSpace[] {
  const out: GrameneIdSpace[] = [];
  for (const info of infos) {
    if (!out.includes(info.space)) out.push(info.space);
  }
  return out;
}

export function diagnoseZero(facts: GrameneZeroFacts): GrameneZeroDiagnosis {
  const infos = facts.ids.map((id) => classifyIdSpace(id));
  const spaces = uniqueSpaces(infos);
  const idSpace: GrameneZeroSpace = spaces.length === 1 ? spaces[0]! : 'mixed';
  const idSpaceLabel = spaces.map((space) => SPACE_LABELS[space]).join(' / ');
  const failed = facts.endpointFailed === true || facts.status < 200 || facts.status >= 300;
  const allUnsupported = infos.length > 0 && infos.every((info) => info.support === 'unsupported');
  const allUnknown = infos.length > 0 && infos.every((info) => info.support === 'unknown');

  const reason: GrameneZeroReason = failed
    ? 'endpoint_error'
    : spaces.length === 1 && allUnsupported
      ? 'unsupported_id_space'
      : infos.every((info) => info.space === 'rapdb')
        ? 'no_record'
        : allUnknown
          ? 'unknown'
          : 'unknown';

  const detail = (() => {
    switch (reason) {
      case 'unsupported_id_space':
        return `输入 ${facts.ids.length} 个 ID 属于 ${idSpaceLabel}；/genes 的 idList 只接受精确的基因文档 ID，这一 ID 空间不被该入口接受，本次未取到记录。`;
      case 'no_record':
        return `输入 ${facts.ids.length} 个 ID 属于 ${idSpaceLabel}，是该端点已实测接受的 ID 空间；本次未取到记录。`;
      case 'endpoint_error':
        return `端点本次没有给出可判定的空数组（HTTP ${facts.status}）；本次未取到，不能据此判断记录有无。`;
      default:
        return `输入 ${facts.ids.length} 个 ID 的 ID 空间为 ${idSpaceLabel}；该空间是否被 /genes 接受未实测，0 条的原因未知，本次未取到。`;
    }
  })();

  const nextStep = (() => {
    if (reason === 'unsupported_id_space') {
      if (spaces.length === 1 && spaces[0] === 'msu') {
        return '换同一基因的 RAP-DB Os…g ID 复测（本工具不提供换算；可用文献或已测方向的 ID 对照对号），不要把 MSU LOC_Os… 直接当 Gramene 基因 ID。';
      }
      if (spaces.length === 1 && spaces[0] === 'ensembl') {
        return '换该基因的 RAP-DB Os…g 或 MSU LOC_Os… ID 复测；Ensembl 转录本/ENS… ID 与 /genes 的基因 ID 空间不同，本工具不换算。';
      }
      return '先确认这是哪一套基因 ID，再换该空间的精确 ID 复测；本工具不做换算。';
    }
    if (reason === 'no_record') {
      return '先核对 ID 拼写与版本；可用 gramene_search 按名称/符号找候选，再按精确 ID 复测；仍为 0 时只记本次未取到。';
    }
    if (reason === 'endpoint_error') {
      return '按 HTTP 状态/耗时排查端点或网络；错误响应不能折成 0 条空结果。';
    }
    return '先确认 ID 属于 RAP-DB Os…g / MSU LOC_Os… / Ensembl 中的哪一个空间，再用该空间的精确 ID 复测；未确认前只记未知。';
  })();

  const idSpaceKnown = spaces.length > 0 && !spaces.includes('unknown');
  const checklist: ZeroCheck[] = [
    {
      step: 1,
      item: '对 ID 空间',
      status: idSpaceKnown ? 'done' : 'not_run',
      note: idSpaceKnown
        ? `输入空间=${spaces.map((space) => SPACE_LABELS[space]).join(' / ')}；/genes 只接受精确基因文档 ID`
        : '输入 ID 的前缀不在已识别空间内，这一步排除不了任何原因',
    },
    {
      step: 2,
      item: '换 ID 空间复测',
      status: 'not_run',
      note: '工具不自动换算/改写输入；按下一步手工换同一基因的另一空间 ID 再查',
    },
    {
      step: 3,
      item: '已知阳性对照',
      status: 'not_run',
      note: '本次调用未回显阳性对照；对照需另调已知有记录的 ID（本单 RAP-DB 阳性 fixture）',
    },
    {
      step: 4,
      item: '区间/符号入口',
      status: 'not_applicable',
      note: 'genes 只接受精确 idList；按名称/符号找候选走 gramene_search，不能替代单基因记录',
    },
    {
      step: 5,
      item: '结论',
      status: 'done',
      note: detail,
    },
  ];

  return {
    reason,
    label: REASON_LABELS[reason],
    id_space: idSpace,
    id_space_label: idSpaceLabel,
    id_spaces: spaces,
    endpoint: facts.endpoint,
    http_status: facts.status,
    duration_ms: facts.durationMs,
    attempts: facts.attempts ?? null,
    detail,
    next_step: nextStep,
    checklist,
  };
}

/** 正文固定保留：ID 空间 + 端点 + HTTP 状态 + 耗时 + 「本次未取到」+ 下一步。 */
export function renderZeroDiagnosis(diagnosis: GrameneZeroDiagnosis): string {
  const steps = diagnosis.checklist
    .map((check) => `${check.step}.${check.item} ${STATUS_MARK[check.status]}`)
    .join('；');
  return [
    `零值诊断：${diagnosis.label}（${diagnosis.reason}）｜输入 ID 空间 ${diagnosis.id_space_label}`
      + `｜端点 ${diagnosis.endpoint}｜HTTP ${diagnosis.http_status}｜耗时 ${diagnosis.duration_ms} ms｜本次未取到`,
    diagnosis.detail,
    `五步排查（《源登记表》静默返回 0 清单）：${steps}`,
    `下一步：${diagnosis.next_step}`,
  ].join('\n');
}

/** 结构化输出：程序化消费零值原因；不进正文预算。 */
export function zeroStructured(diagnosis: GrameneZeroDiagnosis): Record<string, unknown> {
  return {
    zero_reason: diagnosis.reason,
    zero_label: diagnosis.label,
    zero_detail: diagnosis.detail,
    id_space: diagnosis.id_space,
    id_space_label: diagnosis.id_space_label,
    id_spaces: diagnosis.id_spaces,
    endpoint: diagnosis.endpoint,
    http_status: diagnosis.http_status,
    duration_ms: diagnosis.duration_ms,
    attempts: diagnosis.attempts,
    next_step: diagnosis.next_step,
    checklist: diagnosis.checklist,
  };
}
