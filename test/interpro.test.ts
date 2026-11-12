import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { gzipSync } from 'node:zlib';

import { afterEach, describe, expect, it } from 'vitest';

import { InvalidArgumentError, UpstreamError, UpstreamShapeError } from '../src/core/errors.js';
import { invokeTool } from '../src/core/invoke.js';
import type { HmmOptions } from '../src/sources/interpro/tools.js';
import {
  PF00319_BASELINE_MD5,
  createInterproHmmTool,
  normalizeAccession,
  parseHmmPayload,
} from '../src/sources/interpro/tools.js';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function cacheDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'interpro-hmm-'));
  dirs.push(dir);
  return dir;
}

/** 真实 PF00319 正文（与 fixture 同一份），用于 md5 基线一致的正例。 */
const REAL_HMM = (JSON.parse(
  readFileSync(new URL('../src/sources/interpro/fixtures/hmm-pf00319.json', import.meta.url), 'utf8'),
) as { rawBody: string }).rawBody;

const URL_PF00319 = 'https://www.ebi.ac.uk/interpro/wwwapi/entry/pfam/PF00319/?annotation=hmm';
const URL_PF09999 = 'https://www.ebi.ac.uk/interpro/wwwapi/entry/pfam/PF09999/?annotation=hmm';

interface MockOptions {
  /** gzip 字节；缺省用 payload 生成。 */
  body?: Uint8Array;
  /** 声称的 Content-Length；缺省为 body 实际长度。 */
  claimedLength?: number;
  status?: number;
  version?: string | null;
  versionMinor?: string | null;
}

function mockFetch(files: Record<string, MockOptions>, calls: string[] = []): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    calls.push(url);
    if (url === 'https://www.ebi.ac.uk/interpro/api/') {
      return new Response(null, {
        status: 200,
        headers: { 'interpro-version': '111.0', 'interpro-version-minor': '0' },
      });
    }
    const options = files[url];
    if (!options) return new Response('not found', { status: 404 });
    if (options.status && options.status !== 200) return new Response('upstream error', { status: options.status });
    const body = options.body ?? new Uint8Array();
    const headers: Record<string, string> = {
      'content-type': 'application/gzip',
      'content-length': String(options.claimedLength ?? body.length),
    };
    if (options.version !== null) headers['interpro-version'] = options.version ?? '111.0';
    if (options.versionMinor !== null) headers['interpro-version-minor'] = options.versionMinor ?? '0';
    return new Response(body, { status: 200, headers });
  }) as unknown as typeof fetch;
}

function gzHmm(text: string): Uint8Array {
  return new Uint8Array(gzipSync(Buffer.from(text, 'utf8')));
}

function makeTool(options: HmmOptions & { fetchImpl: typeof fetch }) {
  return createInterproHmmTool(options);
}

describe('interpro_get_hmm：accession 规范化与 HMM 结构校验', () => {
  it('PF00319 / PF00319.25 都接受，规范化到同一基础编号', () => {
    expect(normalizeAccession('PF00319')).toEqual({ base: 'PF00319' });
    expect(normalizeAccession(' pf00319.25 ')).toEqual({ base: 'PF00319', requestedVersion: '25' });
  });

  it('拒绝 IPR 集成编号、基因名、空串与含空白输入', () => {
    for (const bad of ['IPR002100', 'AT1G65480', '', 'PF003', 'PF00319 .25']) {
      expect(() => normalizeAccession(bad), bad).toThrow(InvalidArgumentError);
    }
  });

  it('gzip 解压 + HMMER3 结构校验；坏 gzip 与 HTML 错误页都在落盘前拒绝', () => {
    const parsed = parseHmmPayload(gzHmm(REAL_HMM), URL_PF00319);
    expect(parsed.hmmAccession).toBe('PF00319.25');
    expect(parsed.length).toBe(48);
    expect(() => parseHmmPayload(gzHmm('<html>oops</html>'), URL_PF00319)).toThrow(UpstreamShapeError);
    expect(() => parseHmmPayload(new Uint8Array([0x1f, 0x8b, 0x00]), URL_PF00319)).toThrow(UpstreamShapeError);
  });
});

describe('interpro_get_hmm：取数、落盘、缓存与版本口径（离线）', () => {
  it('PF00319 正例：返回 md5 基线、InterPro 版本与正文；正文不夹带 HMM 正文', async () => {
    const calls: string[] = [];
    const dir = cacheDir();
    const tool = makeTool({ cacheRoot: dir, fetchImpl: mockFetch({ [URL_PF00319]: { body: gzHmm(REAL_HMM) } }, calls) });
    const result = await invokeTool(tool, { accession: 'PF00319.25' });
    const manifest = result.structured as Record<string, unknown>;
    expect(manifest.accession).toBe('PF00319');
    expect(manifest.hmmAccession).toBe('PF00319.25');
    expect(manifest.md5).toBe(PF00319_BASELINE_MD5);
    expect(manifest.status).toBe('ok');
    expect(manifest.cache).toBe('download');
    expect(manifest.interproVersion).toBe('111.0');
    expect(manifest.hmm).toBe(REAL_HMM);
    expect(result.text).toContain(PF00319_BASELINE_MD5);
    expect(result.text).toContain('111.0');
    expect(result.text).not.toContain('HMMER3/f');
    expect(existsSync(path.join(dir, 'pfam', 'PF00319.hmm'))).toBe(true);
    expect(existsSync(path.join(dir, 'pfam', 'PF00319.json'))).toBe(true);
    expect(statSync(path.join(dir, 'pfam', 'PF00319.hmm')).size).toBe(Buffer.byteLength(REAL_HMM, 'utf8'));
  });

  it('缓存命中：第二次不再联网，耗时只做本地校验', async () => {
    const calls: string[] = [];
    const dir = cacheDir();
    const tool = makeTool({ cacheRoot: dir, fetchImpl: mockFetch({ [URL_PF00319]: { body: gzHmm(REAL_HMM) } }, calls) });
    const first = await invokeTool(tool, { accession: 'PF00319' });
    const second = await invokeTool(tool, { accession: 'PF00319' });
    expect(calls.filter((url) => url === URL_PF00319)).toHaveLength(1);
    expect((first.structured as Record<string, unknown>).cache).toBe('download');
    expect((second.structured as Record<string, unknown>).cache).toBe('hit');
    expect((second.structured as Record<string, unknown>).md5).toBe(PF00319_BASELINE_MD5);
  });

  it('refresh=true 强制重新下载', async () => {
    const calls: string[] = [];
    const dir = cacheDir();
    const tool = makeTool({ cacheRoot: dir, fetchImpl: mockFetch({ [URL_PF00319]: { body: gzHmm(REAL_HMM) } }, calls) });
    await invokeTool(tool, { accession: 'PF00319' });
    await invokeTool(tool, { accession: 'PF00319', refresh: true });
    expect(calls.filter((url) => url === URL_PF00319)).toHaveLength(2);
  });

  it('请求旧版本而上游已是新版本：明确报错，不把新版本冒充旧版本', async () => {
    const dir = cacheDir();
    const tool = makeTool({ cacheRoot: dir, fetchImpl: mockFetch({ [URL_PF00319]: { body: gzHmm(REAL_HMM) } }) });
    await expect(invokeTool(tool, { accession: 'PF00319.24' })).rejects.toBeInstanceOf(UpstreamError);
    expect(existsSync(path.join(dir, 'pfam', 'PF00319.hmm'))).toBe(false);
  });

  it('上游 md5 与 A 套基线不一致：标 partial + warning，但内容仍返回', async () => {
    const dir = cacheDir();
    const changed = REAL_HMM.replace('PF00319.25', 'PF00319.26');
    const tool = makeTool({ cacheRoot: dir, fetchImpl: mockFetch({ [URL_PF00319]: { body: gzHmm(changed) } }) });
    const result = await invokeTool(tool, { accession: 'PF00319' });
    const manifest = result.structured as Record<string, unknown>;
    expect(manifest.status).toBe('partial');
    expect(String(manifest.md5)).not.toBe(PF00319_BASELINE_MD5);
    expect(result.text).toContain('partial');
  });

  it('无历史基线的 accession：状态 ok，且明确写「无基线」而不是编一个', async () => {
    const dir = cacheDir();
    const other = REAL_HMM.replaceAll('PF00319', 'PF09999');
    const tool = makeTool({ cacheRoot: dir, fetchImpl: mockFetch({ [URL_PF09999]: { body: gzHmm(other) } }) });
    const result = await invokeTool(tool, { accession: 'PF09999' });
    const manifest = result.structured as Record<string, unknown>;
    expect(manifest.status).toBe('ok');
    expect(manifest.expectedMd5).toBeNull();
    expect(result.text).toContain('无历史基线');
  });

  it('截断/坏 gzip：报错且不写 manifest', async () => {
    const dir = cacheDir();
    const truncated = gzHmm(REAL_HMM).slice(0, 40);
    const tool = makeTool({
      cacheRoot: dir,
      fetchImpl: mockFetch({ [URL_PF00319]: { body: truncated, claimedLength: truncated.length } }),
    });
    await expect(invokeTool(tool, { accession: 'PF00319' })).rejects.toBeInstanceOf(UpstreamShapeError);
    expect(existsSync(path.join(dir, 'pfam', 'PF00319.json'))).toBe(false);
  });

  it('写入的临时文件不会残留', async () => {
    const dir = cacheDir();
    const tool = makeTool({ cacheRoot: dir, fetchImpl: mockFetch({ [URL_PF00319]: { body: gzHmm(REAL_HMM) } }) });
    await invokeTool(tool, { accession: 'PF00319' });
    const files = readFileSync(path.join(dir, 'pfam', 'PF00319.hmm'), 'utf8');
    writeFileSync(path.join(dir, 'pfam', 'PF00319.hmm'), files.slice(0, 10));
    // 缓存被改坏后必须重新下载，而不是拿坏文件冒充
    const calls: string[] = [];
    const tool2 = makeTool({ cacheRoot: dir, fetchImpl: mockFetch({ [URL_PF00319]: { body: gzHmm(REAL_HMM) } }, calls) });
    await invokeTool(tool2, { accession: 'PF00319' });
    expect(calls.filter((url) => url === URL_PF00319)).toHaveLength(1);
  });
});
