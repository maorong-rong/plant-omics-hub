import type { HttpResult } from '../../core/types.js';

/**
 * 草莓源零值诊断（SB-09）。
 *
 * 上游对「无共线块」返回 HTTP 200 + totalBlockCount=0 + blocks=[]。旧封装把这种
 * 合法空形态当成 `UpstreamShapeError` 抛出，调用方只能记「本次未取到」，连 HTTP
 * 状态和耗时都拿不到。这里在源层定义空结果的合法返回形态：
 *
 * - 四个原因枚举之一（`zero_reason`），供程序化消费；
 * - 正文固定保留端点、HTTP 状态、耗时，措辞只用「本次未取到 / 原因未知」；
 * - 不把 0 条写成「没有共线 / 不存在」——空块只能说明本次没有取到，
 *   不能据此判断基因与目标装配之间是否真有共线关系。
 *
 * 该文件在源层，只 `import type` 自 core，不改 `src/core/`，也不从 wheatomics
 * 反向 import；五步 checklist 与本源的共线查询对应。
 */

export type ZeroReason =
  | 'unsupported_generation'
  | 'no_record'
  | 'endpoint_error'
  | 'unknown';

export type ZeroCheckStatus = 'done' | 'not_run' | 'not_applicable';

export interface ZeroCheck {
  step: number;
  item: string;
  status: ZeroCheckStatus;
  note: string;
}

export interface ZeroDiagnosis {
  zero_reason: ZeroReason;
  label: string;
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
  /** 端点相对路径，例如 `/synteny/search`。 */
  endpoint: string;
  status: number;
  durationMs: number;
  bytes?: number | null;
  /** 成功响应里的 0 条形态是否结构自洽（计数为 0、数组为空、未截断）。 */
  shapeConsistent: boolean;
  /** 本次 0 条的具体字段，写进正文便于复核。 */
  shapeDetail: string;
  /** 是否允许换同源基因/装配对复测；false 时第 4 步标「不适用」。 */
  canRetryWithAnotherPair?: boolean;
  /**
   * 输入代次支持度。本源的共线查询按装配 ID 而不是编号代次，正常为 unknown；
   * 保留该字段是为了四枚举完整，避免以后把代次问题误写成记录为零。
   */
  generation?: string | null;
  support?: 'supported' | 'unsupported' | 'unknown';
  supportBasis?: string | null;
}

const LABELS: Record<ZeroReason, string> = {
  unsupported_generation: '代次不支持',
  no_record: '本次未取到',
  endpoint_error: '端点/网络故障',
  unknown: '原因未知',
};

const STATUS_MARK: Record<ZeroCheckStatus, string> = {
  done: '已做',
  not_run: '未做',
  not_applicable: '不适用',
};

function is2xx(status: number): boolean {
  return status >= 200 && status < 300;
}

/**
 * 响应字节数：核心层 `HttpResult` 没有该字段。
 * fixture 回放件可把 `capture.originalBytes` 挂到回放结果上；生产路径取不到就
 * 返回 null——不拿 `JSON.stringify` 的长度冒充线上字节。
 */
export function responseBytes(res: HttpResult): number | null {
  const value = (res as HttpResult & { originalBytes?: unknown }).originalBytes;
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
}

export function diagnoseZero(facts: ZeroFacts): ZeroDiagnosis {
  const status = facts.status;
  const failed = !is2xx(status);
  const zero_reason: ZeroReason = failed
    ? 'endpoint_error'
    : facts.support === 'unsupported'
      ? 'unsupported_generation'
      : facts.shapeConsistent
        ? 'no_record'
        : 'unknown';

  const basis = facts.supportBasis ? `（${facts.supportBasis}）` : '';
  const detail = (() => {
    switch (zero_reason) {
      case 'unsupported_generation':
        return `上游本次返回 0 条；输入代次 ${facts.generation ?? '未识别'} 不在该端点支持的代次内${basis}。`
          + '这是编号/表键的代次问题，不能据此判断记录有无。';
      case 'no_record':
        return `上游本次合法返回 0 条（${facts.shapeDetail}）${basis}；本次未取到，原因未知。`
          + '该空形态只能说明本次没有取到，不能据此判断查询对象是否真有对应关系。';
      case 'endpoint_error':
        return `端点本次没有给出可判定的 0 条响应（HTTP ${status}）${basis}；本次未取到，原因未知。`;
      default:
        return `上游本次返回 0 条，但响应形态未通过自洽检查（${facts.shapeDetail}）${basis}；`
          + '本次未取到，原因未知，不能据此判断查询对象是否真有对应关系。';
    }
  })();

  const nextStep = (() => {
    switch (zero_reason) {
      case 'unsupported_generation':
        return '改用端点支持的代次/装配 ID 再复测；未查明前只记「本次未取到」，不推断记录有无。';
      case 'no_record':
        return facts.canRetryWithAnotherPair === false
          ? '当前查询没有可替换的基因/装配对；仍为 0 条时只记「本次未取到」，不推断记录有无。'
          : '可换同源基因或装配对复测；仍为 0 条时只记「本次未取到」，不推断记录有无。';
      case 'endpoint_error':
        return '按 HTTP 状态/耗时排查端点或网络；错误响应不能折成 0 条空结果，更不能当成记录为零。';
      default:
        return '先核对端点参数与响应形态并复测；未查明前只记「原因未知」，不推断记录有无。';
    }
  })();

  const checklist: ZeroCheck[] = [
    {
      step: 1,
      item: '对端点/HTTP',
      status: failed ? 'not_run' : 'done',
      note: failed ? `HTTP ${status}，没有可判定的 0 条响应` : `HTTP ${status}，端点返回可解析 JSON`,
    },
    {
      step: 2,
      item: '对响应形态',
      status: facts.shapeConsistent ? 'done' : 'not_run',
      note: facts.shapeDetail,
    },
    {
      step: 3,
      item: '已知阳性对照',
      status: 'not_run',
      note: '本次调用未同时请求已知有结果的基因/装配对；阳性对照需另调一次',
    },
    {
      step: 4,
      item: '换基因/装配对复测',
      status: facts.canRetryWithAnotherPair === false ? 'not_applicable' : 'not_run',
      note: facts.canRetryWithAnotherPair === false
        ? '当前查询没有可替换的基因/装配对'
        : '工具不自动改查询；可按下一步换同源基因或装配对再打一次',
    },
    {
      step: 5,
      item: '结论',
      status: 'done',
      note: detail,
    },
  ];

  // 当前共线按装配 ID 而不是编号代次，generation/support 只在以后扩展时使用。
  return {
    zero_reason,
    label: LABELS[zero_reason],
    endpoint: facts.endpoint,
    http_status: status,
    duration_ms: facts.durationMs,
    bytes: facts.bytes ?? null,
    detail,
    next_step: nextStep,
    checklist,
  };
}

/** 正文固定保留「端点 + HTTP 状态 / 耗时 / 字节」与五步结论。 */
export function renderZeroDiagnosis(diagnosis: ZeroDiagnosis): string {
  const bytes = diagnosis.bytes === null
    ? '未知（核心层未暴露响应字节，不估算）'
    : `${diagnosis.bytes} B`;
  const steps = diagnosis.checklist
    .map((check) => `${check.step}.${check.item} ${STATUS_MARK[check.status]}`)
    .join('；');
  return [
    `零值诊断：${diagnosis.label}（${diagnosis.zero_reason}）｜端点 ${diagnosis.endpoint}`
      + `｜HTTP ${diagnosis.http_status}｜耗时 ${diagnosis.duration_ms} ms｜字节 ${bytes}`,
    diagnosis.detail,
    `五步排查：${steps}`,
    `下一步：${diagnosis.next_step}`,
  ].join('\n');
}
