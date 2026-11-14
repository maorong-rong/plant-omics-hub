import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { InvalidArgumentError, UpstreamError, UpstreamShapeError } from '../src/core/errors.js';
import { utf8Bytes } from '../src/core/format.js';
import type { Fetcher, ToolContext } from '../src/core/types.js';
import { geneAnnotation } from '../src/sources/wheatomics/annotation.js';

const fixture = (kind: string) => JSON.parse(readFileSync(new URL(`../src/sources/wheatomics/fixtures/pfam-${kind}.json`, import.meta.url), 'utf8')).payload;
function context(payload: unknown) {
  const urls: string[] = [];
  const http = (async (url: string) => { urls.push(url); return { data: payload, url, status: 200, durationMs: 7, attempts: 1 }; }) as Fetcher;
  return { ctx: { http } as ToolContext, urls };
}
const args = { pfam_id: 'PF00319' };

const regionPayload = () => ({
  success: true,
  message: 'ok',
  timestamp: '2026-11-10T04:41:05.328636+00:00',
  data: {
    table: 'Genefunc_CS_IWGSC03G_table',
    region: 'chr1A:8650000..8660000',
    count: 3,
    records: [
      { chromosome: 'chr1A', start_mb: 8.652783, end_mb: 8.653352, gene_primary: 'TraesCS1A03G0032400', gene_secondary: 'TraesCS1A02G013100', strand: '+', description: 'PRIVATE_SENTINEL', domain: 'PF00319: SRF-type' },
      { chromosome: 'chr1A', start_mb: 8.6539, end_mb: 8.6545, gene_primary: 'TraesCS1A03G0032500', gene_secondary: 'TraesCS1A02G013200', strand: '-', description: null, domain: null },
      { chromosome: 'chr1A', start_mb: 8.655, end_mb: 8.656, gene_primary: 'TraesCS1A03G0032600LC', gene_secondary: null, strand: null, description: null, domain: null },
    ],
  },
});

describe('WheatOmics Pfam / 区间注释（全离线）', () => {
  it('Pfam 真实回放：358 条计数，默认页 5 条，正文和raw都只含本页', async () => {
    const { ctx, urls } = context(fixture('pos'));
    const out = await geneAnnotation.run(args, ctx);
    expect(urls).toHaveLength(1);
    const url = new URL(urls[0]!);
    expect([...url.searchParams.keys()]).toEqual(['ID']);
    expect(url.searchParams.get('ID')).toBe('PF00319');
    expect(out.text).toContain('共 358 条');
    expect(out.text).toContain('坐标单位：Mb');
    expect(out.text).toContain('8.652783');
    const raw = out.raw as { shown: number; omitted: number; records: unknown[]; next_offset?: number };
    expect(out.text).toContain(`展示第 1–${raw.shown} 条`);
    expect(raw.shown).toBe(5);
    expect(raw.omitted).toBe(358 - raw.shown);
    expect(raw.records).toHaveLength(raw.shown);
    expect(out.text.split('\n').filter(l => l.startsWith('|')).length - 2).toBe(raw.shown);
    expect(utf8Bytes(out.text.split('\n——\n')[0]!)).toBeLessThanOrEqual(1408);
    expect(utf8Bytes(out.text)).toBeLessThanOrEqual(4096);
    expect(out.text).not.toContain('正文已按');
    expect(out.meta.request).toContain('ID=PF00319');
    expect(out.meta.request).toContain('"limit":5');
    expect(out.meta.request).toContain('"offset":0');
    // 普通调用不暴露 structuredContent 数据通道。
    expect(out.structured).toBeUndefined();
  });
  it('offset 分页推进：第 21–40 条，与首页不重叠，next_offset 正确', async () => {
    const first = await geneAnnotation.run({ ...args, limit: 20 }, context(fixture('pos')).ctx);
    const second = await geneAnnotation.run({ ...args, limit: 20, offset: 20 }, context(fixture('pos')).ctx);
    const f = first.raw as { records: Array<{ gene_id: string }>; next_offset: number };
    const s = second.raw as { records: Array<{ gene_id: string }>; next_offset: number; omitted: number };
    // 1408 字节预算可能把 20 条压到 19 条；断言按实际 shown 推导，不假设固定行数。
    const fs = first.raw as { shown: number };
    expect(fs.shown).toBeGreaterThan(0);
    expect(f.records).toHaveLength(fs.shown);
    expect(s.records).toHaveLength((second.raw as { shown: number }).shown);
    expect(s.next_offset).toBe(20 + (second.raw as { shown: number }).shown);
    expect(s.omitted).toBe(358 - 20 - (second.raw as { shown: number }).shown);
    for (const id of s.records.map(r => r.gene_id)) expect(f.records.map(r => r.gene_id)).not.toContain(id);
    expect(second.text).toContain('展示第 21–');
  });
  it('offset 越过末尾不是查无，也不报错', async () => {
    const out = await geneAnnotation.run({ ...args, offset: 1000 }, context(fixture('pos')).ctx);
    const raw = out.raw as { shown: number; count: number };
    expect(raw.shown).toBe(0);
    expect(raw.count).toBe(358);
    expect(out.text).toContain('offset=1000 已越过末尾；不是查无');
    expect(out.text).not.toContain('正文已按');
  });
  it('count=0和空数组是合法空结果', async () => {
    const out = await geneAnnotation.run({ pfam_id: 'PF999999' }, context(fixture('neg')).ctx);
    expect(out.text).toContain('共 0 条');
    expect(out.text).toContain('展示第 0–0 条（0 条）');
    expect(out.text).toContain('上游明确返回');
  });
  it('limit=20 时正文仍在 1408 字节内，不交统一截断', async () => {
    const out = await geneAnnotation.run({ ...args, limit: 20 }, context(fixture('pos')).ctx);
    const raw = out.raw as { shown: number; omitted: number };
    expect(raw.shown).toBeGreaterThan(0);
    expect(raw.shown).toBeLessThanOrEqual(20);
    expect(out.text).toContain(`本页之后还有 ${raw.omitted} 条`);
    expect(out.text).not.toContain('正文已按');
    expect(utf8Bytes(out.text.split('\n——\n')[0]!)).toBeLessThanOrEqual(1408);
  });
  it('include_records=true 时 structuredContent 含全部 358 条，正文仍只展示本页', async () => {
    const out = await geneAnnotation.run({ ...args, limit: 5, include_records: true }, context(fixture('pos')).ctx);
    const structured = out.structured as { mode: string; count: number; records: unknown[] };
    expect(structured.mode).toBe('pfam');
    expect(structured.count).toBe(358);
    expect(structured.records).toHaveLength(358);
    expect((out.raw as { records: unknown[] }).records).toHaveLength(5);
    expect(out.text).toContain('展示第 1–5 条');
  });

  it('区间模式：投影白名单字段，隐藏自由文本，支持 offset/limit', async () => {
    const payload = regionPayload();
    const { ctx, urls } = context(payload);
    const out = await geneAnnotation.run({ region: 'chr1A:8650000..8660000', limit: 2 }, ctx);
    expect(urls).toHaveLength(1);
    expect(new URL(urls[0]!).searchParams.get('ID')).toBe('chr1A:8650000..8660000');
    expect(out.text).toContain('表 Genefunc_CS_IWGSC03G_table');
    expect(out.text).toContain('共 3 条');
    expect(out.text).toContain('展示第 1–2 条');
    const raw = out.raw as { mode: string; count: number; shown: number; next_offset: number; records: Array<Record<string, unknown>> };
    expect(raw.mode).toBe('region');
    expect(raw.count).toBe(3);
    expect(raw.shown).toBe(2);
    expect(raw.next_offset).toBe(2);
    expect(raw.records[0]).toEqual({ gene_id: 'TraesCS1A03G0032400', gene_secondary: 'TraesCS1A02G013100', chromosome: 'chr1A', start_mb: 8.652783, end_mb: 8.653352, strand: '+' });
    expect(JSON.stringify(out)).not.toContain('PRIVATE_SENTINEL');

    const second = await geneAnnotation.run({ region: 'chr1A:8650000..8660000', limit: 2, offset: 2 }, context(payload).ctx);
    expect(second.text).toContain('展示第 3–3 条');
    expect((second.raw as { shown: number }).shown).toBe(1);

    const all = await geneAnnotation.run({ region: 'chr1A:8650000..8660000', include_records: true, limit: 1 }, context(payload).ctx);
    const structured = all.structured as { mode: string; region: string; count: number; records: unknown[] };
    expect(structured.mode).toBe('region');
    expect(structured.region).toBe('chr1A:8650000..8660000');
    expect(structured.count).toBe(3);
    expect(structured.records).toHaveLength(3);
  });
  it.each([
    ['缺模式', {}],
    ['两种模式同时给', { pfam_id: 'PF00319', region: 'chr1A:1..100000' }],
    ['Pfam 格式错', { pfam_id: 'X' }],
    ['region 格式错', { region: 'chr1A:8650000-8660000' }],
    ['region 跨度超 30 Mb', { region: 'chr1A:1..30000001' }],
    ['region 终点小于起点', { region: 'chr1A:8660000..8650000' }],
    ['limit 0', { ...args, limit: 0 }],
    ['limit 21', { ...args, limit: 21 }],
    ['offset 负数', { ...args, offset: -1 }],
    ['include_records 非布尔', { ...args, include_records: 'true' }],
    ['未知参数', { ...args, offset: 1, table: 'other' }],
  ])('非法参数零请求 %s', async (_name, input) => {
    const { ctx, urls } = context(fixture('pos'));
    await expect(geneAnnotation.run(input as Record<string, unknown>, ctx)).rejects.toBeInstanceOf(InvalidArgumentError);
    expect(urls).toHaveLength(0);
  });
  it.each([
    ['缺count', (p: any) => { delete p.data.count; }],
    ['负count', (p: any) => { p.data.count = -1; }],
    ['null记录', (p: any) => { p.data.records[0] = null; }],
    ['计数不符', (p: any) => { p.data.count = 0; }],
    ['结构域错配', (p: any) => { p.data.domain = 'PF99999'; }],
    ['表错配', (p: any) => { p.data.table = 'UNREQUESTED'; }],
    ['坐标字符串', (p: any) => { p.data.records[0].start_mb = '1'; }],
    ['缺基因', (p: any) => { delete p.data.records[0].gene_primary; }],
    ['单条域错配', (p: any) => { p.data.records[0].domain = 'PF99999: other'; }],
  ])('Pfam %s不当作合法结果（合成反例）', async (_name, mutate) => {
    const payload = fixture('pos'); mutate(payload);
    await expect(geneAnnotation.run(args, context(payload).ctx)).rejects.toBeInstanceOf(UpstreamShapeError);
  });
  it.each([
    ['区间回显不符', (p: any) => { p.data.region = 'chr1A:1..2'; }],
    ['区间表名不符', (p: any) => { p.data.table = 'OTHER'; }],
    ['区间计数不符', (p: any) => { p.data.count = 2; }],
    ['区间非法染色体', (p: any) => { p.data.records[0].chromosome = '1A'; }],
    ['区间终点小于起点', (p: any) => { p.data.records[0].end_mb = 1; }],
  ])('区间 %s 不当作合法结果（合成反例）', async (_name, mutate) => {
    const payload = regionPayload(); mutate(payload);
    await expect(geneAnnotation.run({ region: 'chr1A:8650000..8660000' }, context(payload).ctx)).rejects.toBeInstanceOf(UpstreamShapeError);
  });
  it('自由文本与额外字段不进入正文或raw（合成哨兵）', async () => {
    const payload = fixture('pos');
    payload.data.secret = 'PRIVATE_SENTINEL';
    payload.data.records[0].description = 'PRIVATE_SENTINEL';
    payload.data.records[0].contact = 'PRIVATE_SENTINEL';
    const out = await geneAnnotation.run(args, context(payload).ctx);
    expect(JSON.stringify(out)).not.toContain('PRIVATE_SENTINEL');
  });
  it('404不能吞为查无', async () => {
    const http = (async (url: string) => { throw new UpstreamError('上游404', { url, status: 404 }); }) as Fetcher;
    await expect(geneAnnotation.run(args, { http })).rejects.toMatchObject({ meta: { status: 404 } });
  });
});
