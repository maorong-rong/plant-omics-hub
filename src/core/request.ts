import { InvalidArgumentError, UpstreamError, UpstreamShapeError } from './errors.js';
import { DEFAULT_MAX_BYTES, provenance, truncateToBytes, utf8Bytes } from './format.js';
import type { HttpResult, ToolContext, ToolResult } from './types.js';

export const MAX_REQUEST_BYTES = 1536;
export const MAX_TAIL_BYTES = 2560;
export const MAX_BODY_BYTES = 1408;
const MARKER = '\n…（正文已按 4 KB 上限截断；请缩小查询范围或分批查询）';

/**
 * 允许发 POST 的**完整 URL 白名单**。
 *
 * 共享层原先只发 GET；WheatOmics 的 GO/KEGG 富集只有 POST。POST 不是"再加一个
 * fetch 参数"就完事：请求体决定服务端算什么，一旦开放成"想发什么发什么"，
 * 任何源层拼错 URL 都能把任意 JSON 打给任意主机。所以这里用**精确 URL**
 * （含协议、主机、路径，不含查询串）做闭集，未登记的一律在联网前拒绝。
 *
 * 新增 POST 端点必须同时改这里、加测试、并在 PR 里说明为什么该端点必须是 POST。
 */
export const POST_ENDPOINTS: ReadonlySet<string> = new Set([
  'https://wheatomics.sdau.edu.cn/api/go',
  'https://wheatomics.sdau.edu.cn/api/kegg',
]);

export type RequestMethod = 'GET' | 'POST';

export interface PreparedRequest {
  readonly url: string;
  readonly sourceName: string;
  /** 完整实际请求，含所有上游参数、请求体与本地呈现选项。 */
  readonly request: string;
  readonly method: RequestMethod;
  /** POST 的 JSON 请求体（已序列化）；GET 为 undefined。 */
  readonly body?: string;
}

/** 必须在任何网络调用之前执行。禁止截断/哈希代替关键参数。 */
export function prepareRequest(input: {
  url: string;
  sourceName: string;
  presentation?: Record<string, unknown>;
  /** 缺省 GET；POST 必须同时给 jsonBody，且 URL 必须在 POST_ENDPOINTS 里。 */
  method?: RequestMethod;
  jsonBody?: unknown;
}): PreparedRequest {
  const url = new URL(input.url);
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.hash) {
    throw new InvalidArgumentError('请求URL必须是无凭据、无片段的HTTP(S)地址');
  }
  const method = input.method ?? 'GET';
  const local = input.presentation ? `；呈现参数=${JSON.stringify(input.presentation)}` : '';
  let request: string;
  let body: string | undefined;
  if (method === 'POST') {
    if (!POST_ENDPOINTS.has(url.href)) {
      throw new InvalidArgumentError(
        `该端点未登记为 POST 出口，拒绝发送：${url.href}（POST 只对显式声明的端点开放；尚未联网）`,
      );
    }
    if (input.jsonBody === undefined) {
      throw new InvalidArgumentError('POST 请求必须提供 jsonBody（尚未联网）');
    }
    const serialized = JSON.stringify(input.jsonBody);
    if (typeof serialized !== 'string') {
      throw new InvalidArgumentError('POST 请求体无法序列化为 JSON（尚未联网）');
    }
    body = serialized;
    request = `POST ${url.href}${local}；body=${body}`;
  } else if (method === 'GET') {
    if (input.jsonBody !== undefined) {
      throw new InvalidArgumentError('GET 请求不能携带请求体（尚未联网）');
    }
    request = `GET ${url.href}${local}`;
  } else {
    throw new InvalidArgumentError(`不支持的请求方法：${String(method)}（只允许 GET / POST；尚未联网）`);
  }
  const bytes = utf8Bytes(request);
  if (bytes > MAX_REQUEST_BYTES) {
    throw new InvalidArgumentError(`完整请求证据 ${bytes} UTF-8字节，超过 ${MAX_REQUEST_BYTES} 字节上限；请缩短筛选或拆分查询（尚未联网，未省略参数）`);
  }
  // 为响应自身版本等额外元数据留足768字节；状态/耗时使用安全上界。
  const reserved = provenance({ sourceName: input.sourceName, request, status: 999,
    durationMs: Number.MAX_SAFE_INTEGER, at: '9999-12-31T23:59:59.999Z', extra: 'x'.repeat(768) });
  if (utf8Bytes(reserved) > MAX_TAIL_BYTES) {
    throw new InvalidArgumentError('完整出处预留超出2560字节，请缩短请求或源名（尚未联网）');
  }
  return Object.freeze({ url: url.href, sourceName: input.sourceName, request, method,
    ...(body === undefined ? {} : { body }) });
}

// 仅按单次执行上下文关联预检证据；不用全局“最近请求”变量。
const executionRequests = new WeakMap<ToolContext, PreparedRequest>();

/** 包住取数后的解析/字段校验；保留错误实例及子类型，只补同URL的完整证据。 */
export async function withRequestEvidence<T>(ctx: ToolContext, run: (scoped: ToolContext) => Promise<T>): Promise<T> {
  const scoped = { ...ctx };
  try {
    return await run(scoped);
  } catch (error) {
    const prepared = executionRequests.get(scoped);
    if (prepared && error instanceof UpstreamError && error.meta.url === prepared.url) {
      error.meta.request = prepared.request;
    }
    throw error;
  } finally {
    executionRequests.delete(scoped);
  }
}

/** 取数时可覆盖的执行选项（不进入请求证据；证据仍由 prepared 决定）。 */
export interface FetchPreparedOptions {
  timeoutMs?: number;
  retries?: number;
  maxTotalMs?: number;
}

/** 两出口看到的HTTP错误同样携带完整请求（含本地选项），不透传响应正文。 */
export async function fetchPrepared(
  ctx: ToolContext,
  prepared: PreparedRequest,
  options: FetchPreparedOptions = {},
): Promise<HttpResult> {
  executionRequests.set(ctx, prepared);
  try {
    return await ctx.http(prepared.url, {
      signal: ctx.signal,
      method: prepared.method,
      ...(prepared.body === undefined ? {} : { body: prepared.body }),
      ...options,
    });
  } catch (error) {
    if (error instanceof UpstreamError) {
      throw new UpstreamError(error.message, { ...error.meta, url: prepared.url, request: prepared.request });
    }
    throw error;
  }
}

export function finishResult(input: {
  body: string;
  res: HttpResult;
  raw?: unknown;
  /** 批量/导出模式才提供；MCP 出口作为 structuredContent，不进正文预算。 */
  structured?: Record<string, unknown>;
  prepared: PreparedRequest;
  sourceId: string;
  extra?: string;
}): ToolResult {
  const { res, prepared } = input;
  if (res.url !== prepared.url) {
    throw new UpstreamShapeError('响应请求URL与预检证据不一致', { url: prepared.url, request: prepared.request });
  }
  const at = new Date().toISOString();
  const tail = provenance({ sourceName: prepared.sourceName, request: prepared.request,
    status: res.status, durationMs: res.durationMs, at, extra: input.extra });
  if (utf8Bytes(tail) > MAX_TAIL_BYTES) {
    throw new UpstreamShapeError('响应版本/元数据使完整出处超过2560字节，拒绝返回不完整成功结果', {
      url: prepared.url, status: res.status, request: prepared.request,
    });
  }
  const budget = Math.min(MAX_BODY_BYTES, DEFAULT_MAX_BYTES - utf8Bytes(tail) - utf8Bytes(MARKER));
  const clipped = truncateToBytes(input.body, budget);
  const text = `${clipped.text}${clipped.truncated ? MARKER : ''}${tail}`;
  if (utf8Bytes(text) > DEFAULT_MAX_BYTES) throw new Error('输出预算不变量被破坏');
  return { text, raw: input.raw, ...(input.structured ? { structured: input.structured } : {}),
    meta: { sourceId: input.sourceId, request: prepared.request,
      url: prepared.url, status: res.status, durationMs: res.durationMs, at } };
}
