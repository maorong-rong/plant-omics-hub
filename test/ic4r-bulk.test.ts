import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, truncateSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { gzipSync } from 'node:zlib';

import { afterEach, describe, expect, it } from 'vitest';

import { InvalidArgumentError, UpstreamShapeError } from '../src/core/errors.js';
import { invokeTool } from '../src/core/invoke.js';
import type { BulkBaseline, BulkOptions } from '../src/sources/ic4r/bulk.js';
import { createIc4rBulkTool } from '../src/sources/ic4r/bulk.js';

interface Call {
  method: string;
  url: string;
}

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function cacheDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'ic4r-bulk-'));
  dirs.push(dir);
  return dir;
}

function fasta(count: number, prefix: string): Buffer {
  const lines: string[] = [];
  for (let i = 1; i <= count; i += 1) {
    lines.push(`>${prefix}${String(i).padStart(6, '0')} gene=IC4R-OSJ01G000100 test`);
    lines.push('MSSAAGQDNG');
  }
  return Buffer.from(`${lines.join('\n')}\n`, 'utf8');
}

function gff(records: Record<string, number>): Buffer {
  const lines: string[] = [];
  let i = 0;
  for (const [feature, count] of Object.entries(records)) {
    for (let row = 0; row < count; row += 1) {
      i += 1;
      lines.push(`Chr1\tBIGD\t${feature}\t${i}\t${i + 10}\t.\t+\t.\tID=IC4R-OSJ01T000100.1;Parent=IC4R-OSJ01G000100;`);
    }
  }
  return Buffer.from(`${lines.join('\n')}\n`, 'utf8');
}

function specFor(data: Buffer, baseline: BulkBaseline): {
  gz: Buffer;
  baseline: BulkBaseline;
  etag: string;
  lastModified: string;
} {
  const gz = gzipSync(data);
  return {
    gz,
    baseline: { ...baseline, bytes: gz.length },
    etag: baseline.etag,
    lastModified: baseline.lastModified,
  };
}

function mockFetch(files: Record<string, Buffer>, options: {
  calls?: Call[];
  etag?: string;
  lastModified?: string;
  delayMs?: number;
  failGet?: boolean;
  corrupt?: Buffer;
} = {}) {
  const calls = options.calls ?? [];
  const etag = options.etag ?? '"test-etag"';
  const lastModified = options.lastModified ?? 'Thu, 02 Jul 2020 09:23:34 GMT';
  return async (url: string, init?: RequestInit): Promise<Response> => {
    const method = init?.method ?? 'GET';
    calls.push({ method, url });
    if (method === 'HEAD') {
      const body = files[url];
      if (!body) return new Response('not found', { status: 404 });
      return new Response(null, {
        status: 200,
        headers: {
          'content-length': String(options.corrupt?.length ?? body.length),
          etag,
          'last-modified': lastModified,
          'content-type': 'application/octet-stream',
        },
      });
    }
    if (options.failGet) throw new TypeError('simulated network failure');
    if (options.delayMs) await new Promise((resolve) => setTimeout(resolve, options.delayMs));
    const body = options.corrupt ?? files[url];
    if (!body) return new Response('not found', { status: 404 });
    return new Response(body, {
      status: 200,
      headers: {
        'content-length': String(body.length),
        etag,
        'last-modified': lastModified,
        'content-type': 'application/octet-stream',
      },
    });
  };
}

function makeTool(options: BulkOptions & { fetchImpl: typeof fetch }) {
  return createIc4rBulkTool(options);
}

function baseline(bytes: number, records: Record<string, number>): BulkBaseline {
  return { bytes, etag: '"test-etag"', lastModified: 'Thu, 02 Jul 2020 09:23:34 GMT', records };
}

async function runProtein(overrides: Partial<BulkOptions> = {}, data = fasta(3, 'IC4R-OSJ01P'), count = 3) {
  const prepared = specFor(data, baseline(0, { protein: count }));
  const calls: Call[] = [];
  const dir = cacheDir();
  const tool = makeTool({
    cacheRoot: dir,
    baseline: { protein: prepared.baseline },
    fetchImpl: mockFetch({ [toolUrl('protein')]: prepared.gz }, { calls }),
    ...overrides,
  });
  return { tool, dir, calls, prepared };
}

function toolUrl(dataset: 'protein' | 'gff' | 'cds'): string {
  const all = 'https://download.cncb.ac.cn/bigd/GEN/IC4R-2018/0-All-Data';
  if (dataset === 'protein') return `${all}/4-IC4R_2_0_Protein.fa.gz`;
  if (dataset === 'gff') return `${all}/1-IC4R_2_0_GFF_Protein_Coding.gff.gz`;
  return `${all}/3-IC4R_2_0_CDS.fa.gz`;
}

describe('ic4r_bulk_download：整文件下载 + 缓存 + 完整性校验（离线）', () => {
  it('protein 正例：落盘 proteome.fa、manifest 条数正确、正文不夹带序列', async () => {
    const { tool, dir, prepared } = await runProtein();
    const result = await invokeTool(tool, { dataset: 'protein' });
    const manifest = result.structured as Record<string, unknown>;
    expect(manifest.status).toBe('ok');
    expect(manifest.cache).toBe('download');
    expect((manifest.records as Record<string, number>).protein).toBe(3);
    expect((manifest.expected as Record<string, number>).protein).toBe(3);
    const local = manifest.local as Record<string, string | number>;
    expect(existsSync(String(local.dataPath))).toBe(true);
    expect(String(local.dataPath).endsWith('/protein/proteome.fa')).toBe(true);
    expect(readFileSync(String(local.dataPath), 'utf8').match(/^>/gm)).toHaveLength(3);
    expect(result.text).toContain('蛋白');
    expect(result.text).toContain('3');
    expect(result.text).not.toContain('MSSAAGQDNG');
    expect(existsSync(path.join(dir, 'protein', 'manifest.json'))).toBe(true);
    expect(prepared.baseline.bytes).toBeGreaterThan(0);
  });

  it('gff 正例：按 feature 计数并写 genes.gff', async () => {
    const data = gff({ gene: 2, mRNA: 2, exon: 3 });
    const prepared = specFor(data, baseline(0, { gene: 2, mRNA: 2, exon: 3 }));
    const calls: Call[] = [];
    const dir = cacheDir();
    const tool = makeTool({
      cacheRoot: dir,
      baseline: { gff: prepared.baseline },
      fetchImpl: mockFetch({ [toolUrl('gff')]: prepared.gz }, { calls }),
    });
    const result = await invokeTool(tool, { dataset: 'gff' });
    const manifest = result.structured as Record<string, unknown>;
    expect((manifest.records as Record<string, number>)).toMatchObject({ gene: 2, mRNA: 2, exon: 3 });
    expect(readFileSync(path.join(dir, 'gff', 'genes.gff'), 'utf8')).toContain('\texon\t');
    expect(result.text).toContain('exon 3');
  });

  it('缓存命中：第二次只 HEAD，不重复下载 GET', async () => {
    const data = fasta(3, 'IC4R-OSJ01P');
    const prepared = specFor(data, baseline(0, { protein: 3 }));
    const calls: Call[] = [];
    const dir = cacheDir();
    const tool = makeTool({
      cacheRoot: dir,
      baseline: { protein: prepared.baseline },
      fetchImpl: mockFetch({ [toolUrl('protein')]: prepared.gz }, { calls }),
    });
    const first = await invokeTool(tool, { dataset: 'protein' });
    const second = await invokeTool(tool, { dataset: 'protein' });
    expect(calls.filter((call) => call.method === 'GET')).toHaveLength(1);
    expect(calls.filter((call) => call.method === 'HEAD')).toHaveLength(1);
    expect((second.structured as Record<string, unknown>).cache).toBe('hit');
    expect((first.structured as Record<string, unknown>).local).toEqual((second.structured as Record<string, unknown>).local);
  });

  it('refresh=true 强制重新下载', async () => {
    const data = fasta(3, 'IC4R-OSJ01P');
    const prepared = specFor(data, baseline(0, { protein: 3 }));
    const calls: Call[] = [];
    const dir = cacheDir();
    const tool = makeTool({
      cacheRoot: dir,
      baseline: { protein: prepared.baseline },
      fetchImpl: mockFetch({ [toolUrl('protein')]: prepared.gz }, { calls }),
    });
    await invokeTool(tool, { dataset: 'protein' });
    await invokeTool(tool, { dataset: 'protein', refresh: true });
    expect(calls.filter((call) => call.method === 'GET')).toHaveLength(2);
    expect(calls.filter((call) => call.method === 'HEAD')).toHaveLength(0);
  });

  it('缓存文件被截断：拒绝复用，重新下载', async () => {
    const data = fasta(3, 'IC4R-OSJ01P');
    const prepared = specFor(data, baseline(0, { protein: 3 }));
    const calls: Call[] = [];
    const dir = cacheDir();
    const tool = makeTool({
      cacheRoot: dir,
      baseline: { protein: prepared.baseline },
      fetchImpl: mockFetch({ [toolUrl('protein')]: prepared.gz }, { calls }),
    });
    await invokeTool(tool, { dataset: 'protein' });
    truncateSync(path.join(dir, 'protein', 'proteome.fa'), 10);
    await invokeTool(tool, { dataset: 'protein' });
    expect(calls.filter((call) => call.method === 'GET')).toHaveLength(2);
  });

  it('坏 gzip：报错且不写 manifest / 不落最终文件', async () => {
    const bad = Buffer.from('this is not gzip');
    const prepared = specFor(fasta(1, 'IC4R-OSJ01P'), baseline(0, { protein: 1 }));
    const dir = cacheDir();
    const tool = makeTool({
      cacheRoot: dir,
      baseline: { protein: prepared.baseline },
      fetchImpl: mockFetch({ [toolUrl('protein')]: prepared.gz }, { corrupt: bad }),
    });
    await expect(invokeTool(tool, { dataset: 'protein' })).rejects.toBeInstanceOf(UpstreamShapeError);
    expect(existsSync(path.join(dir, 'protein', 'manifest.json'))).toBe(false);
    expect(existsSync(path.join(dir, 'protein', 'proteome.fa'))).toBe(false);
    const leftovers = readdirSync(path.join(dir, 'protein')).filter((name) => name.includes('.part-'));
    expect(leftovers).toEqual([]);
  });

  it('条数与基线不一致：写 partial manifest + warning，不静默成功', async () => {
    const data = fasta(3, 'IC4R-OSJ01P');
    const prepared = specFor(data, baseline(0, { protein: 5 }));
    const dir = cacheDir();
    const tool = makeTool({
      cacheRoot: dir,
      baseline: { protein: prepared.baseline },
      fetchImpl: mockFetch({ [toolUrl('protein')]: prepared.gz }),
    });
    const result = await invokeTool(tool, { dataset: 'protein' });
    const manifest = result.structured as Record<string, unknown>;
    expect(manifest.status).toBe('partial');
    expect((manifest.mismatches as string[])[0]).toContain('期望 5');
    expect((manifest.mismatches as string[])[0]).toContain('实际 3');
    expect(result.text).toContain('partial');
    expect(existsSync(path.join(dir, 'protein', 'manifest.json'))).toBe(true);
  });

  it('过期锁文件（>15 min）会被清理，不永久阻塞', async () => {
    const data = fasta(3, 'IC4R-OSJ01P');
    const prepared = specFor(data, baseline(0, { protein: 3 }));
    const dir = cacheDir();
    const proteinDir = path.join(dir, 'protein');
    mkdirSync(proteinDir, { recursive: true });
    const lock = path.join(proteinDir, '.download.lock');
    writeFileSync(lock, '{}');
    const old = new Date(Date.now() - 2 * 60 * 60_000);
    utimesSync(lock, old, old);
    const tool = makeTool({
      cacheRoot: dir,
      baseline: { protein: prepared.baseline },
      fetchImpl: mockFetch({ [toolUrl('protein')]: prepared.gz }),
    });
    const result = await invokeTool(tool, { dataset: 'protein' });
    expect((result.structured as Record<string, unknown>).status).toBe('ok');
    expect(existsSync(lock)).toBe(false);
  });

  it('并发同名下载：进程内只发一次 GET', async () => {
    const data = fasta(3, 'IC4R-OSJ01P');
    const prepared = specFor(data, baseline(0, { protein: 3 }));
    const calls: Call[] = [];
    const dir = cacheDir();
    const tool = makeTool({
      cacheRoot: dir,
      baseline: { protein: prepared.baseline },
      fetchImpl: mockFetch({ [toolUrl('protein')]: prepared.gz }, { calls, delayMs: 100 }),
    });
    const [a, b] = await Promise.all([
      invokeTool(tool, { dataset: 'protein' }),
      invokeTool(tool, { dataset: 'protein' }),
    ]);
    expect(calls.filter((call) => call.method === 'GET')).toHaveLength(1);
    expect((a.structured as Record<string, unknown>).local).toEqual((b.structured as Record<string, unknown>).local);
  });

  it('参数校验：dataset / refresh / output_dir', async () => {
    const tool = makeTool({ cacheRoot: cacheDir(), fetchImpl: async () => new Response('', { status: 500 }) });
    await expect(invokeTool(tool, { dataset: 'genome' })).rejects.toBeInstanceOf(InvalidArgumentError);
    await expect(invokeTool(tool, { dataset: 'protein', refresh: 'yes' })).rejects.toBeInstanceOf(InvalidArgumentError);
    await expect(invokeTool(tool, { dataset: 'protein', output_dir: '\u0000x' })).rejects.toBeInstanceOf(InvalidArgumentError);
  });

  it('上游 HEAD 不可达：返回本地缓存并标注 stale', async () => {
    const data = fasta(3, 'IC4R-OSJ01P');
    const prepared = specFor(data, baseline(0, { protein: 3 }));
    const dir = cacheDir();
    let failHead = false;
    const base = mockFetch({ [toolUrl('protein')]: prepared.gz }, {});
    const tool = makeTool({
      cacheRoot: dir,
      baseline: { protein: prepared.baseline },
      fetchImpl: async (url, init) => {
        if (failHead && (init?.method ?? 'GET') === 'HEAD') throw new TypeError('offline');
        return base(url, init);
      },
    });
    await invokeTool(tool, { dataset: 'protein' });
    failHead = true;
    const result = await invokeTool(tool, { dataset: 'protein' });
    const manifest = result.structured as Record<string, unknown>;
    expect(manifest.cache).toBe('stale');
    expect((manifest.warnings as string[]).join('\n')).toContain('未能核对上游身份');
    expect(statSync(path.join(dir, 'protein', 'proteome.fa')).size).toBeGreaterThan(0);
  });
});
