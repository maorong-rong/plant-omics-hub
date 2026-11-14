import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { InvalidArgumentError, UpstreamError, UpstreamShapeError } from '../src/core/errors.js';
import { utf8Bytes } from '../src/core/format.js';
import type { Fetcher, ToolContext } from '../src/core/types.js';
import { tools } from '../src/sources/wheatomics/tools.js';

const FIXTURE_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'sources', 'wheatomics', 'fixtures');

function readPayload(name: string): unknown {
  return (JSON.parse(readFileSync(join(FIXTURE_DIR, name), 'utf8')) as { payload: unknown }).payload;
}

function tool(name: string) {
  const found = tools.find((candidate) => candidate.name === name);
  if (!found) throw new Error(`注册表里没有 ${name}`);
  return found;
}

interface Call { url: string; opts: Record<string, unknown> }

function contextFor(payload: unknown): { ctx: ToolContext; calls: Call[] } {
  const calls: Call[] = [];
  const http = (async (url: string, opts: Record<string, unknown> = {}) => {
    calls.push({ url, opts });
    return { data: payload, url, status: 200, durationMs: 12, attempts: 1 };
  }) as Fetcher;
  return { ctx: { http }, calls };
}

const GENES4 = ['TraesCS1A02G045300.1', 'TraesCS1A02G104700.1', 'TraesCS1A02G118400.1', 'TraesCS1A02G013100.1'];

describe('G4 wheatomics_synteny：区间/单基因 + 01G/02G 判明', () => {
  it('区间查询：40 条 / 22 对锚点；正文只展示 limit 条，完整记录进 structuredContent', async () => {
    const { ctx, calls } = contextFor(readPayload('synteny-interval.json'));
    const out = await tool('wheatomics_synteny').run({ region: 'chr1A:8000000-9000000', limit: 5 }, ctx);
    expect(calls[0].url).toContain('/synteny/search');
    expect(calls[0].url).toContain('ID=chr1A%3A8000000-9000000');
    expect(out.text).toContain('命中 40 条共线记录');
    expect(out.text).toContain('有跨物种锚点 22 条');
    expect(out.text).toContain('正文展示 5 条');
    expect(out.text).toContain('TraesCS1A01G018500LC');
    expect(out.structured?.count).toBe(40);
    expect(out.structured?.anchors).toBe(22);
    expect(out.structured?.shown).toBe(5);
    expect((out.structured?.records as unknown[]).length).toBe(40);
    expect(utf8Bytes(out.text)).toBeLessThanOrEqual(4096);
  });

  it('02G 单基因 count=0：正文判明是 01G/02G 编号代次，不藏单基因路径', async () => {
    const { ctx } = contextFor(readPayload('synteny-gene-empty.json'));
    const out = await tool('wheatomics_synteny').run({ gene_id: 'TraesCS1A02G013100' }, ctx);
    expect(out.text).toContain('count=0');
    expect(out.text).toContain('02G 编号');
    expect(out.text).toContain('01G');
    expect(out.text).toContain('编号代次');
    expect(out.text).toContain('不是"必须用区间"');
    expect(out.structured?.count).toBe(0);
    expect(utf8Bytes(out.text)).toBeLessThanOrEqual(4096);
  });

  it('01G 单基因同表可查到（对照 02G 的 count=0）', async () => {
    const { ctx } = contextFor(readPayload('synteny-gene-01g.json'));
    const out = await tool('wheatomics_synteny').run({ gene_id: 'TraesCS1A01G018500LC' }, ctx);
    expect(out.text).toContain('TraesCS1A01G018500LC');
    expect(out.structured?.count).toBe(1);
  });

  it('区间/基因必须二选一，且坐标与跨度在本地校验', async () => {
    const { ctx } = contextFor(readPayload('synteny-interval.json'));
    await expect(tool('wheatomics_synteny').run({}, ctx)).rejects.toBeInstanceOf(InvalidArgumentError);
    await expect(tool('wheatomics_synteny').run({ region: 'chr1A:1-2', gene_id: 'TraesCS1A01G018500LC' }, ctx))
      .rejects.toBeInstanceOf(InvalidArgumentError);
    await expect(tool('wheatomics_synteny').run({ region: 'chr1A:100-100' }, ctx)).rejects.toBeInstanceOf(InvalidArgumentError);
    await expect(tool('wheatomics_synteny').run({ region: 'chr1A:1-6000000' }, ctx)).rejects.toBeInstanceOf(InvalidArgumentError);
  });
});

describe('G6 wheatomics_ppi：PPI_poppin 边摘要 + structuredContent', () => {
  it('2 个基因回 87 条边；正文展示 limit 条，完整边进 structuredContent', async () => {
    const { ctx, calls } = contextFor(readPayload('ppi-poppin.json'));
    const out = await tool('wheatomics_ppi').run({
      gene_ids: 'TraesCS1A02G013100,TraesCS5A02G391700', table: 'PPI_poppin', limit: 5,
    }, ctx);
    expect(calls[0].url).toContain('/ppi/query');
    expect(calls[0].url).toContain('table=PPI_poppin');
    expect(calls[0].url).not.toContain('min_score');
    expect(out.text).toContain('共 87 条互作边');
    expect(out.text).toContain('正文展示 5 条');
    expect(out.text).toContain('LOC_Os03g11614-LOC_Os03g54160');
    expect(out.structured?.total).toBe(87);
    expect(out.structured?.shown).toBe(5);
    expect((out.structured?.interactions as unknown[]).length).toBe(87);
    expect(utf8Bytes(out.text)).toBeLessThanOrEqual(4096);
  });

  it('空边不冒充“没有互作”，并说明两张表的收录差异', async () => {
    const { ctx } = contextFor(readPayload('ppi-empty.json'));
    const out = await tool('wheatomics_ppi').run({ gene_ids: 'TraesCS1A02G013100' }, ctx);
    expect(out.text).toContain('0 条互作边');
    expect(out.text).toContain('不等于"没有互作"');
    expect(out.structured?.total).toBe(0);
  });

  it('PPI_result 才发送 min_score；非法 table/超过 50 个 ID 本地拒绝', async () => {
    const { ctx, calls } = contextFor(readPayload('ppi-empty.json'));
    await tool('wheatomics_ppi').run({ gene_ids: 'TraesCS1A02G013100', table: 'PPI_result', min_score: 0.2 }, ctx);
    expect(calls[0].url).toContain('min_score=0.2');
    await expect(tool('wheatomics_ppi').run({ gene_ids: 'x', table: 'PPI_nope' }, ctx))
      .rejects.toBeInstanceOf(InvalidArgumentError);
    const tooMany = Array.from({ length: 51 }, (_, i) => `TraesCS1A02G${String(i).padStart(6, '0')}`).join(',');
    await expect(tool('wheatomics_ppi').run({ gene_ids: tooMany }, ctx)).rejects.toBeInstanceOf(InvalidArgumentError);
  });
});

describe('G6 wheatomics_regulatory：调控区汇总', () => {
  it('798 motif 命中 / 355 motif / 5.02e-10，坐标标明 0-based', async () => {
    const { ctx, calls } = contextFor(readPayload('regulatory-gene.json'));
    const out = await tool('wheatomics_regulatory').run({ gene_id: 'TraesCS1A02G013100' }, ctx);
    expect(calls[0].url).toContain('/regulatory/gene/TraesCS1A02G013100');
    expect(out.text).toContain('motif 命中数：798');
    expect(out.text).toContain('motif 数：355');
    expect(out.text).toContain('5.02e-10');
    expect(out.text).toContain('0-based');
    expect(out.structured?.summary).toMatchObject({ hit_count: 798, motif_count: 355 });
    expect(utf8Bytes(out.text)).toBeLessThanOrEqual(4096);
  });

  it('响应回显的 gene_id 与请求不一致 → 拒绝展示', async () => {
    const payload = readPayload('regulatory-gene.json') as Record<string, unknown>;
    const { ctx } = contextFor({ ...payload, gene: { ...(payload.gene as object), gene_id: 'TraesCS9Z99G999999' } });
    await expect(tool('wheatomics_regulatory').run({ gene_id: 'TraesCS1A02G013100' }, ctx))
      .rejects.toBeInstanceOf(UpstreamShapeError);
  });
});

describe('G7 wheatomics_enrichment：POST GO/KEGG + 体积闸', () => {
  it('GO：POST body 逐字可复现，63 条显著条目，正文只展示 limit 条', async () => {
    const { ctx, calls } = contextFor(readPayload('go-enrichment.json'));
    const out = await tool('wheatomics_enrichment').run({ mode: 'go', genes: GENES4, limit: 5 }, ctx);
    expect(calls[0].url).toBe('https://wheatomics.sdau.edu.cn/api/go');
    expect(calls[0].opts.method).toBe('POST');
    expect(calls[0].opts.body).toBe(`{"genes":${JSON.stringify(GENES4)},"padj_threshold":0.05}`);
    expect(calls[0].opts.timeoutMs).toBe(45_000);
    expect(calls[0].opts.retries).toBe(0);
    expect(out.text).toContain('N=73626');
    expect(out.text).toContain('显著条目（padj < 0.05）共 63 条');
    expect(out.text).toContain('GO:2000024');
    expect(out.structured?.total_results).toBe(63);
    expect(out.structured?.significant).toBe(63);
    expect((out.structured?.results as unknown[]).length).toBe(63);
    expect(utf8Bytes(out.text)).toBeLessThanOrEqual(4096);
  });

  it('KEGG：同一入口带 mode=kegg，N=91160 / 6 条', async () => {
    const { ctx, calls } = contextFor(readPayload('kegg-enrichment.json'));
    const out = await tool('wheatomics_enrichment').run({ mode: 'kegg', genes: GENES4 }, ctx);
    expect(calls[0].url).toBe('https://wheatomics.sdau.edu.cn/api/kegg');
    expect(out.text).toContain('KEGG 通路富集');
    expect(out.text).toContain('N=91160');
    expect(out.text).toContain('ko05418');
    expect(out.structured?.significant).toBe(6);
  });

  it('上游 500 原样透传为 UpstreamError（带状态码与完整请求证据）', async () => {
    const url = 'https://wheatomics.sdau.edu.cn/api/go';
    const http = (async () => {
      throw new UpstreamError('上游返回 HTTP 500', { url, status: 500, attempts: 1 });
    }) as Fetcher;
    try {
      await tool('wheatomics_enrichment').run({ genes: GENES4 }, { http });
      throw new Error('should fail');
    } catch (error) {
      expect(error).toBeInstanceOf(UpstreamError);
      expect((error as UpstreamError).meta.status).toBe(500);
      expect((error as UpstreamError).meta.request).toContain('POST https://wheatomics.sdau.edu.cn/api/go');
    }
  });

  it('genes/mode/threshold 本地校验：空数组、非字符串、非法 mode 都在联网前拒绝', async () => {
    const { ctx, calls } = contextFor(readPayload('go-enrichment.json'));
    await expect(tool('wheatomics_enrichment').run({ genes: [] }, ctx)).rejects.toBeInstanceOf(InvalidArgumentError);
    await expect(tool('wheatomics_enrichment').run({ genes: [1] }, ctx)).rejects.toBeInstanceOf(InvalidArgumentError);
    await expect(tool('wheatomics_enrichment').run({ genes: GENES4, mode: 'nope' }, ctx))
      .rejects.toBeInstanceOf(InvalidArgumentError);
    await expect(tool('wheatomics_enrichment').run({ genes: GENES4, padj_threshold: 0 }, ctx))
      .rejects.toBeInstanceOf(InvalidArgumentError);
    expect(calls).toHaveLength(0);
  });
});

// ── issue #77：六条封装层缺口 ─────────────────────────────────────────────

interface Routed { match: RegExp; payload?: unknown; error?: UpstreamError }

function routedContext(routes: Routed[]): { ctx: ToolContext; calls: Call[] } {
  const calls: Call[] = [];
  const http = (async (url: string, opts: Record<string, unknown> = {}) => {
    calls.push({ url, opts });
    const route = routes.find((candidate) => candidate.match.test(url));
    if (!route) throw new Error(`未预期的请求：${url}`);
    if (route.error) throw route.error;
    return { data: route.payload, url, status: 200, durationMs: 12, attempts: 1 };
  }) as Fetcher;
  return { ctx: { http }, calls };
}

describe('issue #77 第 1 条：共线对照物种坐标=上游未给（结构化标注，不推算）', () => {
  it('每条的对照物种拆成基因数组；coordinates 标 unknown 并给出实测证据', async () => {
    const { ctx } = contextFor(readPayload('synteny-interval.json'));
    const out = await tool('wheatomics_synteny').run({ region: 'chr1A:8000000-9000000', limit: 5 }, ctx);

    const structured = out.structured as {
      counterpart_coordinates: { status: string; unit: null; reason: string };
      records: Array<{
        gene: string;
        counterparts: Record<string, { genes: string[]; coordinates: { start_mb: null; end_mb: null; status: string } }>;
      }>;
    };
    expect(structured.counterpart_coordinates.status).toBe('unknown');
    expect(structured.counterpart_coordinates.unit).toBeNull();
    expect(structured.counterpart_coordinates.reason).toContain('TRIDC1AG001520');
    const withAnchors = structured.records.find((record) => record.gene === 'TraesCS1A01G014900');
    expect(withAnchors?.counterparts.wild_emmer.genes).toContain('TRIDC1AG001900');
    expect(withAnchors?.counterparts.triticum_urartu.coordinates).toEqual({ start_mb: null, end_mb: null, status: 'unknown' });
    expect(out.text).toContain('对照物种只有基因 ID');
    expect(out.text).toContain('未知');
  });
});

describe('issue #77 第 3 条：PPI 分批 + 明确失败行为', () => {
  it('4 个基因按 batch_size=2 分两批；边按去重合并，逐批请求进出处', async () => {
    const payload = readPayload('ppi-poppin.json');
    const { ctx, calls } = routedContext([
      { match: /\/ppi\/query\?.*gene_ids=TraesCS1A02G013100%2CTraesCS5A02G391700/, payload },
      { match: /\/ppi\/query\?.*gene_ids=TraesCS3A02G045300%2CTraesCS3B02G045300/, payload },
    ]);
    const genes = 'TraesCS1A02G013100,TraesCS5A02G391700,TraesCS3A02G045300,TraesCS3B02G045300';
    const out = await tool('wheatomics_ppi').run({ gene_ids: genes, batch_size: 2, limit: 3 }, ctx);

    expect(calls).toHaveLength(2);
    expect(calls[0].url).toContain('gene_ids=TraesCS1A02G013100%2CTraesCS5A02G391700');
    expect(calls[1].url).toContain('gene_ids=TraesCS3A02G045300%2CTraesCS3B02G045300');
    expect(calls[0].opts.retries).toBe(0);
    // 两批返回同一批边：去重后仍是 87 条，不是 174
    expect(out.structured?.total).toBe(87);
    expect((out.structured?.batches as unknown[]).length).toBe(2);
    expect((out.structured?.failed_batches as unknown[]).length).toBe(0);
    expect(out.text).toContain('分批：2 批');
    expect(out.text).toContain('其余批请求：');
    expect(utf8Bytes(out.text)).toBeLessThanOrEqual(4096);
  });

  it('某一批超时：返回 partial + 失败批次，不假装结果完整', async () => {
    const payload = readPayload('ppi-poppin.json');
    const { ctx } = routedContext([
      {
        match: /gene_ids=TraesCS1A02G013100%2CTraesCS5A02G391700/,
        error: new UpstreamError('单次调用已达 35500 ms 上限，放弃本次请求', { url: 'x', attempts: 0 }),
      },
      { match: /\/ppi\/query/, payload },
    ]);
    const genes = 'TraesCS1A02G013100,TraesCS5A02G391700,TraesCS3A02G045300,TraesCS3B02G045300';
    const out = await tool('wheatomics_ppi').run({ gene_ids: genes, batch_size: 2 }, ctx);

    expect(out.structured?.partial).toBe(true);
    expect(out.structured?.failed_batches).toEqual([1]);
    expect(out.text).toContain('partial');
    expect(out.text).toContain('结果不完整');
    expect(out.structured?.total).toBe(87);
  });

  it('batch_size 越界被夹取；全部批次失败时抛 UpstreamError（不返回空表）', async () => {
    const { ctx } = routedContext([
      { match: /\/ppi\/query/, error: new UpstreamError('上游返回 HTTP 503', { url: 'x', status: 503, attempts: 1 }) },
    ]);
    await expect(tool('wheatomics_ppi').run({ gene_ids: 'TraesCS1A02G013100', batch_size: 999 }, ctx))
      .rejects.toBeInstanceOf(UpstreamError);
  });
});

describe('issue #77 第 4 条：regulatory motif→target 明细', () => {
  it('hit_limit 触发 /hits，明细含 motif id/名称/来源通道/坐标/p 值，汇总保留', async () => {
    const { ctx, calls } = routedContext([
      { match: /\/hits\?/, payload: readPayload('regulatory-hits.json') },
      { match: /\/regulatory\/gene\/TraesCS1A02G013100$/, payload: readPayload('regulatory-gene.json') },
    ]);
    const out = await tool('wheatomics_regulatory').run({ gene_id: 'TraesCS1A02G013100', hit_limit: 3 }, ctx);

    expect(calls).toHaveLength(2);
    expect(calls[0].url).toContain('/regulatory/gene/TraesCS1A02G013100');
    expect(calls[1].url).toContain('/hits?');
    expect(calls[1].url).toContain('page_size=3');
    expect(out.text).toContain('motif 命中数：798');
    expect(out.text).toContain('MA2344.1');
    expect(out.text).toContain('JASPAR2026_CORE_Plants');
    expect(out.text).toContain('REV');
    const hits = out.structured?.hits as { total: number; shown: number; items: Array<{ motif_id: string; motif_source: string; target_gene: string; pvalue: number }> };
    expect(hits.total).toBe(798);
    expect(hits.items).toHaveLength(3);
    expect(hits.items[0]).toMatchObject({
      motif_id: 'MA2344.1', motif_source: 'JASPAR2026_CORE_Plants', target_gene: 'TraesCS1A02G013100', pvalue: 8.51e-05,
    });
    // 汇总请求的出处也在尾注里（两次请求都列出）
    expect(out.meta.request).toContain('/hits?');
    expect(utf8Bytes(out.text)).toBeLessThanOrEqual(4096);
  });

  it('不传 hit_limit 时不发第二次请求，行为与旧版一致', async () => {
    const { ctx, calls } = contextFor(readPayload('regulatory-gene.json'));
    const out = await tool('wheatomics_regulatory').run({ gene_id: 'TraesCS1A02G013100' }, ctx);
    expect(calls).toHaveLength(1);
    expect(out.structured?.hits).toMatchObject({ requested: false, total: null, items: [] });
  });
});

describe('issue #77 第 5 条：enrichment 超时上限 + gene→GO 明细', () => {
  it('timeout_ms 透传到 HTTP 层；默认 45 s 且不重试', async () => {
    const { ctx, calls } = contextFor(readPayload('go-enrichment.json'));
    await tool('wheatomics_enrichment').run({ genes: GENES4, timeout_ms: 10_000 }, ctx);
    expect(calls[0].opts.timeoutMs).toBe(10_000);
    expect(calls[0].opts.retries).toBe(0);
    expect(calls[0].opts.maxTotalMs).toBe(15_000);
  });

  it('include_gene_hits：逐条目回查 /api/go/genes，给出「谁命中了哪个 GO」，p/BH 不改', async () => {
    const { ctx, calls } = routedContext([
      { match: /\/api\/go$/, payload: readPayload('go-enrichment.json') },
      { match: /\/go\/genes\?/, payload: readPayload('go-genes.json') },
    ]);
    const out = await tool('wheatomics_enrichment').run({
      mode: 'go', genes: GENES4, include_gene_hits: true, gene_hit_terms: 2, limit: 5,
    }, ctx);

    expect(calls[0].url).toBe('https://wheatomics.sdau.edu.cn/api/go');
    expect(calls).toHaveLength(3); // 1 次富集 + 2 次 gene→GO 回查
    expect(calls[1].url).toContain('/go/genes?');
    expect(calls[1].url).toContain('go_id=');
    const geneHits = out.structured?.gene_hits as Array<{ term_id: string; genes: string[]; request: string }>;
    expect(geneHits).toHaveLength(2);
    expect(geneHits[0].genes.length).toBeGreaterThan(0);
    // 富集统计口径不变：仍是上游原值
    expect(out.structured?.total_results).toBe(63);
    expect(out.structured?.significant).toBe(63);
    expect(out.text).toContain('gene→GO 明细');
    expect(out.text).toMatch(/个送检基因命中/);
    // 明细请求也是真请求：出处尾注里列出 GET /go/genes
    expect(out.text).toContain('/go/genes?');
    expect(out.meta.request).toContain('POST https://wheatomics.sdau.edu.cn/api/go');
    expect(utf8Bytes(out.text)).toBeLessThanOrEqual(4096);
  });

  it('gene→GO 明细失败不拖垮富集结果：记在该条目的 error 里', async () => {
    const { ctx } = routedContext([
      { match: /\/api\/go$/, payload: readPayload('go-enrichment.json') },
      { match: /\/go\/genes\?/, error: new UpstreamError('上游返回 HTTP 500', { url: 'x', status: 500, attempts: 1 }) },
    ]);
    const out = await tool('wheatomics_enrichment').run({
      genes: GENES4, include_gene_hits: true, gene_hit_terms: 1,
    }, ctx);
    const geneHits = out.structured?.gene_hits as Array<{ error?: string; genes: string[] }>;
    expect(geneHits[0].genes).toEqual([]);
    expect(geneHits[0].error).toContain('HTTP 500');
    expect(out.structured?.significant).toBe(63);
    expect(out.text).toContain('明细查询失败');
  });
});
