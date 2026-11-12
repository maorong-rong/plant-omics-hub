/**
 * IC4R 2.0 官方整文件导入。
 *
 * 为什么要有这一条：逐条 `ic4r_gene` loop 56,221 条基因约 9.76 h，而且 `ic4r_gene`
 * 自述不含序列；上游下载页却把全物种蛋白/GFF 做成 15.7 MB / 9.8 MB 的整文件，
 * 实测 2.0 s / 2.3 s 就能拿全。**能拿整文件，就不要做 REST 批量**（#65）。
 *
 * 工具的语义刻意不是“取数工具”，而是“下载器 + 落盘 + 交账”：
 *   调用 → 上游文件落到本地缓存 → 返回 manifest（路径/条数/sha256/耗时）。
 * 80,038 条序列不可能、也不该进模型上下文；正文只放 manifest，完整结构放 `structured`。
 *
 * 网络出口的例外：`src/core/http.ts` 的 fetcher 按 JSON 解析正文，15–25 MB 的 gzip
 * 二进制既不能 JSON.parse，也不该整段留在 ToolResult 里。所以本模块自己用 `fetch`
 * 流式落盘；仍是只读 GET/HEAD、同一 UA、同样的超时与 5xx/429 退避口径。
 * 不把它塞回 core：本单边界只允许新增 `src/sources/ic4r/bulk.ts`。
 */

import { createHash, randomUUID } from 'node:crypto';
import {
  closeSync,
  createReadStream,
  createWriteStream,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createGunzip } from 'node:zlib';

import { InvalidArgumentError, PlantOmicsError, UpstreamError, UpstreamShapeError } from '../../core/errors.js';
import { USER_AGENT } from '../../core/http.js';
import { finishResult, prepareRequest } from '../../core/request.js';
import type { HttpResult, ToolContext, ToolDefinition } from '../../core/types.js';
import { manifest } from './manifest.js';

type Dataset = 'protein' | 'gff' | 'cds';

/** v1 基线：2026-11-10 实测（#65 / 缺口报告 E12/E14/E23）。改基线必须写明日期与依据。 */
export interface BulkBaseline {
  /** 上游 gzip 字节数（Content-Length）。 */
  bytes: number;
  /** 上游 ETag 原样值（带引号）。 */
  etag: string;
  /** 上游 Last-Modified 原样值（GMT 字符串）。 */
  lastModified: string;
  /** 完整性校验的期望条数；键是计数口径，值是条数。 */
  records: Record<string, number>;
}

interface DatasetSpec {
  label: string;
  url: string;
  /** 解压后落盘的文件名（消费者直接吃这个）。 */
  dataFile: string;
  /** 上游文件名（缓存里保留原始 gzip，便于复算）。 */
  archiveFile: string;
  kind: 'fasta' | 'gff';
  baseline: BulkBaseline;
}

const ALL_DATA = 'https://download.cncb.ac.cn/bigd/GEN/IC4R-2018/0-All-Data';

/**
 * 三个数据集共用一个工具（`dataset=protein|gff|cds`），而不是三个工具：
 * 保持工具面窄，与“2 元工具 + 按需展开”的架构一致；三者的下载/缓存/校验逻辑完全相同。
 */
export const DATASET_SPECS: Readonly<Record<Dataset, DatasetSpec>> = Object.freeze({
  protein: {
    label: '官方蛋白 FASTA',
    url: `${ALL_DATA}/4-IC4R_2_0_Protein.fa.gz`,
    dataFile: 'proteome.fa',
    archiveFile: 'IC4R_2_0_Protein.fa.gz',
    kind: 'fasta',
    baseline: {
      bytes: 15_735_832,
      etag: '"5efda796-f01c18"',
      lastModified: 'Thu, 02 Jul 2020 09:23:34 GMT',
      records: { protein: 80_038 },
    },
  },
  gff: {
    label: '官方 GFF（蛋白编码基因结构）',
    url: `${ALL_DATA}/1-IC4R_2_0_GFF_Protein_Coding.gff.gz`,
    dataFile: 'genes.gff',
    archiveFile: 'IC4R_2_0_GFF_Protein_Coding.gff.gz',
    kind: 'gff',
    baseline: {
      bytes: 9_815_780,
      etag: '"5efda797-95c6e4"',
      lastModified: 'Thu, 02 Jul 2020 09:23:35 GMT',
      records: {
        gene: 56_221,
        mRNA: 80_038,
        exon: 444_847,
        CDS: 411_528,
        five_prime_UTR: 66_497,
        three_prime_UTR: 65_618,
      },
    },
  },
  cds: {
    label: '官方 CDS FASTA',
    url: `${ALL_DATA}/3-IC4R_2_0_CDS.fa.gz`,
    dataFile: 'cds.fa',
    archiveFile: 'IC4R_2_0_CDS.fa.gz',
    kind: 'fasta',
    baseline: {
      bytes: 24_306_975,
      etag: '"5efda796-172e51f"',
      lastModified: 'Thu, 02 Jul 2020 09:23:34 GMT',
      records: { cds: 80_038 },
    },
  },
});

const SCHEMA_VERSION = 1;
const LOCK_STALE_MS = 15 * 60_000;
const LOCK_WAIT_MS = 30_000;
const HEAD_TIMEOUT_MS = 20_000;
const DOWNLOAD_TIMEOUT_MS = 180_000;
const MAX_ATTEMPTS = 3;
const BACKOFF_MS = [400, 1_200];

export interface BulkOptions {
  /** 测试注入；生产用 globalThis.fetch 的惰性转发。 */
  fetchImpl?: typeof fetch;
  /** 缓存根目录；默认 `$XDG_CACHE_HOME/plantomics/ic4r`（没有 XDG 就 `~/.cache`）。 */
  cacheRoot?: string;
  /** 测试注入/上游改版时重定基线；生产不传。 */
  baseline?: Partial<Record<Dataset, BulkBaseline>>;
  /** 测试注入时钟；生产用 Date.now。 */
  now?: () => number;
}

export interface Ic4rBulkManifest {
  schemaVersion: number;
  source: 'ic4r';
  dataset: Dataset;
  status: 'ok' | 'partial';
  cache: 'download' | 'hit' | 'stale';
  upstream: {
    url: string;
    status: number;
    bytes: number;
    etag: string | null;
    lastModified: string | null;
    contentType: string | null;
  };
  local: {
    directory: string;
    archivePath: string;
    dataPath: string;
    archiveBytes: number;
    dataBytes: number;
    archiveSha256: string;
    dataSha256: string;
  };
  records: Record<string, number>;
  expected: Record<string, number>;
  mismatches: string[];
  warnings: string[];
  fetchedAt: string;
  durationMs: number;
  versionNote: string;
}

interface RunDeps {
  fetch: typeof fetch;
  cacheRoot: string;
  specs: Record<Dataset, DatasetSpec>;
  now: () => number;
}

interface UpstreamIdentity {
  bytes: number | null;
  etag: string | null;
  lastModified: string | null;
  contentType: string | null;
}

interface ValidationResult {
  records: Record<string, number>;
  mismatches: string[];
  warnings: string[];
}

const inFlight = new Map<string, Promise<Ic4rBulkManifest>>();

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function formatInt(value: number): string {
  return String(value).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

function defaultCacheRoot(): string {
  const configured = process.env.PLANTOMICS_CACHE_DIR?.trim();
  if (configured) return path.join(path.resolve(configured), 'ic4r');
  const base = process.env.XDG_CACHE_HOME?.trim() || path.join(homedir(), '.cache');
  return path.join(base, 'plantomics', 'ic4r');
}

function datasetArg(args: Record<string, unknown>): Dataset {
  const raw = args.dataset;
  if (typeof raw !== 'string') throw new InvalidArgumentError('参数 dataset 必须是字符串');
  if (raw !== raw.trim()) {
    throw new InvalidArgumentError('参数 dataset 首尾含空白；本仓不改写输入，请去掉空白后重试（尚未联网）');
  }
  if (!Object.hasOwn(DATASET_SPECS, raw)) {
    throw new InvalidArgumentError(`参数 dataset 只接受 protein / gff / cds，收到「${raw.slice(0, 32)}」（尚未联网）`);
  }
  return raw as Dataset;
}

function refreshArg(args: Record<string, unknown>): boolean {
  const raw = args.refresh;
  if (raw === undefined || raw === null) return false;
  if (typeof raw !== 'boolean') throw new InvalidArgumentError('参数 refresh 必须是布尔值');
  return raw;
}

function outputDirArg(args: Record<string, unknown>): string | undefined {
  const raw = args.output_dir;
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== 'string') throw new InvalidArgumentError('参数 output_dir 必须是字符串');
  const trimmed = raw.trim();
  if (!trimmed) throw new InvalidArgumentError('参数 output_dir 不能为空（尚未联网）');
  if (trimmed.includes('\u0000')) throw new InvalidArgumentError('参数 output_dir 含 NUL，拒绝作为路径（尚未联网）');
  return path.resolve(trimmed);
}

function upstreamError(url: string, status: number, attempt: number): UpstreamError {
  const suffix = status === 404
    ? '上游 404：文件或端点不存在（源改版时也会这样）'
    : status === 403
      ? '上游 403：被 WAF/Cloudflare 拦截，或需要鉴权'
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

function combineSignal(external: AbortSignal | undefined): {
  signal: AbortSignal;
  cancel: (reason: 'timeout' | 'caller') => void;
  cleanup: () => void;
  reason: () => 'timeout' | 'caller' | null;
} {
  const controller = new AbortController();
  let reason: 'timeout' | 'caller' | null = null;
  const onAbort = () => {
    reason = 'caller';
    controller.abort();
  };
  if (external) {
    if (external.aborted) onAbort();
    else external.addEventListener('abort', onAbort, { once: true });
  }
  return {
    signal: controller.signal,
    cancel: (why) => {
      reason = why;
      controller.abort();
    },
    cleanup: () => external?.removeEventListener('abort', onAbort),
    reason: () => reason,
  };
}

async function requestOnce(
  url: string,
  method: 'HEAD' | 'GET',
  timeoutMs: number,
  external: AbortSignal | undefined,
  fetchImpl: typeof fetch,
): Promise<Response> {
  const combined = combineSignal(external);
  const timer = setTimeout(() => combined.cancel('timeout'), timeoutMs);
  try {
    return await fetchImpl(url, {
      method,
      redirect: 'follow',
      signal: combined.signal,
      headers: { accept: '*/*', 'user-agent': USER_AGENT },
    });
  } catch (error) {
    if (combined.reason() === 'caller') {
      throw new UpstreamError('调用方已取消本次请求', { url, request: `GET ${url}` });
    }
    if (combined.reason() === 'timeout') {
      throw new UpstreamError(`上游请求超时（${timeoutMs} ms）`, { url, request: `GET ${url}` });
    }
    throw new UpstreamError(`无法连接上游：${error instanceof Error ? error.message : String(error)}`, {
      url,
      request: `GET ${url}`,
    });
  } finally {
    clearTimeout(timer);
    combined.cleanup();
  }
}

async function requestWithRetry(
  url: string,
  method: 'HEAD' | 'GET',
  timeoutMs: number,
  external: AbortSignal | undefined,
  fetchImpl: typeof fetch,
  attempts = MAX_ATTEMPTS,
): Promise<Response> {
  const allowed = Math.max(1, Math.min(attempts, MAX_ATTEMPTS));
  let last: UpstreamError | undefined;
  for (let attempt = 1; attempt <= allowed; attempt += 1) {
    if (attempt > 1) {
      const delay = BACKOFF_MS[Math.min(attempt - 2, BACKOFF_MS.length - 1)] ?? 0;
      await sleep(delay);
    }
    try {
      const response = await requestOnce(url, method, timeoutMs, external, fetchImpl);
      if (response.ok) return response;
      const error = upstreamError(url, response.status, attempt);
      if (isRetryable(response.status) && attempt < allowed) {
        last = error;
        continue;
      }
      throw error;
    } catch (error) {
      if (!(error instanceof UpstreamError)) throw error;
      if (error.meta.status !== undefined && !isRetryable(error.meta.status)) throw error;
      if (attempt >= allowed) throw error;
      last = error;
    }
  }
  throw last ?? new UpstreamError('上游请求失败', { url, request: `GET ${url}` });
}

function identityOf(headers: Headers, fallbackBytes?: number | null): UpstreamIdentity {
  const length = headers.get('content-length');
  const parsed = length === null ? null : Number(length);
  return {
    bytes: Number.isSafeInteger(parsed) && parsed !== null && parsed >= 0 ? parsed : (fallbackBytes ?? null),
    etag: headers.get('etag'),
    lastModified: headers.get('last-modified'),
    contentType: headers.get('content-type'),
  };
}

async function sha256File(file: string): Promise<string> {
  return await new Promise<string>((resolve, reject) => {
    const hash = createHash('sha256');
    createReadStream(file)
      .on('data', (chunk) => hash.update(chunk))
      .on('error', reject)
      .on('end', () => resolve(hash.digest('hex')));
  });
}

async function countFasta(file: string, url: string): Promise<number> {
  const rl = createInterface({ input: createReadStream(file), crlfDelay: Infinity });
  let records = 0;
  let sawHeader = false;
  try {
    for await (const line of rl) {
      if (line.startsWith('>')) {
        records += 1;
        sawHeader = true;
      }
    }
  } finally {
    rl.close();
  }
  if (!sawHeader) {
    throw new UpstreamShapeError('解压后的 FASTA 没有以 “>” 开头的序列头，拒绝写成 manifest', { url });
  }
  return records;
}

async function countGff(file: string, url: string): Promise<Record<string, number>> {
  const rl = createInterface({ input: createReadStream(file), crlfDelay: Infinity });
  const records: Record<string, number> = {};
  let badLines = 0;
  let dataLines = 0;
  try {
    for await (const line of rl) {
      if (!line || line.startsWith('#')) continue;
      dataLines += 1;
      const columns = line.split('\t');
      if (columns.length < 9) {
        badLines += 1;
        continue;
      }
      const feature = columns[2];
      if (feature) records[feature] = (records[feature] ?? 0) + 1;
    }
  } finally {
    rl.close();
  }
  if (dataLines === 0) throw new UpstreamShapeError('解压后的 GFF 没有数据行，拒绝写成 manifest', { url });
  if (badLines > 0) {
    throw new UpstreamShapeError(`解压后的 GFF 有 ${badLines}/${dataLines} 行不是 9 列，不是已测形态`, { url });
  }
  return records;
}

async function gunzipToFile(source: string, target: string, url: string): Promise<void> {
  try {
    await pipeline(createReadStream(source), createGunzip(), createWriteStream(target));
  } catch (error) {
    throw new UpstreamShapeError(
      `gzip 解压失败：${error instanceof Error ? error.message : String(error)}（截断/坏文件不写 manifest）`,
      { url },
    );
  }
}

function validate(
  spec: DatasetSpec,
  actualRecords: Record<string, number>,
  identity: UpstreamIdentity,
): ValidationResult {
  const key = Object.keys(spec.baseline.records)[0] ?? 'records';
  const records = spec.kind === 'fasta' ? { [key]: actualRecords.records ?? 0 } : actualRecords;
  const mismatches: string[] = [];
  const warnings: string[] = [];
  for (const [name, expected] of Object.entries(spec.baseline.records)) {
    const actual = records[name];
    if (actual !== expected) {
      mismatches.push(`${name}：期望 ${formatInt(expected)}，实际 ${actual === undefined ? '缺失' : formatInt(actual)}`);
    }
  }
  const upstreamChanged = identity.bytes !== spec.baseline.bytes
    || identity.etag !== spec.baseline.etag
    || identity.lastModified !== spec.baseline.lastModified;
  if (upstreamChanged) {
    warnings.push(
      '本次与 v1 基线不一致：上游字节/ETag/Last-Modified 期望 '
        + `${formatInt(spec.baseline.bytes)} / ${spec.baseline.etag} / ${spec.baseline.lastModified}；`
        + `实际 ${identity.bytes === null ? '缺失' : formatInt(identity.bytes)} / ${identity.etag ?? '缺失'} / ${identity.lastModified ?? '缺失'}；`
        + `记录日期 ${new Date().toISOString().slice(0, 10)}（不静默当成正常）`,
    );
  }
  if (mismatches.length > 0) {
    warnings.push(`本次与 v1 基线不一致：期望 ${JSON.stringify(spec.baseline.records)}；实际 ${JSON.stringify(records)}`);
  }
  return { records, mismatches, warnings };
}

function readManifest(file: string): Ic4rBulkManifest | null {
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as Ic4rBulkManifest;
    if (parsed.schemaVersion !== SCHEMA_VERSION || parsed.source !== 'ic4r' || !Array.isArray(parsed.warnings)) return null;
    return parsed;
  } catch {
    return null;
  }
}

async function cacheIsUsable(
  cached: Ic4rBulkManifest | null,
  dataset: Dataset,
  directory: string,
): Promise<boolean> {
  if (!cached || cached.dataset !== dataset || cached.local.directory !== directory) return false;
  try {
    const archive = statSync(cached.local.archivePath);
    const data = statSync(cached.local.dataPath);
    if (archive.size !== cached.local.archiveBytes || data.size !== cached.local.dataBytes) return false;
    if (await sha256File(cached.local.archivePath) !== cached.local.archiveSha256) return false;
    return await sha256File(cached.local.dataPath) === cached.local.dataSha256;
  } catch {
    return false;
  }
}

async function acquireLock(directory: string): Promise<() => void> {
  const lockPath = path.join(directory, '.download.lock');
  const started = Date.now();
  for (;;) {
    try {
      const fd = openSync(lockPath, 'wx');
      writeFileSync(fd, `${JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() })}\n`);
      closeSync(fd);
      return () => {
        try {
          unlinkSync(lockPath);
        } catch {
          /* 已经不存在就不吵 */
        }
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      try {
        const age = Date.now() - statSync(lockPath).mtimeMs;
        if (age > LOCK_STALE_MS) {
          unlinkSync(lockPath);
          continue;
        }
      } catch {
        /* 锁刚被别人删掉：下一轮抢 */
      }
      if (Date.now() - started > LOCK_WAIT_MS) {
        throw new PlantOmicsError(
          `另一个进程正在下载同一数据集（锁文件 ${lockPath}，已等待 ${Math.round((Date.now() - started) / 1000)} s）。`
            + '本工具不会写出半截文件；请等它结束后重试，或删除过期锁。',
        );
      }
      await sleep(250);
    }
  }
}

interface Downloaded {
  identity: UpstreamIdentity;
  archiveTemp: string;
  dataTemp: string;
  archiveBytes: number;
  dataBytes: number;
  archiveSha256: string;
  dataSha256: string;
  records: Record<string, number>;
}

async function downloadAttempt(
  deps: RunDeps,
  spec: DatasetSpec,
  directory: string,
  signal: AbortSignal | undefined,
): Promise<Downloaded> {
  const token = `${process.pid}-${randomUUID().slice(0, 8)}`;
  const archiveTemp = path.join(directory, `.${spec.archiveFile}.part-${token}`);
  const dataTemp = path.join(directory, `.${spec.dataFile}.part-${token}`);
  const cleanup = () => {
    rmSync(archiveTemp, { force: true });
    rmSync(dataTemp, { force: true });
  };
  try {
    const response = await requestWithRetry(spec.url, 'GET', DOWNLOAD_TIMEOUT_MS, signal, deps.fetch);
    const identity = identityOf(response.headers);
    if (!response.body) throw new UpstreamShapeError('上游 200 但没有响应正文，无法写文件', { url: spec.url });
    await pipeline(
      Readable.fromWeb(response.body as unknown as import('node:stream/web').ReadableStream<Uint8Array>),
      createWriteStream(archiveTemp),
    );
    const archiveBytes = statSync(archiveTemp).size;
    if (archiveBytes === 0) throw new UpstreamShapeError('下载到的 gzip 是 0 字节，拒绝写 manifest', { url: spec.url });
    if (identity.bytes !== null && identity.bytes !== archiveBytes) {
      throw new UpstreamShapeError(
        `下载不完整：Content-Length=${formatInt(identity.bytes)}，实际落盘 ${formatInt(archiveBytes)} 字节（截断文件不写 manifest）`,
        { url: spec.url },
      );
    }
    identity.bytes = archiveBytes;
    await gunzipToFile(archiveTemp, dataTemp, spec.url);
    const dataBytes = statSync(dataTemp).size;
    if (dataBytes === 0) throw new UpstreamShapeError('解压后的文件是 0 字节，拒绝写 manifest', { url: spec.url });
    const records = spec.kind === 'fasta'
      ? { records: await countFasta(dataTemp, spec.url) }
      : await countGff(dataTemp, spec.url);
    return {
      identity,
      archiveTemp,
      dataTemp,
      archiveBytes,
      dataBytes,
      archiveSha256: await sha256File(archiveTemp),
      dataSha256: await sha256File(dataTemp),
      records,
    };
  } catch (error) {
    cleanup();
    throw error;
  }
}

/**
 * 下载 + 解压 + 计数。传输中断和坏 gzip 都重试：CDS 24 MB 实测出现过
 * `SSL unexpected eof`，只重试“拿到响应头”那一步接不住中途断流。
 */
async function downloadDataset(
  deps: RunDeps,
  spec: DatasetSpec,
  directory: string,
  signal: AbortSignal | undefined,
): Promise<Downloaded> {
  let last: unknown;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    if (attempt > 1) {
      const delay = BACKOFF_MS[Math.min(attempt - 2, BACKOFF_MS.length - 1)] ?? 0;
      await sleep(delay);
    }
    try {
      return await downloadAttempt(deps, spec, directory, signal);
    } catch (error) {
      last = error;
      if (error instanceof UpstreamError && error.meta.status !== undefined && !isRetryable(error.meta.status)) throw error;
      if (attempt >= MAX_ATTEMPTS) throw error;
    }
  }
  throw last;
}

async function runBulk(
  args: Record<string, unknown>,
  ctx: ToolContext,
  deps: RunDeps,
): Promise<Ic4rBulkManifest> {
  const dataset = datasetArg(args);
  const refresh = refreshArg(args);
  const spec = deps.specs[dataset];
  const root = outputDirArg(args) ?? deps.cacheRoot;
  const directory = path.join(root, dataset);
  const archivePath = path.join(directory, spec.archiveFile);
  const dataPath = path.join(directory, spec.dataFile);
  const manifestPath = path.join(directory, 'manifest.json');
  const key = `${directory}\u0000${refresh ? 'refresh' : 'cached'}`;

  const existing = inFlight.get(key);
  if (existing) return existing;
  const task = (async (): Promise<Ic4rBulkManifest> => {
    mkdirSync(directory, { recursive: true });
    const release = await acquireLock(directory);
    try {
      const startedAt = deps.now();
      const cached = readManifest(manifestPath);
      if (!refresh && cached && await cacheIsUsable(cached, dataset, directory)) {
        // 缓存键 = dataset + 上游标识：先做一次 HEAD 核对 ETag/Last-Modified/字节数。
        try {
          const head = await requestWithRetry(spec.url, 'HEAD', HEAD_TIMEOUT_MS, ctx.signal, deps.fetch, 1);
          const identity = identityOf(head.headers, cached.local.archiveBytes);
          const same = identity.etag !== null && identity.etag === cached.upstream.etag
            && identity.lastModified === cached.upstream.lastModified
            && identity.bytes === cached.local.archiveBytes;
          if (same) {
            return {
              ...cached,
              cache: 'hit',
              durationMs: deps.now() - startedAt,
              upstream: {
                ...cached.upstream,
                status: head.status,
                bytes: identity.bytes ?? cached.upstream.bytes,
                etag: identity.etag,
                lastModified: identity.lastModified,
                contentType: identity.contentType ?? cached.upstream.contentType,
              },
            };
          }
        } catch (error) {
          // 上游暂时不可达时，本地缓存仍可交付；但必须如实标注“未能核对上游身份”。
          return {
            ...cached,
            cache: 'stale',
            durationMs: deps.now() - startedAt,
            warnings: [
              ...cached.warnings,
              `缓存命中但未能核对上游身份（${error instanceof Error ? error.message : String(error)}）；本地 gzip/解压文件 sha256 已复核`,
            ],
          };
        }
      }

      const download = await downloadDataset(deps, spec, directory, ctx.signal);
      const validation = validate(spec, download.records, download.identity);
      const status = validation.mismatches.length > 0 || validation.warnings.length > 0 ? 'partial' : 'ok';
      // 先落文件，再落 manifest：任一文件失败时目录里不会出现“manifest 说成功但文件不在”。
      rmSync(archivePath, { force: true });
      rmSync(dataPath, { force: true });
      renameSync(download.archiveTemp, archivePath);
      renameSync(download.dataTemp, dataPath);
      const result: Ic4rBulkManifest = {
        schemaVersion: SCHEMA_VERSION,
        source: 'ic4r',
        dataset,
        status,
        cache: 'download',
        upstream: {
          url: spec.url,
          status: 200,
          bytes: download.archiveBytes,
          etag: download.identity.etag,
          lastModified: download.identity.lastModified,
          contentType: download.identity.contentType,
        },
        local: {
          directory,
          archivePath,
          dataPath,
          archiveBytes: download.archiveBytes,
          dataBytes: download.dataBytes,
          archiveSha256: download.archiveSha256,
          dataSha256: download.dataSha256,
        },
        records: validation.records,
        expected: spec.baseline.records,
        mismatches: validation.mismatches,
        warnings: validation.warnings,
        fetchedAt: new Date(deps.now()).toISOString(),
        durationMs: deps.now() - startedAt,
        versionNote: 'IC4R 2.0（上游文件 Last-Modified 2020-07-02；文档声明 2018-05）',
      };
      writeFileSync(manifestPath, `${JSON.stringify(result, null, 2)}\n`, 'utf8');
      return result;
    } finally {
      release();
    }
  })().finally(() => inFlight.delete(key));
  inFlight.set(key, task);
  return task;
}

function manifestText(result: Ic4rBulkManifest): string {
  const spec = DATASET_SPECS[result.dataset];
  const format = (records: Record<string, number>) => Object.entries(records)
    .map(([key, value]) => `${key} ${formatInt(value)}`)
    .join(' / ');
  const cacheLabel = result.cache === 'hit' ? '命中缓存，未重复下载' : result.cache === 'stale' ? '缓存（未能核对上游）' : '新下载';
  const lines = [
    `IC4R 整文件导入：${spec.label}（dataset=${result.dataset}）`,
    `状态：${result.status === 'ok' ? 'ok（条数与 v1 基线一致）' : 'partial（与 v1 基线不一致，见下）'}`,
    `上游：${formatInt(result.upstream.bytes)} B · ETag ${result.upstream.etag ?? '缺失'} · Last-Modified ${result.upstream.lastModified ?? '缺失'}`,
    `本地：${result.local.dataPath}（${formatInt(result.local.dataBytes)} B）`,
    `sha256：${result.local.dataSha256}`,
    `记录：${format(result.records)}（期望 ${format(result.expected)}）`,
    `缓存：${cacheLabel} · 耗时 ${formatInt(result.durationMs)} ms`,
  ];
  if (result.warnings.length > 0) lines.push(`⚠️ ${result.warnings.join('\n⚠️ ')}`);
  return lines.join('\n');
}

function toolResult(result: Ic4rBulkManifest) {
  const spec = DATASET_SPECS[result.dataset];
  const prepared = prepareRequest({ url: spec.url, sourceName: manifest.displayName });
  const res: HttpResult = {
    data: null,
    url: spec.url,
    status: result.upstream.status,
    durationMs: result.durationMs,
    attempts: 1,
    contentType: result.upstream.contentType ?? undefined,
  };
  return finishResult({
    body: manifestText(result),
    res,
    raw: { dataset: result.dataset, status: result.status, records: result.records },
    structured: result as unknown as Record<string, unknown>,
    prepared,
    sourceId: manifest.id,
    extra: '官方整文件导入；正文只给 manifest，序列在本地文件，不进模型上下文',
  });
}

/**
 * 造工具。测试用 `options` 注入 fetch / 缓存目录；生产直接 `createIc4rBulkTool()`。
 */
export function createIc4rBulkTool(options: BulkOptions = {}): ToolDefinition {
  const specs: Record<Dataset, DatasetSpec> = {
    protein: { ...DATASET_SPECS.protein, baseline: { ...DATASET_SPECS.protein.baseline, records: { ...DATASET_SPECS.protein.baseline.records } } },
    gff: { ...DATASET_SPECS.gff, baseline: { ...DATASET_SPECS.gff.baseline, records: { ...DATASET_SPECS.gff.baseline.records } } },
    cds: { ...DATASET_SPECS.cds, baseline: { ...DATASET_SPECS.cds.baseline, records: { ...DATASET_SPECS.cds.baseline.records } } },
  };
  for (const [key, baseline] of Object.entries(options.baseline ?? {})) {
    if (baseline) specs[key as Dataset] = { ...specs[key as Dataset], baseline };
  }
  const deps: RunDeps = {
    fetch: options.fetchImpl ?? ((...args) => globalThis.fetch(...args)),
    cacheRoot: options.cacheRoot ?? defaultCacheRoot(),
    specs,
    now: options.now ?? (() => Date.now()),
  };

  return {
    name: 'ic4r_bulk_download',
    description:
      '下载 IC4R 2.0 官方整文件到本地缓存，返回 manifest（路径/条数/sha256/耗时），不把序列内容放进上下文。'
      + 'dataset=protein 得 80,038 条蛋白 FASTA；gff 得 56,221 gene / 444,847 exon / 80,038 mRNA；cds 得 80,038 条 CDS。'
      + '默认缓存 ~/.cache/plantomics/ic4r/<dataset>/，命中有 HEAD 身份校验且不重复下载；refresh=true 强制重新下载。'
      + '上游改版导致条数/字节与 v1 基线不一致时返回 partial 与 warning，不静默通过。只读 GET/HEAD，不写上游。',
    parameters: {
      type: 'object',
      properties: {
        dataset: {
          type: 'string',
          enum: ['protein', 'gff', 'cds'],
          description: '要导入的官方整文件：protein / gff / cds',
        },
        refresh: { type: 'boolean', default: false, description: 'true = 忽略本地缓存，强制重新下载' },
        output_dir: {
          type: 'string',
          description: '缓存根目录（可选；默认 $XDG_CACHE_HOME/plantomics/ic4r，未设则 ~/.cache/plantomics/ic4r）',
        },
      },
      required: ['dataset'],
      additionalProperties: false,
    },
    async run(args, ctx) {
      const result = await runBulk(args, ctx, deps);
      return toolResult(result);
    },
  };
}

export const bulkDownload = createIc4rBulkTool();
