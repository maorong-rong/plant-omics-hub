import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, truncateSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { gzipSync } from 'node:zlib';

import { afterEach, describe, expect, it } from 'vitest';

import { InvalidArgumentError, UpstreamShapeError } from '../src/core/errors.js';
import { invokeTool } from '../src/core/invoke.js';
import type { ReferenceBaseline, ReferenceOptions } from '../src/sources/ensemblplants/bulk.js';
import { createReferenceProteomeTool } from '../src/sources/ensemblplants/bulk.js';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function cacheDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'ensembl-ref-'));
  dirs.push(dir);
  return dir;
}

function fasta(count: number, prefix = 'AT1G0000'): Buffer {
  const lines: string[] = [];
  for (let i = 1; i <= count; i += 1) {
    lines.push(`>${prefix}${String(i).padStart(3, '0')}.1 gene:${prefix}${String(i).padStart(3, '0')}`);
    lines.push('MSSAAGQDNG');
  }
  return Buffer.from(`${lines.join('\n')}\n`, 'utf8');
}

interface MockOptions {
  body: Uint8Array;
  claimedLength?: number;
  status?: number;
}

function mockFetch(files: Record<string, MockOptions>, calls: string[] = []): typeof fetch {
  return (async (input: string | URL | Request) => {
    const url = String(input);
    calls.push(url);
    const options = files[url];
    if (!options) return new Response('not found', { status: 404 });
    if (options.status && options.status !== 200) return new Response('upstream error', { status: options.status });
    return new Response(options.body, {
      status: 200,
      headers: {
        'content-type': 'application/octet-stream',
        'content-length': String(options.claimedLength ?? options.body.length),
      },
    });
  }) as unknown as typeof fetch;
}

function hash(algorithm: 'md5' | 'sha256', bytes: Uint8Array): string {
  return createHash(algorithm).update(bytes).digest('hex');
}

function baselineFor(gz: Uint8Array, data: Buffer, count: number): ReferenceBaseline {
  return {
    bytes: gz.length,
    md5: hash('md5', gz),
    sha256: hash('sha256', gz),
    dataBytes: data.length,
    dataSha256: hash('sha256', data),
    records: { protein: count },
  };
}

const ARABIDOPSIS_URL = 'https://ftp.ebi.ac.uk/ensemblgenomes/pub/plants/release-57/fasta/arabidopsis_thaliana/pep/Arabidopsis_thaliana.TAIR10.pep.all.fa.gz';
const RICE_URL = 'https://ftp.ebi.ac.uk/ensemblgenomes/pub/plants/release-57/fasta/oryza_sativa/pep/Oryza_sativa.IRGSP-1.0.pep.all.fa.gz';

function makeTool(options: ReferenceOptions & { fetchImpl: typeof fetch }) {
  return createReferenceProteomeTool(options);
}

async function arabidopsis(overrides: Partial<ReferenceOptions> = {}, count = 3) {
  const data = fasta(count);
  const gz = new Uint8Array(gzipSync(data));
  const dir = cacheDir();
  const calls: string[] = [];
  const tool = makeTool({
    cacheRoot: dir,
    baseline: { arabidopsis_thaliana: baselineFor(gz, data, count) },
    fetchImpl: mockFetch({ [ARABIDOPSIS_URL]: { body: gz } }, calls),
    ...overrides,
  });
  return { tool, dir, calls, gz, data };
}

describe('ensemblplants_reference_proteome：整文件下载 + 缓存 + 完整性校验（离线）', () => {
  it('拟南芥正例：落盘 pep.all.fa、manifest 条数正确、正文不夹带序列', async () => {
    const { tool, dir } = await arabidopsis();
    const result = await invokeTool(tool, { species: 'arabidopsis_thaliana' });
    const manifest = result.structured as Record<string, unknown>;
    expect(manifest.status).toBe('ok');
    expect(manifest.cache).toBe('download');
    expect(manifest.release).toBe(57);
    expect((manifest.records as Record<string, number>).protein).toBe(3);
    const local = manifest.local as Record<string, string | number>;
    expect(String(local.dataPath)).toContain('release-57/arabidopsis_thaliana.TAIR10/Arabidopsis_thaliana.TAIR10.pep.all.fa');
    expect(readFileSync(String(local.dataPath), 'utf8').match(/^>/gm)).toHaveLength(3);
    expect(result.text).toContain('3');
    expect(result.text).not.toContain('MSSAAGQDNG');
    expect(existsSync(path.join(dir, 'release-57', 'arabidopsis_thaliana.TAIR10', 'manifest.json'))).toBe(true);
  });

  it('水稻正例：URL 用 IRGSP-1.0 文件名', async () => {
    const data = fasta(2, 'Os01g');
    const gz = new Uint8Array(gzipSync(data));
    const dir = cacheDir();
    const calls: string[] = [];
    const tool = makeTool({
      cacheRoot: dir,
      baseline: { oryza_sativa: baselineFor(gz, data, 2) },
      fetchImpl: mockFetch({ [RICE_URL]: { body: gz } }, calls),
    });
    const result = await invokeTool(tool, { species: 'oryza_sativa' });
    expect(calls[0]).toBe(RICE_URL);
    expect((result.structured as Record<string, unknown>).assembly).toBe('IRGSP-1.0');
    const local = (result.structured as Record<string, unknown>).local as Record<string, string>;
    expect(local.dataPath).toContain('Oryza_sativa.IRGSP-1.0.pep.all.fa');
  });

  it('缓存命中：第二次不联网', async () => {
    const { tool, calls } = await arabidopsis();
    const first = await invokeTool(tool, { species: 'arabidopsis_thaliana' });
    const second = await invokeTool(tool, { species: 'arabidopsis_thaliana' });
    expect(calls).toHaveLength(1);
    expect((first.structured as Record<string, unknown>).cache).toBe('download');
    expect((second.structured as Record<string, unknown>).cache).toBe('hit');
  });

  it('refresh=true 强制重新下载', async () => {
    const { tool, calls } = await arabidopsis();
    await invokeTool(tool, { species: 'arabidopsis_thaliana' });
    await invokeTool(tool, { species: 'arabidopsis_thaliana', refresh: true });
    expect(calls).toHaveLength(2);
  });

  it('缓存文件被截断：拒绝复用并重新下载', async () => {
    const { tool, calls, dir } = await arabidopsis();
    await invokeTool(tool, { species: 'arabidopsis_thaliana' });
    truncateSync(path.join(dir, 'release-57', 'arabidopsis_thaliana.TAIR10', 'Arabidopsis_thaliana.TAIR10.pep.all.fa'), 10);
    await invokeTool(tool, { species: 'arabidopsis_thaliana' });
    expect(calls).toHaveLength(2);
  });

  it('下载被截断（Content-Length 大于实际字节）：报错且不写 manifest', async () => {
    const data = fasta(3);
    const gz = new Uint8Array(gzipSync(data));
    const dir = cacheDir();
    const tool = makeTool({
      cacheRoot: dir,
      baseline: { arabidopsis_thaliana: baselineFor(gz, data, 3) },
      fetchImpl: mockFetch({ [ARABIDOPSIS_URL]: { body: gz.slice(0, gz.length - 10), claimedLength: gz.length } }),
    });
    await expect(invokeTool(tool, { species: 'arabidopsis_thaliana' })).rejects.toBeInstanceOf(UpstreamShapeError);
    const manifestPath = path.join(dir, 'release-57', 'arabidopsis_thaliana.TAIR10', 'manifest.json');
    expect(existsSync(manifestPath)).toBe(false);
    const leftovers = readdirSync(path.join(dir, 'release-57', 'arabidopsis_thaliana.TAIR10'));
    expect(leftovers.filter((name) => name.includes('.part-'))).toEqual([]);
  });

  it('条数与基线不符：status=partial + mismatch，但不静默通过、也不丢文件', async () => {
    const data = fasta(2);
    const gz = new Uint8Array(gzipSync(data));
    const dir = cacheDir();
    const tool = makeTool({
      cacheRoot: dir,
      baseline: { arabidopsis_thaliana: baselineFor(gz, data, 5) },
      fetchImpl: mockFetch({ [ARABIDOPSIS_URL]: { body: gz } }),
    });
    const result = await invokeTool(tool, { species: 'arabidopsis_thaliana' });
    const manifest = result.structured as Record<string, unknown>;
    expect(manifest.status).toBe('partial');
    expect((manifest.mismatches as string[]).join('\n')).toContain('期望 5');
    expect(result.text).toContain('partial');
    expect(existsSync(path.join(dir, 'release-57', 'arabidopsis_thaliana.TAIR10', 'manifest.json'))).toBe(true);
  });

  it('未知物种：不给 assembly 直接拒绝（尚未联网），给了才构造文件名', async () => {
    const dir = cacheDir();
    const calls: string[] = [];
    const tool = makeTool({ cacheRoot: dir, fetchImpl: mockFetch({}, calls) });
    await expect(invokeTool(tool, { species: 'zea_mays' })).rejects.toBeInstanceOf(InvalidArgumentError);
    expect(calls).toHaveLength(0);
    await expect(invokeTool(tool, {
      species: 'zea_mays',
      assembly: 'Zm-B73-REFERENCE-NAM-5.0',
    })).rejects.toThrow(/404|上游/);
    expect(calls[0]).toContain('Zea_mays.Zm-B73-REFERENCE-NAM-5.0.pep.all.fa.gz');
  });

  it('已知物种但换了 assembly：不复用默认组装的基线（否则会制造假 partial）', async () => {
    const data = fasta(1);
    const gz = new Uint8Array(gzipSync(data));
    const dir = cacheDir();
    const url = 'https://ftp.ebi.ac.uk/ensemblgenomes/pub/plants/release-57/fasta/arabidopsis_thaliana/pep/Arabidopsis_thaliana.Col-0.pep.all.fa.gz';
    const tool = makeTool({ cacheRoot: dir, fetchImpl: mockFetch({ [url]: { body: gz } }) });
    const result = await invokeTool(tool, { species: 'arabidopsis_thaliana', assembly: 'Col-0' });
    const manifest = result.structured as Record<string, unknown>;
    expect(manifest.assembly).toBe('Col-0');
    expect(manifest.expected).toEqual({});
    expect(manifest.status).toBe('ok');
    expect((manifest.warnings as string[]).join('\n')).toContain('没有内置条数基线');
  });

  it('species 参数拒绝路径穿越与非法形态', async () => {
    const dir = cacheDir();
    const tool = makeTool({ cacheRoot: dir, fetchImpl: mockFetch({}) });
    for (const bad of ['../etc/passwd', 'Arabidopsis thaliana', 'arabidopsis', '', 'a/b']) {
      await expect(invokeTool(tool, { species: bad }), bad).rejects.toBeInstanceOf(InvalidArgumentError);
    }
  });

  it('release 参数改变 URL，且无内置基线时明确写「无基线」', async () => {
    const data = fasta(1);
    const gz = new Uint8Array(gzipSync(data));
    const dir = cacheDir();
    const calls: string[] = [];
    const release58 = ARABIDOPSIS_URL.replace('release-57', 'release-58');
    const tool = makeTool({ cacheRoot: dir, fetchImpl: mockFetch({ [release58]: { body: gz } }, calls) });
    const result = await invokeTool(tool, { species: 'arabidopsis_thaliana', release: 58 });
    const manifest = result.structured as Record<string, unknown>;
    expect(manifest.release).toBe(58);
    expect(manifest.status).toBe('ok');
    expect((manifest.warnings as string[]).join('\n')).toContain('没有内置条数基线');
    expect((manifest.local as Record<string, string>).dataPath).toContain('release-58');
  });
});
