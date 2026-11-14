import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { InvalidArgumentError, UpstreamError, UpstreamShapeError, describeError } from '../src/core/errors.js';
import { utf8Bytes } from '../src/core/format.js';
import { createFetcher } from '../src/core/http.js';
import type { Fetcher } from '../src/core/types.js';
import { geneSequence } from '../src/sources/wheatomics/sequence.js';

const id = 'TraesCS5A02G391700';
const read = (kind: string) => JSON.parse(readFileSync(new URL(`../src/sources/wheatomics/fixtures/sequence-${kind}.json`, import.meta.url), 'utf8'));
function context(payload: unknown) {
  const urls: string[] = [];
  const http = (async (url: string) => { urls.push(url); return { data: payload, url, status: 200, durationMs: 9, attempts: 1 }; }) as Fetcher;
  return { ctx: { http }, urls };
}
function synthetic(sequence: string, kind = 'gene') {
  return { gene_id: id, [`${kind}_sequence`]: `>${id}.1\n${sequence}` };
}

describe('WheatOmics仅基因序列分块（全离线）', () => {
  it.each([['gene', 735], ['protein', 244]])('真实%s按单条去重长度%s，不拼接，不数头行换行', async (kind, total) => {
    const { ctx, urls } = context(read('pos').payload);
    const out = await geneSequence.run({ gene_id: id, sequence_type: kind }, ctx);
    const raw = out.raw as { total_length: number; upstream_records: number; duplicates_removed: number; sequence: string };
    expect(raw.total_length).toBe(total);
    expect(raw.sequence).toHaveLength(total as number);
    expect(raw.upstream_records).toBe(2);
    expect(raw.duplicates_removed).toBe(1);
    expect(out.text).toContain('已去重');
    expect(out.text).toContain('本地1起位置，非基因组坐标');
    expect(out.text).not.toContain('正文已按');
    expect(urls).toHaveLength(1);
    expect([...new URL(urls[0]!).searchParams.keys()]).toEqual(['gene_id']);
    expect(out.meta.request).toContain(`"sequence_type":"${kind}"`);
    expect(out.meta.request).toContain('"offset":1,"length":1000');
    expect(utf8Bytes(out.text.split('\n——\n')[0]!)).toBeLessThanOrEqual(1408);
  });
  it('模拟长序列1000块完整；下一块连续，不丢不重', async () => {
    const seq = 'ACGT'.repeat(575);
    const out1 = await geneSequence.run({ gene_id: id }, context(synthetic(seq)).ctx);
    const out2 = await geneSequence.run({ gene_id: id, offset: 1001 }, context(synthetic(seq)).ctx);
    const out3 = await geneSequence.run({ gene_id: id, offset: 2001 }, context(synthetic(seq)).ctx);
    const raws = [out1, out2, out3].map(o => o.raw as { sequence: string; next_offset?: number });
    expect(raws.map(r => r.sequence.length)).toEqual([1000, 1000, 300]);
    expect(raws.map(r => r.next_offset)).toEqual([1001, 2001, undefined]);
    expect(raws.map(r => r.sequence).join('')).toBe(seq);
    for (const out of [out1, out2, out3]) {
      expect(out.text).not.toContain('正文已按');
      expect(utf8Bytes(out.text.split('\n——\n')[0]!)).toBeLessThanOrEqual(1408);
      expect(utf8Bytes(out.text)).toBeLessThanOrEqual(4096);
    }
  });
  it('本地offset=2、length=3准确切出第2–4位', async () => {
    const out = await geneSequence.run({ gene_id: id, offset: 2, length: 3 }, context(synthetic('ACGTACGT')).ctx);
    expect(out.raw).toMatchObject({ sequence: 'CGT', total_length: 8, offset: 2, end: 4, next_offset: 5 });
    expect(out.text).toContain('第2–4位');
  });
  it('越过末尾不是查无，无下一块', async () => {
    const out = await geneSequence.run({ gene_id: id, offset: 736 }, context(read('pos').payload).ctx);
    expect(out.text).toContain('已越过末尾；不是查无序列');
    expect(out.raw).toMatchObject({ total_length: 735, sequence: '', shown_length: 0 });
  });
  it('仅by-gene已验证JSON404判本次未找到，并保留404出处', async () => {
    const f = read('neg');
    const http = (async (url: string) => { throw new UpstreamError('404', { url, status: 404,
      contentType: f.capture.contentType, bodySnippet: JSON.stringify(f.payload), attempts: 1 }); }) as Fetcher;
    const out = await geneSequence.run({ gene_id: 'TraesCS9Z99G999999' }, { http });
    expect(out.meta.status).toBe(404);
    expect(out.text).toContain('不代表基因不存在');
    expect(out.text).toContain('HTTP 404');
    expect(out.raw).toMatchObject({ found: false });
  });
  it.each([
    ['application/json', true],
    ['application/json; charset=utf-8', true],
    ['Application/Problem+JSON; charset=UTF-8', true],
    ['application/jsonp', false],
    ['application/problem+jsonp', false],
    ['x-application/json', false],
    ['text/application/json', false],
    ['application/json trailing', false],
    ['application/foo bar+json', false],
    ['application/json, text/html', false],
  ])('SEQ-01：真实HTTP层Response桩媒体类型 %s → 查无=%s', async (contentType, allowed) => {
    const payload = read('neg').payload;
    let calls = 0;
    const http = createFetcher({ retries: 0 }, async () => {
      calls += 1;
      return new Response(JSON.stringify(payload), { status: 404, headers: { 'content-type': contentType as string } });
    });
    const run = geneSequence.run({ gene_id: 'TraesCS9Z99G999999' }, { http });
    if (allowed) {
      const out = await run;
      expect(out.raw).toMatchObject({ found: false });
      expect(out.meta.status).toBe(404);
    } else {
      await expect(run).rejects.toBeInstanceOf(UpstreamError);
    }
    expect(calls).toBe(1);
  });
  it.each([
    ['HTML404', 'text/html', '<html>not found</html>', 404],
    ['改版404', 'application/json', '{"detail":"Not Found"}', 404],
    ['串号404', 'application/json', JSON.stringify({ detail: 'No sequence found for OTHER (tried: OTHER, OTHER.1).' }), 404],
    ['400带路径', 'application/json', '{"detail":"/private/server/path"}', 400],
    ['503', 'application/json', '{}', 503],
  ])('%s不吞为查无，错误不泄漏原正文', async (_label, contentType, bodySnippet, status) => {
    const http = (async (url: string) => { throw new UpstreamError('上游失败', { url, status: status as number, contentType: contentType as string, bodySnippet: bodySnippet as string }); }) as Fetcher;
    try { await geneSequence.run({ gene_id: id }, { http }); throw new Error('unexpected success'); }
    catch (e) { expect(e).toBeInstanceOf(UpstreamError); expect(describeError(e)).not.toContain('/private/server/path'); }
  });
  it.each([
    ['顶层身份错', (p: any) => { p.gene_id = 'OTHER'; }],
    ['缺序列', (p: any) => { delete p.gene_sequence; }],
    ['null序列', (p: any) => { p.gene_sequence = null; }],
    ['无FASTA头', (p: any) => { p.gene_sequence = 'ACGT'; }],
    ['空FASTA记录', (p: any) => { p.gene_sequence = `>${id}.1\n`; }],
    ['相同ID不同内容', (p: any) => { p.gene_sequence = `>${id}.1\nACGT\n>${id}.1\nACGA`; }],
    ['多个ID', (p: any) => { p.gene_sequence = `>${id}.1\nACGT\n>${id}.2\nACGT`; }],
    ['正文非法字符', (p: any) => { p.gene_sequence = `>${id}.1\nAC邮箱GT`; }],
  ])('%s报结构漂移（合成反例）', async (_label, mutate) => {
    const p = read('pos').payload; mutate(p);
    await expect(geneSequence.run({ gene_id: id }, context(p).ctx)).rejects.toBeInstanceOf(UpstreamShapeError);
  });
  it.each([
    { gene_id: id, region: 'Chr1A_Chinese_Spring1.0:200-500' },
    { gene_id: id, length: 1001 }, { gene_id: id, length: 0 }, { gene_id: id, length: 1.5 },
    { gene_id: id, offset: 0 }, { gene_id: id, offset: '1' }, { gene_id: id, sequence_type: 'genome' },
    { gene_id: 'X' }, { gene_id: id, offset: Number.MAX_SAFE_INTEGER + 1 },
  ])('非法参数零请求 %j', async args => {
    const { ctx, urls } = context(read('pos').payload);
    await expect(geneSequence.run(args, ctx)).rejects.toBeInstanceOf(InvalidArgumentError);
    expect(urls).toHaveLength(0);
  });
  it('raw和文本不输出附加字段、未选序列或FASTA自由头', async () => {
    const p = synthetic('ACGT');
    p.gene_sequence = `>${id}.1 PRIVATE_SENTINEL\nACGT`;
    const out = await geneSequence.run({ gene_id: id }, context({ ...p, additional_sequences: 'PRIVATE_SENTINEL', private: 'PRIVATE_SENTINEL', protein_sequence: 'PRIVATE_SENTINEL' }).ctx);
    expect(JSON.stringify(out)).not.toContain('PRIVATE_SENTINEL');
  });
  it('蛋白终止符不冒充氨基酸残基，明确计数口径', async () => {
    const out = await geneSequence.run({ gene_id: id, sequence_type: 'protein' }, context(synthetic('MGR*', 'protein')).ctx);
    expect(out.raw).toMatchObject({ total_length: 4, unit: '序列符号（含*终止标记）', sequence: 'MGR*' });
    expect(out.text).toContain('含*终止标记');
  });
  it('同ID不同头行不悄悄去重', async () => {
    const p = synthetic('ACGT'); p.gene_sequence += `\n>${id}.1 other\nACGT`;
    await expect(geneSequence.run({ gene_id: id }, context(p).ctx)).rejects.toBeInstanceOf(UpstreamShapeError);
  });
});

/** 批量出口：假上游按「整批里有一个缺失就整批 failed」的真实行为回放。 */
function batchContext(available: Set<string>, partial?: (ids: string[]) => Array<Record<string, unknown>>) {
  const urls: string[] = [];
  const http = (async (url: string) => {
    urls.push(url);
    const u = new URL(url);
    const ids = (u.searchParams.get('ID') ?? '').split(' ').filter(Boolean);
    // 真实上游是「整批只要有一个 ID 缺失就全部 failed」；partial 用于模拟按条回报的另一种形态。
    const allAvailable = ids.every((id) => available.has(id));
    const records = partial ? partial(ids) : ids.map((id) => allAvailable
      ? { sequence_id: id, ok: true, fasta: `>${id}.1\nMKT*` }
      : { sequence_id: id, ok: false, fasta: '', error: `502: Error: [blastdbcmd] Skipped ${id}.1` });
    const succeeded = records.filter((r) => r.ok === true).length;
    return {
      data: { success: true, data: { database: 'all_protein', requested: ids.length, succeeded, failed: ids.length - succeeded, records } },
      url, status: 200, durationMs: 5, attempts: 1,
    };
  }) as Fetcher;
  return { ctx: { http }, urls };
}

describe('WheatOmics 批量序列（逐条容错，全离线）', () => {
  const ids = ['TraesCS1A03G0032400', 'TraesCS1A03G0032500', 'TraesCS1A03G0032600LC'];
  it('3 个都存在：一次上游请求，structuredContent 含 3 条完整序列，正文不展开', async () => {
    const { ctx, urls } = batchContext(new Set(ids));
    const out = await geneSequence.run({ gene_ids: ids.join(' '), sequence_type: 'protein', include_records: true }, ctx);
    expect(urls).toHaveLength(1);
    const u = new URL(urls[0]!);
    expect(u.searchParams.get('database')).toBe('all_protein');
    expect(u.searchParams.get('ID')).toBe(ids.join(' '));
    expect(out.text).toContain('请求 3 条，成功 3，失败 0');
    expect(out.text).toContain('完整记录（含序列）见 structuredContent');
    const structured = out.structured as { records: Array<{ gene_id: string; sequence: string; length: number }>; failed_ids: string[]; upstream_requests: number };
    expect(structured.records.map((r) => r.gene_id)).toEqual(ids);
    expect(structured.records.map((r) => r.sequence)).toEqual(['MKT*', 'MKT*', 'MKT*']);
    expect(structured.failed_ids).toEqual([]);
    expect(structured.upstream_requests).toBe(1);
    expect(utf8Bytes(out.text.split('\n——\n')[0]!)).toBeLessThanOrEqual(1408);
    expect(out.text).not.toContain('MKT*');
  });
  it('混 1 个不存在：二分隔离后报 成功 2 / 失败 1 与失败 ID，绝不整批归零', async () => {
    const bad = ids[1]!;
    const { ctx, urls } = batchContext(new Set(ids.filter((i) => i !== bad)));
    const out = await geneSequence.run({ gene_ids: ids.join(' '), sequence_type: 'protein', include_records: true }, ctx);
    expect(out.text).toContain('请求 3 条，成功 2，失败 1');
    expect(out.text).toContain(bad);
    const structured = out.structured as { records: unknown[]; failed_ids: string[]; failures: Array<{ gene_id: string; reason: string }>; upstream_requests: number };
    expect(structured.records).toHaveLength(2);
    expect(structured.failed_ids).toEqual([bad]);
    expect(structured.failures[0]!.gene_id).toBe(bad);
    expect(structured.failures[0]!.reason).toContain('Skipped');
    // 3 → 1 全失败 + 二分 2 → 2；2 再二分到 1+1。至少证明发生了重试而不是直接报错。
    expect(structured.upstream_requests).toBeGreaterThan(1);
    expect(urls.length).toBe(structured.upstream_requests);
  });
  it('上游只失败其中几条（partial）：保留成功记录，只对失败列表二分', async () => {
    const bad = ids[2]!;
    const { ctx } = batchContext(new Set(), (batch) => batch.map((id) => id === bad
      ? { sequence_id: id, ok: false, fasta: '', error: 'missing' }
      : { sequence_id: id, ok: true, fasta: `>${id}.1\nMKT*` }));
    const out = await geneSequence.run({ gene_ids: ids.join(' '), sequence_type: 'protein', include_records: true }, ctx);
    const structured = out.structured as { succeeded: number; failed_ids: string[]; upstream_requests: number };
    expect(structured.succeeded).toBe(2);
    expect(structured.failed_ids).toEqual([bad]);
    // 第一次 batch 就按条拿到 2 条成功和失败原因，不必再为单条失败重查。
    expect(structured.upstream_requests).toBe(1);
  });
  it('include_records 缺省不暴露 structuredContent；批量正文仍给计数', async () => {
    const { ctx } = batchContext(new Set(ids));
    const out = await geneSequence.run({ gene_ids: ids.join(' '), sequence_type: 'protein' }, ctx);
    expect(out.structured).toBeUndefined();
    expect(out.text).toContain('成功 3，失败 0');
    expect(out.text).toContain('include_records=true');
  });
  it('重复 ID 去重后只请求一次', async () => {
    const { ctx, urls } = batchContext(new Set([ids[0]!]));
    const out = await geneSequence.run({ gene_ids: `${ids[0]} ${ids[0]}`, sequence_type: 'protein' }, ctx);
    expect(out.text).toContain('请求 1 条');
    expect(new URL(urls[0]!).searchParams.get('ID')).toBe(ids[0]);
  });
  it.each([
    ['超过 50 个', { gene_ids: Array.from({ length: 51 }, (_, i) => `TraesCS1A03G${String(i).padStart(7, '0')}`).join(' ') }],
    ['非法 ID', { gene_ids: 'not-a-gene' }],
    ['带转录本后缀', { gene_ids: 'TraesCS1A03G0032400.1' }],
    ['与 gene_id 同时给', { gene_id: ids[0], gene_ids: ids.join(' ') }],
    ['与 list_ids 同时给', { gene_ids: ids.join(' '), list_ids: true }],
    ['批量给 offset', { gene_ids: ids.join(' '), offset: 1 }],
    ['批量给 database', { gene_ids: ids.join(' '), database: 'x' }],
    ['list 缺 database', { list_ids: true }],
    ['list 用聚合库', { list_ids: true, database: 'all_protein' }],
  ])('非法参数零请求 %s', async (_name, input) => {
    const { ctx, urls } = context(read('pos').payload);
    await expect(geneSequence.run(input as Record<string, unknown>, ctx)).rejects.toBeInstanceOf(InvalidArgumentError);
    expect(urls).toHaveLength(0);
  });
});

describe('WheatOmics 序列 ID 列表（全离线）', () => {
  const listPayload = (database: string, ids: string[]) => ({
    success: true,
    data: { database, count: ids.length, chromosomes: ids },
  });
  it('列出具体物种库：structuredContent 带全量 ID，正文只给计数', async () => {
    const ids = ['TraesCS1A03G0000100LC.1', 'TraesCS1A03G0000200.1'];
    const { ctx, urls } = context(listPayload('AABBDD_Chinese_Spring2.1.add_Description.pep', ids));
    const out = await geneSequence.run({ list_ids: true, database: 'AABBDD_Chinese_Spring2.1.add_Description.pep', include_records: true }, ctx);
    expect(urls).toHaveLength(1);
    expect(new URL(urls[0]!).searchParams.get('database')).toBe('AABBDD_Chinese_Spring2.1.add_Description.pep');
    expect(out.text).toContain('共 2 条序列ID');
    const structured = out.structured as { mode: string; count: number; ids: string[] };
    expect(structured.mode).toBe('list');
    expect(structured.count).toBe(2);
    expect(structured.ids).toEqual(ids);
  });
  it('count 与 chromosomes 长度不符 → 结构漂移', async () => {
    const payload = listPayload('db', ['A']); payload.data.count = 2;
    await expect(geneSequence.run({ list_ids: true, database: 'db' }, context(payload).ctx)).rejects.toBeInstanceOf(UpstreamShapeError);
  });
});
