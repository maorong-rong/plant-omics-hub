import type { HttpResult } from '../../core/types.js';

/**
 * 零值诊断（issue #84 / v2 D-01 第 1 步）。
 *
 * 上游很多端点「查无」不报错：HTTP 200 + count=0 / results=[]。
 * 把这种 0 直接写成「没有数据」是本仓最危险的结论性错误——#75 实测 302 个 03G
 * 送 GO 富集回 n=0 / 0.6 s，换 02G+.1 后 n=4；WRKY 294/294 同源全 0 复现。
 *
 * 因此工具层在返回 0 条时必须带一个**原因字段**（四值枚举），并把
 * 《源登记表》「静默返回 0」五步排查固化成结构化 checklist：
 *   1. 对代次（输入代次 vs 端点支持的代次）
 *   2. 换代次复测（工具不自动改查询，标「未做」并给下一步）
 *   3. 已知阳性对照（本次调用没有回显，标「未做」）
 *   4. 区间 vs 单基因（端点没有区间入口就标「不适用」）
 *   5. 才判「上游没有」→ 结论只写「本次未取到」，不写「不存在 / 没有数据」
 *
 * 边界：本文件在源层，不改 `src/core/`。响应字节数由核心层 `HttpResult` 未暴露，
 * 因此运行时只能标「未知（核心层未暴露，不估算）」；fixture 回放可带 originalBytes，
 * 测试里能核到真字节数。
 */

export type ZeroReason =
  | 'unsupported_generation'
  | 'no_record'
  | 'endpoint_error'
  | 'unknown';

/** 端点对输入代次的支持程度（来自实测，不按 ID 外观猜）。 */
export type GenerationSupport = 'supported' | 'unsupported' | 'unknown';

export interface ZeroCheck {
  step: number;
  item: string;
  status: 'done' | 'not_run' | 'not_applicable';
  note: string;
}

export interface ZeroDiagnosis {
  reason: ZeroReason;
  label: string;
  generation: string | null;
  endpoint: string;
  http_status: number;
  duration_ms: number;
  /** 上游响应字节数；null = 核心层未暴露（不估算）。 */
  bytes: number | null;
  detail: string;
  next_step: string;
  checklist: ZeroCheck[];
}

export interface ZeroFacts {
  /** 端点（相对路径即可复现，例如 `/api/ppi/query?table=PPI_poppin`）。 */
  endpoint: string;
  /** 输入代次，写 `01G` / `02G` / `03G`；区间/非基因查询为 null。 */
  generation?: string | null;
  support?: GenerationSupport;
  /** 为什么支持/不支持这一代（实测依据），写进正文。 */
  supportBasis?: string | null;
  status: number;
  durationMs: number;
  bytes?: number | null;
  /** 非 2xx / 网络失败：此时连「上游回了 0 条」都不可判定。 */
  endpointFailed?: boolean;
  /** 端点是否有区间入口（决定第 4 步「区间 vs 单基因」是否适用）。 */
  hasRegionMode?: boolean;
}

const LABELS: Record<ZeroReason, string> = {
  unsupported_generation: '代次不支持',
  no_record: '本次未取到',
  endpoint_error: '端点/网络故障',
  unknown: '未知',
};

const STATUS_MARK: Record<ZeroCheck['status'], string> = {
  done: '已做',
  not_run: '未做',
  not_applicable: '不适用',
};

function is2xx(status: number): boolean {
  return status >= 200 && status < 300;
}

/** 把 `01` / `02` / `03` 前缀规整成 `01G` / `02G` / `03G`；其他一律 null。 */
export function generationLabel(generation: string | undefined | null): string | null {
  if (!generation) return null;
  const raw = generation.trim().toUpperCase();
  return /^\d{2}G$/.test(raw) ? raw : /^\d{2}$/.test(raw) ? `${raw}G` : null;
}

/**
 * 响应字节数：核心层没把它放进 `HttpResult`。
 * fixture 回放件在 `capture.originalBytes` 里有真值，测试可把它挂到回放结果上；
 * 生产路径取不到就返回 null——**不拿 JSON.stringify 的长度冒充线上字节**。
 */
export function responseBytes(res: HttpResult): number | null {
  const value = (res as HttpResult & { originalBytes?: unknown }).originalBytes;
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
}

export function diagnoseZero(facts: ZeroFacts): ZeroDiagnosis {
  const bytes = facts.bytes ?? null;
  const status = facts.status;
  const failed = facts.endpointFailed === true || !is2xx(status);
  const reason: ZeroReason = failed
    ? 'endpoint_error'
    : facts.support === 'unsupported'
      ? 'unsupported_generation'
      : facts.support === 'supported'
        ? 'no_record'
        : 'unknown';

  const basis = facts.supportBasis ? `（${facts.supportBasis}）` : '';
  const detail = (() => {
    switch (reason) {
      case 'unsupported_generation':
        return `上游本次返回 0 条；输入代次 ${facts.generation ?? '未识别'} 不在该端点支持的代次内${basis}。`
          + '这是编号/表键的代次问题，不能据此判断记录有无。';
      case 'no_record':
        return `上游本次返回 0 条；输入代次与该端点匹配${basis}，但本次未取到。`;
      case 'endpoint_error':
        return `端点本次没有给出可判定的 0 条响应（HTTP ${status}）${basis}；本次未取到，不能据此判断记录有无。`;
      default:
        return `上游本次返回 0 条；该端点的代次支持未声明或未测${basis}，0 条的原因未知，本次未取到。`;
    }
  })();

  const nextStep = (() => {
    switch (reason) {
      case 'unsupported_generation':
        return '先用 wheatomics_convert_gene_ids 换成端点支持的代次（03G↔02G 可换；02G→01G 上游无端点，记「未知」）再复测。';
      case 'no_record':
        return '可换同源基因或区间复测；仍为 0 时只记「本次未取到」，不推断记录有无。';
      case 'endpoint_error':
        return '按 HTTP 状态/耗时排查端点或网络；错误响应不能折成 0 条空结果，更不能当成记录为零。';
      default:
        return '先换代次复测或查《源登记表》代次表；未查明前只记「未知」，不推断记录有无。';
    }
  })();

  const generationKnown = Boolean(facts.generation) && facts.support !== undefined && facts.support !== 'unknown';
  const checklist: ZeroCheck[] = [
    {
      step: 1,
      item: '对代次',
      status: generationKnown ? 'done' : 'not_run',
      note: generationKnown
        ? `输入 ${facts.generation}，端点支持=${facts.support}${basis}`
        : '端点代次支持未声明/未测，这一步排除不了任何原因',
    },
    {
      step: 2,
      item: '换代次复测',
      status: 'not_run',
      note: '工具不自动改查询；需按下一步手工换到支持代次再打一次',
    },
    {
      step: 3,
      item: '已知阳性对照',
      status: 'not_run',
      note: '本次调用未回显阳性对照；阳性对照需另调已知有结果的 ID',
    },
    {
      step: 4,
      item: '区间 vs 单基因',
      status: facts.hasRegionMode ? 'not_run' : 'not_applicable',
      note: facts.hasRegionMode ? '端点有区间入口，可换区间复测' : '该端点没有区间入口',
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
    label: LABELS[reason],
    generation: facts.generation ?? null,
    endpoint: facts.endpoint,
    http_status: status,
    duration_ms: facts.durationMs,
    bytes,
    detail,
    next_step: nextStep,
    checklist,
  };
}

/** 正文里保留「代次 + 端点 + HTTP 状态 / 耗时 / 字节」与五步结论。 */
export function renderZeroDiagnosis(diagnosis: ZeroDiagnosis): string {
  const bytes = diagnosis.bytes === null
    ? '未知（核心层未暴露响应字节，不估算）'
    : `${diagnosis.bytes} B`;
  const steps = diagnosis.checklist
    .map((check) => `${check.step}.${check.item} ${STATUS_MARK[check.status]}`)
    .join('；');
  return [
    `零值诊断：${diagnosis.label}（${diagnosis.reason}）｜代次 ${diagnosis.generation ?? '不适用'}`
      + `｜端点 ${diagnosis.endpoint}｜HTTP ${diagnosis.http_status}｜耗时 ${diagnosis.duration_ms} ms｜字节 ${bytes}`,
    diagnosis.detail,
    `五步排查（《源登记表》静默返回 0 清单）：${steps}`,
    `下一步：${diagnosis.next_step}`,
  ].join('\n');
}
