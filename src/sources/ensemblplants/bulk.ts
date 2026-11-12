/**
 * Ensembl Plants 参考蛋白整文件出口（参考蛋白整文件出口）。
 *
 * 语义与 `ic4r/bulk.ts`（G2）相同：**下载器 + 落盘 + 交账**，不是"把 30 MB 序列塞进上下文"。
 *   species → 上游 `*.pep.all.fa.gz` 落到本地缓存 → 解压、数条数、算 sha256/md5 → 返回 manifest。
 *
 * 为什么这是 Ensembl Plants 的出口而不是新源：Ensembl Plants 早已是 10 源之一，
 * 这里只是给它补一个 bulk 出口（参考蛋白不按基因 ID 一条条查）。
 *
 * 完整性自校验（参考蛋白整文件出口）：
 *   1. Content-Length 与落盘字节不一致 → 报错，不写 manifest；
 *   2. gzip 解压失败（截断/坏文件）→ 报错，不写 manifest；
 *   3. 解压后条数与 release 57 基线不一致 → `status: partial` + mismatch，**不静默通过**；
 *   4. 上游 gzip 的 md5 与基线不一致 → `partial`，明确写"上游文件已变"。
 *
 * 基线来源（2026-11-10 本机实测，release 57）：
 *   拟南芥 TAIR10  gzip 9,679,023 B / md5 3773443a163f24a365f664843d4cadae / 48,321 条
 *   水稻 IRGSP-1.0 gzip 9,044,140 B / md5 d307e841a70ce3ce453b0385028c5fcd / 42,582 条
 * 条数口径是 `pep.all` 的**翻译本数**（含可变剪接转录本），不是基因数。
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

export interface ReferenceBaseline {
  /** 上游 gzip 字节数。 */
  bytes: number;
  /** 上游 gzip md5（验收要求与 3773443a… 一致）。 */
  md5: string;
  /** 上游 gzip sha256。 */
  sha256: string;
  /** 解压后字节数。 */
  dataBytes: number;
  /** 解压后 sha256。 */
  dataSha256: string;
  /** 完整性校验的期望条数。 */
  records: Record<string, number>;
}

export interface SpeciesSpec {
  label: string;
  /** 默认组装名（release 57 实测）；可被 assembly 参数覆盖。 */
  assembly: string;
  baseline: ReferenceBaseline | null;
}

/**
 * 已知物种：给了 release 57 的实测基线。其它物种仍可用，但必须显式给 assembly，
 * 且没有条数基线（完整性只由 Content-Length/gzip 保证）——这是可扩展参数的真实边界。
 */
export const REFERENCE_SPECIES: Readonly<Record<string, SpeciesSpec>> = Object.freeze({
  arabidopsis_thaliana: {
    label: '拟南芥 Arabidopsis thaliana',
    assembly: 'TAIR10',
    baseline: {
      bytes: 9_679_023,
      md5: '3773443a163f24a365f664843d4cadae',
      sha256: '180160e51efec490b9a8511ecf3a683ceacceaa7a989d4a1c6c3079990633cfc',
      dataBytes: 34_393_267,
      dataSha256: '59fd499f091e7c52368d803beb8e1514a18f36001583f8c6fc82c139abdf8b9d',
      records: { protein: 48_321 },
    },
  },
  oryza_sativa: {
    label: '水稻 Oryza sativa',
    assembly: 'IRGSP-1.0',
    baseline: {
      bytes: 9_044_140,
      md5: 'd307e841a70ce3ce453b0385028c5fcd',
      sha256: '6b2d480c10ceefe3a2fa3fb6305eef40c4283d8c5ab1ea17805dc62d8c2cca1e',
      dataBytes: 21_984_251,
      dataSha256: '613aa313a07ff90ed70fb599f1b3d71cbfe24d0970111431466297c01da970d4',
      records: { protein: 42_582 },
    },
  },
});

export const DEFAULT_RELEASE = 57;
export const FTP_BASE = 'https://ftp.ebi.ac.uk/ensemblgenomes/pub/plants';

const SCHEMA_VERSION = 1;
const LOCK_STALE_MS = 15 * 60_000;
const LOCK_WAIT_MS = 30_000;
const DOWNLOAD_TIMEOUT_MS = 240_000;
const MAX_ATTEMPTS = 3;
const BACKOFF_MS = [400, 1_200];

export interface ReferenceOptions {
  fetchImpl?: typeof fetch;
  cacheRoot?: string;
  now?: () => number;
  /** 测试注入：覆盖某些物种的基线（生产不传）。 */
  baseline?: Partial<Record<string, ReferenceBaseline>>;
}

export interface ReferenceManifest {
  schemaVersion: number;
  source: 'ensemblplants';
  dataset: 'reference_protein';
  status: 'ok' | 'partial';
  cache: 'download' | 'hit';
  release: number;
  species: string;
  assembly: string;
  upstream: {
    url: string;
    status: number;
    bytes: number;
    md5: string;
    sha256: string;
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

interface Resolved {
  species: string;
  assembly: string;
  release: number;
  spec: SpeciesSpec;
  url: string;
  archiveFile: string;
  dataFile: string;
}

function formatInt(value: number): string {
  return String(value).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

function defaultCacheRoot(): string {
  const configured = process.env.PLANTOMICS_CACHE_DIR?.trim();
  if (configured) return path.join(path.resolve(configured), 'ensemblplants');
  const base = process.env.XDG_CACHE_HOME?.trim() || path.join(homedir(), '.cache');
  return path.join(base, 'plantomics', 'ensemblplants');
}

function speciesArg(args: Record<string, unknown>): string {
  const raw = args.species;
  if (typeof raw !== 'string') throw new InvalidArgumentError('参数 species 必须是字符串（尚未联网）');
  const value = raw.trim().toLowerCase();
  if (!value) throw new InvalidArgumentError('参数 species 不能为空（尚未联网）');
  if (!/^[a-z][a-z0-9]*(?:_[a-z0-9]+)+$/.test(value)) {
    throw new InvalidArgumentError(
      `参数 species 必须是拉丁名小写加下划线（如 arabidopsis_thaliana / oryza_sativa），收到「${raw.slice(0, 40)}」（尚未联网）`,
    );
  }
  return value;
}

function assemblyArg(args: Record<string, unknown>, spec: SpeciesSpec): string {
  const raw = args.assembly;
  if (raw === undefined || raw === null || raw === '') return spec.assembly;
  if (typeof raw !== 'string') throw new InvalidArgumentError('参数 assembly 必须是字符串（尚未联网）');
  const value = raw.trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/.test(value)) {
    throw new InvalidArgumentError(`参数 assembly 形态非法：${value.slice(0, 40)}（尚未联网）`);
  }
  return value;
}

function releaseArg(args: Record<string, unknown>): number {
  const raw = args.release;
  if (raw === undefined || raw === null) return DEFAULT_RELEASE;
  if (typeof raw !== 'number' || !Number.isSafeInteger(raw) || raw < 1 || raw > 999) {
    throw new InvalidArgumentError('参数 release 必须是 1–999 的整数（尚未联网）');
  }
  return raw;
}

function refreshArg(raw: unknown): boolean {
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

function titleCaseSpecies(species: string): string {
  return species.split('_').map((part, i) => (i === 0 ? part.charAt(0).toUpperCase() + part.slice(1) : part)).join('_');
}

function resolveSpec(
  args: Record<string, unknown>,
  baselines: Readonly<Record<string, ReferenceBaseline | null>>,
): Resolved {
  const species = speciesArg(args);
  const known = REFERENCE_SPECIES[species];
  const spec: SpeciesSpec = {
    label: known?.label ?? `${species}（未登记基线）`,
    assembly: known?.assembly ?? '',
    baseline: baselines[species] ?? null,
  };
  const assembly = assemblyArg(args, spec);
  if (!assembly) {
    throw new InvalidArgumentError(
      `物种 ${species} 没有内置默认组装（只有 ${Object.keys(REFERENCE_SPECIES).join(' / ')}）。`
        + '请显式给 assembly，例如 assembly="TAIR10"（尚未联网）',
    );
  }
  const release = releaseArg(args);
  // 基线只对「默认组装 + release 57」成立；换组装或换 release 时文件名指向另一份
  // 上游文件，拿旧基线去比只会制造假的 partial。
  const baseline = known && assembly === known.assembly && release === DEFAULT_RELEASE
    ? baselines[species] ?? null
    : null;
  const fileStem = `${titleCaseSpecies(species)}.${assembly}.pep.all.fa`;
  return {
    species,
    assembly,
    release,
    spec: { ...spec, baseline },
    url: `${FTP_BASE}/release-${release}/fasta/${species}/pep/${fileStem}.gz`,
    archiveFile: `${fileStem}.gz`,
    dataFile: fileStem,
  };
}

function hashFile(file: string, algorithm: 'md5' | 'sha256'): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const hash = createHash(algorithm);
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
  if (!sawHeader) throw new UpstreamShapeError('解压后的 FASTA 没有以 “>” 开头的序列头，拒绝写成 manifest', { url });
  return records;
}

function upstreamError(url: string, status: number, attempt: number): UpstreamError {
  const suffix = status === 404
    ? '上游 404：该 release / 物种 / 组装的文件不存在（先核对文件名与目录）'
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

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

async function requestWithRetry(
  url: string,
  signal: AbortSignal | undefined,
  fetchImpl: typeof fetch,
): Promise<Response> {
  let last: unknown;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    if (attempt > 1) await sleep(BACKOFF_MS[Math.min(attempt - 2, BACKOFF_MS.length - 1)] ?? 0);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), DOWNLOAD_TIMEOUT_MS);
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
        headers: { accept: '*/*', 'user-agent': USER_AGENT },
      });
      if (!response.ok) {
        const error = upstreamError(url, response.status, attempt);
        if (isRetryable(response.status) && attempt < MAX_ATTEMPTS) {
          last = error;
          continue;
        }
        throw error;
      }
      return response;
    } catch (error) {
      last = error;
      if (error instanceof UpstreamError) {
        if (error.meta.status !== undefined && !isRetryable(error.meta.status)) throw error;
        if (attempt >= MAX_ATTEMPTS) throw error;
        continue;
      }
      if (controller.signal.aborted && !signal?.aborted) {
        const timeout = new UpstreamError(`上游请求超时（${DOWNLOAD_TIMEOUT_MS} ms）`, { url, request: `GET ${url}` });
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

function readManifest(file: string): ReferenceManifest | null {
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as ReferenceManifest;
    if (parsed.schemaVersion !== SCHEMA_VERSION || parsed.source !== 'ensemblplants' || !Array.isArray(parsed.warnings)) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

async function cacheIsUsable(
  cached: ReferenceManifest | null,
  resolved: Resolved,
  directory: string,
): Promise<boolean> {
  if (!cached || cached.species !== resolved.species || cached.assembly !== resolved.assembly
    || cached.release !== resolved.release || cached.local.directory !== directory) return false;
  try {
    const archive = statSync(cached.local.archivePath);
    const data = statSync(cached.local.dataPath);
    if (archive.size !== cached.local.archiveBytes || data.size !== cached.local.dataBytes) return false;
    return await hashFile(cached.local.archivePath, 'sha256') === cached.local.archiveSha256
      && await hashFile(cached.local.dataPath, 'sha256') === cached.local.dataSha256;
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
          `另一个进程正在下载同一参考蛋白文件（锁文件 ${lockPath}，已等待 ${Math.round((Date.now() - started) / 1000)} s）。`
            + '本工具不会写出半截文件；请等它结束后重试，或删除过期锁。',
        );
      }
      await sleep(250);
    }
  }
}

interface Downloaded {
  archiveTemp: string;
  dataTemp: string;
  archiveBytes: number;
  dataBytes: number;
  archiveMd5: string;
  archiveSha256: string;
  dataSha256: string;
  records: number;
  identity: {
    bytes: number | null;
    etag: string | null;
    lastModified: string | null;
    contentType: string | null;
  };
}

async function downloadAttempt(
  resolved: Resolved,
  directory: string,
  signal: AbortSignal | undefined,
  deps: { fetch: typeof fetch },
): Promise<Downloaded> {
  const token = `${process.pid}-${randomUUID().slice(0, 8)}`;
  const archiveTemp = path.join(directory, `.${resolved.archiveFile}.part-${token}`);
  const dataTemp = path.join(directory, `.${resolved.dataFile}.part-${token}`);
  const cleanup = () => {
    rmSync(archiveTemp, { force: true });
    rmSync(dataTemp, { force: true });
  };
  try {
    const response = await requestWithRetry(resolved.url, signal, deps.fetch);
    const lengthHeader = response.headers.get('content-length');
    const length = lengthHeader === null ? null : Number(lengthHeader);
    const identity = {
      bytes: Number.isSafeInteger(length) && length !== null && length >= 0 ? length : null,
      etag: response.headers.get('etag'),
      lastModified: response.headers.get('last-modified'),
      contentType: response.headers.get('content-type'),
    };
    if (!response.body) throw new UpstreamShapeError('上游 200 但没有响应正文，无法写文件', { url: resolved.url });
    await pipeline(
      Readable.fromWeb(response.body as unknown as import('node:stream/web').ReadableStream<Uint8Array>),
      createWriteStream(archiveTemp),
    );
    const archiveBytes = statSync(archiveTemp).size;
    if (archiveBytes === 0) throw new UpstreamShapeError('下载到的 gzip 是 0 字节，拒绝写 manifest', { url: resolved.url });
    if (identity.bytes !== null && identity.bytes !== archiveBytes) {
      throw new UpstreamShapeError(
        `下载不完整：Content-Length=${formatInt(identity.bytes)}，实际落盘 ${formatInt(archiveBytes)} 字节（截断文件不写 manifest）`,
        { url: resolved.url },
      );
    }
    identity.bytes = archiveBytes;
    await gunzipToFile(archiveTemp, dataTemp, resolved.url);
    const dataBytes = statSync(dataTemp).size;
    if (dataBytes === 0) throw new UpstreamShapeError('解压后的文件是 0 字节，拒绝写 manifest', { url: resolved.url });
    return {
      archiveTemp,
      dataTemp,
      archiveBytes,
      dataBytes,
      archiveMd5: await hashFile(archiveTemp, 'md5'),
      archiveSha256: await hashFile(archiveTemp, 'sha256'),
      dataSha256: await hashFile(dataTemp, 'sha256'),
      records: await countFasta(dataTemp, resolved.url),
      identity,
    };
  } catch (error) {
    cleanup();
    throw error;
  }
}

async function downloadDataset(
  resolved: Resolved,
  directory: string,
  signal: AbortSignal | undefined,
  deps: { fetch: typeof fetch },
): Promise<Downloaded> {
  let last: unknown;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    if (attempt > 1) await sleep(BACKOFF_MS[Math.min(attempt - 2, BACKOFF_MS.length - 1)] ?? 0);
    try {
      return await downloadAttempt(resolved, directory, signal, deps);
    } catch (error) {
      last = error;
      if (error instanceof UpstreamError && error.meta.status !== undefined && !isRetryable(error.meta.status)) throw error;
      if (attempt >= MAX_ATTEMPTS) throw error;
    }
  }
  throw last;
}

function validate(
  resolved: Resolved,
  download: Downloaded,
): { records: Record<string, number>; expected: Record<string, number>; mismatches: string[]; warnings: string[] } {
  const records = { protein: download.records };
  const expected = resolved.spec.baseline?.records ?? {};
  const mismatches: string[] = [];
  const warnings: string[] = [];
  if (resolved.release !== DEFAULT_RELEASE || !resolved.spec.baseline) {
    warnings.push(
      `该物种/组装/release 没有内置条数基线（只对 release ${DEFAULT_RELEASE} 的 `
        + `${Object.keys(REFERENCE_SPECIES).join(' / ')} 有基线）；本次完整性只由 Content-Length 与 gzip 保证，`
        + `条数 ${formatInt(download.records)} 未与历史值比对`,
    );
    return { records, expected, mismatches, warnings };
  }
  const baseline = resolved.spec.baseline;
  for (const [name, value] of Object.entries(baseline.records)) {
    const actual = records[name as 'protein'];
    if (actual !== value) {
      mismatches.push(`${name}：期望 ${formatInt(value)}，实际 ${formatInt(actual)}`);
    }
  }
  if (download.archiveBytes !== baseline.bytes) {
    mismatches.push(`gzip 字节：期望 ${formatInt(baseline.bytes)}，实际 ${formatInt(download.archiveBytes)}`);
  }
  if (download.archiveMd5 !== baseline.md5) {
    mismatches.push(`gzip md5：期望 ${baseline.md5}，实际 ${download.archiveMd5}`);
  }
  if (mismatches.length > 0) {
    warnings.push(
      '本次与 release 57 基线不一致：上游文件已变（release 更新会这样），或物种/组装名指向了另一份文件；'
        + '不静默当成正常',
    );
  }
  return { records, expected, mismatches, warnings };
}

interface RunDeps {
  fetch: typeof fetch;
  cacheRoot: string;
  now: () => number;
  baselines: Readonly<Record<string, ReferenceBaseline | null>>;
}

const inFlight = new Map<string, Promise<ReferenceManifest>>();

async function runReference(
  args: Record<string, unknown>,
  ctx: ToolContext,
  deps: RunDeps,
): Promise<ReferenceManifest> {
  const resolved = resolveSpec(args, deps.baselines);
  const refresh = refreshArg(args.refresh);
  const root = outputDirArg(args) ?? deps.cacheRoot;
  const directory = path.join(root, `release-${resolved.release}`, `${resolved.species}.${resolved.assembly}`);
  const archivePath = path.join(directory, resolved.archiveFile);
  const dataPath = path.join(directory, resolved.dataFile);
  const manifestPath = path.join(directory, 'manifest.json');
  const key = `${directory}\u0000${refresh ? 'refresh' : 'cached'}`;
  const running = inFlight.get(key);
  if (running) return running;

  const task = (async (): Promise<ReferenceManifest> => {
    mkdirSync(directory, { recursive: true });
    const release = await acquireLock(directory);
    try {
      const started = deps.now();
      const cached = readManifest(manifestPath);
      if (!refresh && await cacheIsUsable(cached, resolved, directory)) {
        return { ...(cached as ReferenceManifest), cache: 'hit', durationMs: deps.now() - started };
      }
      const download = await downloadDataset(resolved, directory, ctx.signal, deps);
      const validation = validate(resolved, download);
      const result: ReferenceManifest = {
        schemaVersion: SCHEMA_VERSION,
        source: 'ensemblplants',
        dataset: 'reference_protein',
        status: validation.mismatches.length > 0 ? 'partial' : 'ok',
        cache: 'download',
        release: resolved.release,
        species: resolved.species,
        assembly: resolved.assembly,
        upstream: {
          url: resolved.url,
          status: 200,
          bytes: download.archiveBytes,
          md5: download.archiveMd5,
          sha256: download.archiveSha256,
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
        expected: validation.expected,
        mismatches: validation.mismatches,
        warnings: validation.warnings,
        fetchedAt: new Date(deps.now()).toISOString(),
        durationMs: deps.now() - started,
        versionNote: `Ensembl Plants release ${resolved.release}（基线 2026-11-10 实测 release ${DEFAULT_RELEASE}）`,
      };
      // 先落文件再落 manifest：manifest 存在即说明文件完整。
      rmSync(archivePath, { force: true });
      rmSync(dataPath, { force: true });
      renameSync(download.archiveTemp, archivePath);
      renameSync(download.dataTemp, dataPath);
      writeFileSync(manifestPath, `${JSON.stringify(result, null, 2)}\n`, 'utf8');
      return { ...result, durationMs: deps.now() - started };
    } finally {
      release();
    }
  })().finally(() => inFlight.delete(key));
  inFlight.set(key, task);
  return task;
}

function manifestText(result: ReferenceManifest): string {
  const cacheLabel = result.cache === 'hit' ? '命中缓存（未重复下载）' : '新下载';
  const lines = [
    `Ensembl Plants 参考蛋白：${result.species}｜${result.assembly}｜release ${result.release}`,
    `状态：${result.status === 'ok' ? 'ok' : 'partial（与 release 57 基线不一致，见下）'}`,
    `上游：${formatInt(result.upstream.bytes)} B gzip · md5 ${result.upstream.md5}`,
    `本地：${result.local.dataPath}（${formatInt(result.local.dataBytes)} B）`,
    `条数：protein ${formatInt(result.records.protein ?? 0)}${Object.keys(result.expected).length ? `（期望 ${formatInt(result.expected.protein ?? 0)}）` : '（无内置基线）'}`,
    `sha256：${result.local.dataSha256}`,
    `缓存：${cacheLabel} · 耗时 ${formatInt(result.durationMs)} ms · 取数时间 ${result.fetchedAt}`,
    '完整性：Content-Length 与 gzip 解压均已校验；完整清单在 structuredContent，序列不进上下文。',
  ];
  if (result.mismatches.length > 0) lines.push(`⚠️ ${result.mismatches.join('\n⚠️ ')}`);
  if (result.warnings.length > 0) lines.push(`提示：${result.warnings.join('；')}`);
  return lines.join('\n');
}

function toolResult(result: ReferenceManifest) {
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
      species: result.species,
      assembly: result.assembly,
      release: result.release,
      status: result.status,
      records: result.records,
      data_path: result.local.dataPath,
      sha256: result.local.dataSha256,
    },
    structured: result as unknown as Record<string, unknown>,
    extra: '参考蛋白整文件已落盘；正文只给 manifest，序列不进模型上下文',
  });
}

export function createReferenceProteomeTool(options: ReferenceOptions = {}): ToolDefinition {
  const baselines: Record<string, ReferenceBaseline | null> = {};
  for (const [species, spec] of Object.entries(REFERENCE_SPECIES)) baselines[species] = spec.baseline;
  Object.assign(baselines, options.baseline ?? {});
  const deps: RunDeps = {
    fetch: options.fetchImpl ?? ((...args) => globalThis.fetch(...args)),
    cacheRoot: options.cacheRoot ?? defaultCacheRoot(),
    now: options.now ?? (() => Date.now()),
    baselines,
  };
  return {
    name: 'ensemblplants_reference_proteome',
    description:
      '下载 Ensembl Plants 的参考蛋白整文件（*.pep.all.fa.gz）到本地缓存，返回 manifest（路径/条数/sha256/md5/耗时/release），'
      + '不把几十 MB 序列放进上下文。支持拟南芥（TAIR10，48,321 条）与水稻（IRGSP-1.0，42,582 条）的 release 57 基线；'
      + '其它物种可用 species + assembly 指定（如 zea_mays + Zm-B73-REFERENCE-NAM-5.0），但没有内置条数基线。'
      + '默认缓存 ~/.cache/plantomics/ensemblplants/，命中不重复下载；refresh=true 强制重下。'
      + '解压后条数/字节/md5 与基线不符标 partial，截断或坏 gzip 直接报错且不写 manifest。'
      + '只取整文件，不按基因 ID 查询、不返回单条序列。',
    parameters: {
      type: 'object',
      properties: {
        species: {
          type: 'string',
          description: '拉丁名小写加下划线：arabidopsis_thaliana / oryza_sativa；其它物种需同时给 assembly',
        },
        assembly: {
          type: 'string',
          description: '组装名（可选）：拟南芥默认 TAIR10、水稻默认 IRGSP-1.0；其它物种必填',
        },
        release: {
          type: 'integer',
          minimum: 1,
          maximum: 999,
          default: DEFAULT_RELEASE,
          description: `Ensembl Plants release 号（默认 ${DEFAULT_RELEASE}；基线只覆盖 release ${DEFAULT_RELEASE}）`,
        },
        refresh: { type: 'boolean', default: false, description: 'true = 忽略本地缓存，强制重新下载' },
        output_dir: {
          type: 'string',
          description: '缓存根目录（可选；默认 $XDG_CACHE_HOME/plantomics/ensemblplants，未设则 ~/.cache/plantomics/ensemblplants）',
        },
      },
      required: ['species'],
      additionalProperties: false,
    },
    async run(args, ctx) {
      const result = await runReference(args, ctx, deps);
      return toolResult(result);
    },
  };
}

export const referenceProteome = createReferenceProteomeTool();
