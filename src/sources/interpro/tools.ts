/**
 * InterPro / Pfam HMM 出口（issue #73 §1.1，第 11 源）。
 *
 * 语义：按 Pfam accession 取**域模型 HMM 正文**，落盘缓存，返回 accession 规范化结果、
 * InterPro 版本、md5、取数时间与缓存路径。HMM 是几十 KB 的文本，**正文预算只有 1,408 B**，
 * 所以正文只放 manifest，完整 HMM 放 `structuredContent.hmm`（MCP 出口按结构化内容返回）。
 *
 * 上游事实（2026-11-10 本机实测）：
 *   GET https://www.ebi.ac.uk/interpro/wwwapi/entry/pfam/PF00319/?annotation=hmm
 *   → 200 / 5,562 B / content-type: application/gzip
 *   → 解压 23,553 B，md5 19621ce1a6c9222d748f60b6e8ff5e37
 *   → 响应头 interpro-version: 111.0 / interpro-version-minor: 0
 *
 * 为什么自己用 `fetch` 而不走 `src/core/http.ts`：公共层按 JSON 解析正文，且 `HttpResult.headers`
 * 只保留 `x-*` 头；HMM 是 gzip 二进制、版本号又在 `interpro-version` 头里，两样都拿不到。
 * 与 `ic4r/bulk.ts` 同一处理：只读 GET、同一 UA、同样的超时与 5xx/429 退避，不扩展公共层。
 */

import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { gunzipSync } from 'node:zlib';

import { InvalidArgumentError, PlantOmicsError, UpstreamError, UpstreamShapeError } from '../../core/errors.js';
import { USER_AGENT } from '../../core/http.js';
import { finishResult, prepareRequest } from '../../core/request.js';
import type { HttpResult, ToolContext, ToolDefinition } from '../../core/types.js';
import { manifest } from './manifest.js';

const SCHEMA_VERSION = 1;
const TIMEOUT_MS = 30_000;
const MAX_ATTEMPTS = 3;
const BACKOFF_MS = [400, 1_200];

/** A 套（#70）2026-11-10 实测的 PF00319 HMM 正文 md5；只对这一个 accession 有历史基线。 */
export const PF00319_BASELINE_MD5 = '19621ce1a6c9222d748f60b6e8ff5e37';

export interface HmmAccession {
  /** 规范化后的基础 accession，如 `PF00319`。 */
  base: string;
  /** 请求里带的版本号（`PF00319.25` → `25`）；未带为 undefined。 */
  requestedVersion?: string;
}

/**
 * accession 规范化：接受 `PF00319` / `PF00319.25`，大小写与首尾空白归一到同一形态。
 * 明确拒绝其它形态（IPR、基因名、空串），**不返回空结果糊弄**。
 */
export function normalizeAccession(raw: unknown): HmmAccession {
  if (typeof raw !== 'string') throw new InvalidArgumentError('参数 accession 必须是字符串（尚未联网）');
  const input = raw.trim();
  if (!input) throw new InvalidArgumentError('参数 accession 不能为空（尚未联网）');
  if (/\s/.test(input)) throw new InvalidArgumentError('参数 accession 含空白，请去掉后重试（尚未联网）');
  const match = /^PF(\d{5})(?:\.(\d+))?$/i.exec(input);
  if (!match) {
    throw new InvalidArgumentError(
      `参数 accession 必须是 Pfam 编号（PF00319 或 PF00319.25），收到「${input.slice(0, 32)}」（尚未联网）。`
        + 'InterPro 集成条目（IPR…）与基因名不在这里查询',
    );
  }
  const base = `PF${match[1]}`;
  return match[2] ? { base, requestedVersion: String(Number(match[2])) } : { base };
}

export interface HmmOptions {
  /** 测试注入；生产用 globalThis.fetch 的惰性转发。 */
  fetchImpl?: typeof fetch;
  /** 缓存根目录；默认 `$XDG_CACHE_HOME/plantomics/interpro`（没有 XDG 就 `~/.cache`）。 */
  cacheRoot?: string;
  /** 测试注入时钟；生产用 Date.now。 */
  now?: () => number;
}

export interface HmmManifest {
  schemaVersion: number;
  source: 'interpro';
  status: 'ok' | 'partial';
  cache: 'download' | 'hit';
  requested: { accession: string; version?: string };
  accession: string;
  hmmAccession: string;
  name: string | null;
  description: string | null;
  length: number | null;
  interproVersion: string | null;
  interproVersionMinor: string | null;
  md5: string;
  sha256: string;
  bytes: number;
  expectedMd5: string | null;
  mismatches: string[];
  warnings: string[];
  upstream: {
    url: string;
    status: number;
    bytes: number;
    contentType: string | null;
    etag: string | null;
    lastModified: string | null;
  };
  local: { directory: string; hmmPath: string; manifestPath: string };
  fetchedAt: string;
  durationMs: number;
}

export interface HmmRunResult {
  manifest: HmmManifest;
  hmm: string;
}

function formatInt(value: number): string {
  return String(value).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

function defaultCacheRoot(): string {
  const configured = process.env.PLANTOMICS_CACHE_DIR?.trim();
  if (configured) return path.join(path.resolve(configured), 'interpro');
  const base = process.env.XDG_CACHE_HOME?.trim() || path.join(homedir(), '.cache');
  return path.join(base, 'plantomics', 'interpro');
}

function refreshArg(raw: unknown): boolean {
  if (raw === undefined || raw === null) return false;
  if (typeof raw !== 'boolean') throw new InvalidArgumentError('参数 refresh 必须是布尔值');
  return raw;
}

function upstreamError(url: string, status: number, attempt: number): UpstreamError {
  const suffix = status === 404
    ? '上游 404：该 Pfam accession 不存在，或端点路径已改版'
    : status === 400
      ? '上游 400：accession 形态不被接受'
      : status === 429
        ? '上游限流（HTTP 429）'
        : status >= 500
          ? `上游/反向代理暂时不可用（HTTP ${status}）`
          : `上游返回 HTTP ${status}`;
  return new UpstreamError(suffix, { url, status, attempts: attempt, request: `GET ${url}` });
}

function isRetryable(status: number): boolean {
  return status === 429 || status >= 500;
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function sha256(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

function md5(text: string): string {
  return createHash('md5').update(text, 'utf8').digest('hex');
}

interface ParsedHmm {
  text: string;
  hmmAccession: string;
  name: string | null;
  description: string | null;
  length: number | null;
}

/** 解压 + 结构校验。不是 HMMER 文本、或 ACC 缺失，一律在落盘前拒绝。 */
export function parseHmmPayload(bytes: Uint8Array, url: string): ParsedHmm {
  const raw = Buffer.from(bytes);
  let text: string;
  if (raw.length >= 2 && raw[0] === 0x1f && raw[1] === 0x8b) {
    try {
      text = gunzipSync(raw).toString('utf8');
    } catch (error) {
      throw new UpstreamShapeError(
        `gzip 解压失败：${error instanceof Error ? error.message : String(error)}（截断/坏文件不返回 HMM）`,
        { url },
      );
    }
  } else {
    text = raw.toString('utf8');
  }
  if (!/^HMMER3\//m.test(text)) {
    throw new UpstreamShapeError(
      `响应不是 HMMER3 文本（前 80 字符：${text.slice(0, 80).replace(/\s+/g, ' ')}），拒绝当成 HMM`,
      { url },
    );
  }
  const acc = /^ACC\s+(\S+)\s*$/m.exec(text)?.[1];
  if (!acc) throw new UpstreamShapeError('HMM 正文缺少 ACC 行，无法确认条目身份', { url });
  const name = /^NAME\s+(.+?)\s*$/m.exec(text)?.[1]?.trim() ?? null;
  const description = /^DESC\s+(.+?)\s*$/m.exec(text)?.[1]?.trim() ?? null;
  const leng = /^LENG\s+(\d+)\s*$/m.exec(text)?.[1];
  return {
    text,
    hmmAccession: acc,
    name,
    description,
    length: leng ? Number(leng) : null,
  };
}

interface Fetched {
  text: string;
  parsed: ParsedHmm;
  upstream: HmmManifest['upstream'];
}

async function fetchHmm(
  url: string,
  fetchImpl: typeof fetch,
  signal: AbortSignal | undefined,
): Promise<Fetched> {
  let last: unknown;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    if (attempt > 1) await sleep(BACKOFF_MS[Math.min(attempt - 2, BACKOFF_MS.length - 1)] ?? 0);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    const onAbort = () => controller.abort();
    if (signal) {
      if (signal.aborted) controller.abort();
      else signal.addEventListener('abort', onAbort, { once: true });
    }
    try {
      const response = await fetchImpl(url, {
        method: 'GET',
        redirect: 'follow',
        signal: controller.signal,
        headers: { accept: 'application/gzip, text/plain;q=0.9, */*;q=0.5', 'user-agent': USER_AGENT },
      });
      if (!response.ok) {
        const error = upstreamError(url, response.status, attempt);
        if (isRetryable(response.status) && attempt < MAX_ATTEMPTS) {
          last = error;
          continue;
        }
        throw error;
      }
      const bytes = new Uint8Array(await response.arrayBuffer());
      if (bytes.length === 0) throw new UpstreamShapeError('上游 200 但正文为 0 字节', { url });
      const parsed = parseHmmPayload(bytes, url);
      return {
        text: parsed.text,
        parsed,
        upstream: {
          url,
          status: response.status,
          bytes: bytes.length,
          contentType: response.headers.get('content-type'),
          etag: response.headers.get('etag'),
          lastModified: response.headers.get('last-modified'),
        },
      };
    } catch (error) {
      last = error;
      if (error instanceof UpstreamError) {
        if (error.meta.status !== undefined && !isRetryable(error.meta.status)) throw error;
        if (attempt >= MAX_ATTEMPTS) throw error;
        continue;
      }
      if (error instanceof UpstreamShapeError) {
        // 坏 gzip / HTML 错误页：重试可能拿到完整响应（CDS 实测过中途断流）。
        if (attempt >= MAX_ATTEMPTS) throw error;
        continue;
      }
      if (controller.signal.aborted && !signal?.aborted) {
        const timeout = new UpstreamError(`上游请求超时（${TIMEOUT_MS} ms）`, { url, request: `GET ${url}` });
        if (attempt >= MAX_ATTEMPTS) throw timeout;
        last = timeout;
        continue;
      }
      throw new UpstreamError(`无法连接上游：${error instanceof Error ? error.message : String(error)}`, {
        url,
        request: `GET ${url}`,
      });
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    }
  }
  throw last instanceof Error ? last : new UpstreamError('上游请求失败', { url, request: `GET ${url}` });
}

/**
 * InterPro 版本号只能从 API 根/条目端点的响应头读到：HMM 端点（wwwapi）**不带**
 * `interpro-version`（2026-11-10 实测 Node/curl 两侧都只有 content-type/length）。
 * 所以下载成功后额外发一次 HEAD `/api/`（855 B 级响应头，无正文），失败时版本写 null + warning，
 * 不把「没读到」伪装成「有版本」。
 */
async function fetchInterproVersion(
  fetchImpl: typeof fetch,
  signal: AbortSignal | undefined,
): Promise<{ version: string | null; minor: string | null; warning?: string }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10_000);
  const onAbort = () => controller.abort();
  if (signal) {
    if (signal.aborted) controller.abort();
    else signal.addEventListener('abort', onAbort, { once: true });
  }
  try {
    const response = await fetchImpl(`${manifest.apiBase}/api/`, {
      method: 'HEAD',
      redirect: 'follow',
      signal: controller.signal,
      headers: { accept: 'application/json', 'user-agent': USER_AGENT },
    });
    if (!response.ok) {
      return { version: null, minor: null, warning: `未能读取 InterPro 版本：HEAD /api/ 返回 HTTP ${response.status}` };
    }
    return {
      version: response.headers.get('interpro-version'),
      minor: response.headers.get('interpro-version-minor'),
    };
  } catch (error) {
    return {
      version: null,
      minor: null,
      warning: `未能读取 InterPro 版本：HEAD /api/ 失败（${error instanceof Error ? error.message : String(error)}）`,
    };
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
  }
}

function readCached(
  directory: string,
  manifestPath: string,
  hmmPath: string,
  base: string,
): HmmRunResult | null {
  try {
    const parsed = JSON.parse(readFileSync(manifestPath, 'utf8')) as HmmManifest;
    if (
      parsed.schemaVersion !== SCHEMA_VERSION
      || parsed.source !== 'interpro'
      || parsed.accession !== base
      || !Array.isArray(parsed.warnings)
    ) return null;
    const text = readFileSync(hmmPath, 'utf8');
    if (statSync(hmmPath).size !== parsed.bytes) return null;
    if (sha256(text) !== parsed.sha256) return null;
    if (md5(text) !== parsed.md5) return null;
    return {
      hmm: text,
      manifest: { ...parsed, local: { ...parsed.local, directory, hmmPath, manifestPath } },
    };
  } catch {
    return null;
  }
}

interface RunDeps {
  fetch: typeof fetch;
  cacheRoot: string;
  now: () => number;
}

const inFlight = new Map<string, Promise<HmmRunResult>>();

async function runHmm(
  args: Record<string, unknown>,
  ctx: ToolContext,
  deps: RunDeps,
): Promise<HmmRunResult> {
  const requested = normalizeAccession(args.accession);
  const refresh = refreshArg(args.refresh);
  const directory = path.join(deps.cacheRoot, 'pfam');
  const hmmPath = path.join(directory, `${requested.base}.hmm`);
  const manifestPath = path.join(directory, `${requested.base}.json`);
  const key = `${directory}\u0000${requested.base}\u0000${refresh ? 'refresh' : 'cached'}`;
  const running = inFlight.get(key);
  if (running) return running;

  const task = (async (): Promise<HmmRunResult> => {
    mkdirSync(directory, { recursive: true });
    const started = deps.now();
    const cached = !refresh ? readCached(directory, manifestPath, hmmPath, requested.base) : null;
    if (cached) {
      const previous = cached.manifest;
      if (requested.requestedVersion && previous.hmmAccession !== `${requested.base}.${requested.requestedVersion}`) {
        throw new UpstreamError(
          `本地缓存是 ${previous.hmmAccession}，与请求的 ${requested.base}.${requested.requestedVersion} 不一致；`
            + '上游不提供历史版本归档，无法满足该版本请求（用 refresh=true 可核对上游当前版本）',
          { url: previous.upstream.url, request: `GET ${previous.upstream.url}` },
        );
      }
      return {
        hmm: cached.hmm,
        manifest: {
          ...previous,
          cache: 'hit',
          durationMs: deps.now() - started,
        },
      };
    }

    const url = `${manifest.apiBase}/wwwapi/entry/pfam/${requested.base}/?annotation=hmm`;
    const fetched = await fetchHmm(url, deps.fetch, ctx.signal);
    const hmmMd5 = md5(fetched.text);
    const version = await fetchInterproVersion(deps.fetch, ctx.signal);
    const mismatches: string[] = [];
    const warnings: string[] = version.warning ? [version.warning] : [];

    if (fetched.parsed.hmmAccession.split('.')[0] !== requested.base) {
      throw new UpstreamShapeError(
        `HMM 条目身份不符：请求 ${requested.base}，正文 ACC ${fetched.parsed.hmmAccession}`,
        { url },
      );
    }
    if (requested.requestedVersion && fetched.parsed.hmmAccession !== `${requested.base}.${requested.requestedVersion}`) {
      throw new UpstreamError(
        `请求 ${requested.base}.${requested.requestedVersion}，上游当前版本是 ${fetched.parsed.hmmAccession}；`
          + 'wwwapi 不提供历史版本归档，不把新版本冒充成旧版本',
        { url, status: fetched.upstream.status, request: `GET ${url}` },
      );
    }
    const expectedMd5 = requested.base === 'PF00319' ? PF00319_BASELINE_MD5 : null;
    if (expectedMd5 && hmmMd5 !== expectedMd5) {
      mismatches.push(`PF00319 HMM 正文 md5 期望 ${expectedMd5}，实际 ${hmmMd5}`);
      warnings.push(
        '本次 md5 与 2026-11-10 A 套基线不一致：上游条目已更新（InterPro 版本变化时会这样），'
          + '不是传输错误（gzip 解压与结构校验均已通过）',
      );
    }

    // 先写文件再写 manifest：manifest 存在即说明文件完整。
    const token = `${process.pid}-${randomUUID().slice(0, 8)}`;
    const hmmTemp = path.join(directory, `.${requested.base}.hmm.part-${token}`);
    const manifestTemp = path.join(directory, `.${requested.base}.json.part-${token}`);
    const result: HmmManifest = {
      schemaVersion: SCHEMA_VERSION,
      source: 'interpro',
      status: mismatches.length > 0 ? 'partial' : 'ok',
      cache: 'download',
      requested: { accession: requested.base, ...(requested.requestedVersion ? { version: requested.requestedVersion } : {}) },
      accession: requested.base,
      hmmAccession: fetched.parsed.hmmAccession,
      name: fetched.parsed.name,
      description: fetched.parsed.description,
      length: fetched.parsed.length,
      interproVersion: version.version,
      interproVersionMinor: version.minor,
      md5: hmmMd5,
      sha256: sha256(fetched.text),
      bytes: Buffer.byteLength(fetched.text, 'utf8'),
      expectedMd5,
      mismatches,
      warnings,
      upstream: fetched.upstream,
      local: { directory, hmmPath, manifestPath },
      fetchedAt: new Date(deps.now()).toISOString(),
      durationMs: deps.now() - started,
    };
    try {
      writeFileSync(hmmTemp, fetched.text, 'utf8');
      writeFileSync(manifestTemp, `${JSON.stringify(result, null, 2)}\n`, 'utf8');
      rmSync(hmmPath, { force: true });
      renameSync(hmmTemp, hmmPath);
      renameSync(manifestTemp, manifestPath);
    } catch (error) {
      rmSync(hmmTemp, { force: true });
      rmSync(manifestTemp, { force: true });
      throw new PlantOmicsError(
        `HMM 落盘失败：${error instanceof Error ? error.message : String(error)}（缓存目录 ${directory}）`,
      );
    }
    return { hmm: fetched.text, manifest: { ...result, durationMs: deps.now() - started } };
  })().finally(() => inFlight.delete(key));
  inFlight.set(key, task);
  return task;
}

function manifestText(result: HmmManifest): string {
  const version = result.interproVersion ?? '未知（响应头未提供）';
  const cacheLabel = result.cache === 'hit' ? '命中本地缓存（未联网）' : '新下载';
  const lines = [
    `InterPro/Pfam HMM：${result.accession}（请求 ${result.requested.accession}${result.requested.version ? `.${result.requested.version}` : ''}）`,
    `状态：${result.status === 'ok' ? 'ok' : 'partial（与历史基线不一致，见下）'}`,
    `条目：${result.hmmAccession}｜${result.name ?? 'NAME 缺失'}｜${result.length === null ? 'LENG 缺失' : `${result.length} 个位置`}`,
    `InterPro 版本：${version}${result.interproVersionMinor ? `（minor ${result.interproVersionMinor}）` : ''}`,
    `md5：${result.md5}${result.expectedMd5 ? `（基线 ${result.expectedMd5}${result.md5 === result.expectedMd5 ? '，一致' : '，不一致'}）` : '（该 accession 无历史基线）'}`,
    `sha256：${result.sha256}`,
    `大小：${formatInt(result.bytes)} B 正文｜上游 ${formatInt(result.upstream.bytes)} B`,
    `缓存：${cacheLabel} · 耗时 ${formatInt(result.durationMs)} ms · ${result.local.hmmPath}`,
    `取数时间：${result.fetchedAt}`,
    `完整 HMM 正文在 structuredContent.hmm（${formatInt(result.bytes)} B），正文预算 1,408 B 放不下。`,
  ];
  if (result.warnings.length > 0) lines.push(`⚠️ ${result.warnings.join('\n⚠️ ')}`);
  return lines.join('\n');
}

function toolResult(result: HmmManifest, hmm: string) {
  const prepared = prepareRequest({ url: result.upstream.url, sourceName: manifest.displayName });
  const res: HttpResult = {
    data: null,
    url: result.upstream.url,
    status: result.upstream.status,
    durationMs: result.durationMs,
    attempts: 1,
    contentType: result.upstream.contentType ?? undefined,
  };
  return finishResult({
    body: manifestText(result),
    res,
    prepared,
    sourceId: manifest.id,
    raw: {
      accession: result.accession,
      hmm_accession: result.hmmAccession,
      interpro_version: result.interproVersion,
      md5: result.md5,
      bytes: result.bytes,
      status: result.status,
      cache: result.cache,
    },
    structured: { ...(result as unknown as Record<string, unknown>), hmm },
    extra: 'HMM 正文在 structuredContent.hmm；缓存文件可直接交给本地 HMMER（hmmsearch --hmm）',
  });
}

export function createInterproHmmTool(options: HmmOptions = {}): ToolDefinition {
  const deps: RunDeps = {
    fetch: options.fetchImpl ?? ((...args) => globalThis.fetch(...args)),
    cacheRoot: options.cacheRoot ?? defaultCacheRoot(),
    now: options.now ?? (() => Date.now()),
  };
  return {
    name: 'interpro_get_hmm',
    description:
      '按 Pfam accession 取一个结构域的 HMM 模型正文（HMMER3 文本），用于本地 HMMER 做基因家族成员鉴定。'
      + 'accession 接受 PF00319 或 PF00319.25（大小写不敏感）；返回规范化 accession、HMM 的 ACC 版本、'
      + 'InterPro 版本（interpro-version 响应头）、正文 md5/sha256、取数时间与缓存路径。'
      + 'HMM 正文几十 KB，放在 structuredContent.hmm（正文预算 1,408 B 放不下，正文只给 manifest）。'
      + '默认缓存 ~/.cache/plantomics/interpro/pfam/，命中不联网；refresh=true 强制重取。'
      + '只取单条 HMM，不批量、不按物种查询；不返回 Pfam 比对结果或成员蛋白清单。',
    parameters: {
      type: 'object',
      properties: {
        accession: {
          type: 'string',
          description: 'Pfam 编号，例如 PF00319 或 PF00319.25（大小写不敏感；不接受 IPR 集成编号）',
        },
        refresh: { type: 'boolean', default: false, description: 'true = 忽略本地缓存，强制重新下载' },
      },
      required: ['accession'],
      additionalProperties: false,
    },
    async run(args, ctx) {
      const result = await runHmm(args, ctx, deps);
      return toolResult(result.manifest, result.hmm);
    },
  };
}

export const hmmTool = createInterproHmmTool();

export const tools: ToolDefinition[] = [hmmTool];
