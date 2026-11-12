import { describe, expect, it } from 'vitest';
import { InvalidArgumentError, UpstreamShapeError } from '../src/core/errors.js';
import type { Fetcher } from '../src/core/types.js';
import { tools } from '../src/sources/wheatomics/tools.js';

const geneDetail = tools.find((tool) => tool.name === 'wheatomics_gene_detail')!;

const genome = () => ({
  success: true,
  message: 'ok',
  timestamp: '2026-11-10T04:35:12.190644+00:00',
  data: {
    id: 88,
    dataset_id: 'Chinese_Spring1.0',
    display_name: 'Chinese Spring 1.0',
    species: 'Triticum aestivum',
    ploidy: 'AABBDD',
    assembly_level: 'Chromosome',
    assembly_version: null,
    genome_size: 14577400000,
    chromosome_count: 21,
    gene_count: 269428,
    gene_table: 'Genefunc_AABBDD_Chinese_Spring1_0_table',
    blast_pep_db: 'AABBDD_Chinese_Spring1.0',
    annotation_source: null,
    doi: '10.1126/science.aar7191',
    publication_year: 2018,
    aliases_json: 'SENTINEL_TEXT',
  },
});

const tables = () => ({
  success: true,
  data: {
    database: 'Genefuncdb',
    total_tables: 2,
    tables: [
      { name: 'Genefunc_CS_IWGSC03G_table', rows: 264574 },
      { name: 'Genefunc_AABBDD_Chinese_Spring1_0_table', rows: 297642 },
    ],
  },
});

function context(genomePayload: unknown = genome(), tablesPayload: unknown = tables()) {
  const urls: string[] = [];
  const http = (async (url: string) => {
    urls.push(url);
    const payload = url.includes('/genes/functions/tables') ? tablesPayload : genomePayload;
    return { data: payload, url, status: 200, durationMs: 4, attempts: 1 };
  }) as Fetcher;
  return { ctx: { http }, urls };
}

describe('WheatOmics 基因组目录（全离线）', () => {
  it('dataset_id 模式返回 gene_count/表名/蛋白库，并核对注释表行数', async () => {
    const { ctx, urls } = context();
    const out = await geneDetail.run({ dataset_id: 'Chinese_Spring1.0' }, ctx);
    expect(urls).toHaveLength(2);
    expect(urls[0]).toContain('/genomes/Chinese_Spring1.0');
    expect(urls[1]).toContain('/genes/functions/tables');
    expect(out.text).toContain('官方基因数 gene_count：269428');
    expect(out.text).toContain('注释表：Genefunc_AABBDD_Chinese_Spring1_0_table');
    expect(out.text).toContain('注释表行数（表级接口）：297642');
    expect(out.text).toContain('蛋白 BLAST 库：AABBDD_Chinese_Spring1.0');
    const raw = out.raw as Record<string, unknown>;
    expect(raw).toMatchObject({
      mode: 'dataset', dataset_id: 'Chinese_Spring1.0', gene_count: 269428,
      gene_table: 'Genefunc_AABBDD_Chinese_Spring1_0_table', table_rows: 297642,
    });
    expect(JSON.stringify(out)).not.toContain('SENTINEL_TEXT');
  });
  it('表级接口失败不拖垮目录结果，但把原因写进 raw', async () => {
    const http = (async (url: string) => {
      if (url.includes('/genes/functions/tables')) throw new Error('upstream 503');
      return { data: genome(), url, status: 200, durationMs: 4, attempts: 1 };
    }) as Fetcher;
    const out = await geneDetail.run({ dataset_id: 'Chinese_Spring1.0' }, { http });
    expect(out.raw).toMatchObject({ table_rows: null });
    expect(String((out.raw as Record<string, unknown>).table_rows_note)).toContain('503');
  });
  it.each([
    ['gene_id 与 dataset_id 同时给', { gene_id: 'TraesCS5A02G391700', dataset_id: 'Chinese_Spring1.0' }],
    ['都不给', {}],
    ['dataset_id 非法字符', { dataset_id: 'a/b' }],
  ])('非法参数零请求 %s', async (_name, args) => {
    const { ctx, urls } = context();
    await expect(geneDetail.run(args, ctx)).rejects.toBeInstanceOf(InvalidArgumentError);
    expect(urls).toHaveLength(0);
  });
  it('dataset_id 回显不符 / gene_count 非数字 → 结构漂移', async () => {
    const wrongId = genome(); wrongId.data.dataset_id = 'OTHER';
    await expect(geneDetail.run({ dataset_id: 'Chinese_Spring1.0' }, context(wrongId).ctx)).rejects.toBeInstanceOf(UpstreamShapeError);
    const badCount = genome(); (badCount.data as Record<string, unknown>).gene_count = '269428';
    await expect(geneDetail.run({ dataset_id: 'Chinese_Spring1.0' }, context(badCount).ctx)).rejects.toBeInstanceOf(UpstreamShapeError);
  });
});
