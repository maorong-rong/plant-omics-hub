import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { InvalidArgumentError, UpstreamError, UpstreamShapeError } from '../src/core/errors.js';
import { utf8Bytes } from '../src/core/format.js';
import type { Fetcher } from '../src/core/types.js';
import { homology } from '../src/sources/ensemblplants/tools.js';

const read = (name: string) => JSON.parse(readFileSync(
  new URL(`../src/sources/ensemblplants/fixtures/${name}`, import.meta.url), 'utf8',
)) as { payload: unknown };

function ok(payload: unknown) {
  const calls: Array<{ url: string; opts: Record<string, unknown> }> = [];
  const http = (async (url: string, opts: Record<string, unknown> = {}) => {
    calls.push({ url, opts });
    return { data: payload, url, status: 200, durationMs: 9, attempts: 1, contentType: 'application/json' };
  }) as Fetcher;
  return { ctx: { http }, calls };
}

describe('G5 ensemblplants_homology：水稻→拟南芥，裁剪 644 KB 整包', () => {
  it('默认目标拟南芥：只回 2 条，含 type/perc_id/目标基因；正文 ≤ 4 KB', async () => {
    const { ctx, calls } = ok(read('homology-oryza-os01.json').payload);
    const out = await homology.run({ species: 'oryza_sativa', id: 'Os01g0100100' }, ctx);
    expect(calls[0].url).toBe('https://rest.ensembl.org/homology/id/oryza_sativa/Os01g0100100?type=all;content-type=application/json');
    expect(out.text).toContain('目标物种 拟南芥 Arabidopsis thaliana 2 条');
    expect(out.text).toContain('AT2G43490');
    expect(out.text).toContain('ortholog_one2many');
    expect(out.text).toContain('45.1%');
    expect(out.structured?.total_homologies).toBe(6);
    expect(out.structured?.filtered).toBe(2);
    expect(out.structured?.species_counts).toEqual({ arabidopsis_thaliana: 2 });
    const records = out.structured?.records as Array<Record<string, unknown>>;
    expect(records).toHaveLength(2);
    expect(records.every((record) => record.target_species === 'arabidopsis_thaliana')).toBe(true);
    expect(utf8Bytes(out.text)).toBeLessThanOrEqual(4096);
  });

  it('max_per_species 限制正文条数；structuredContent 仍含全部目标物种记录', async () => {
    const { ctx } = ok(read('homology-oryza-os01.json').payload);
    const out = await homology.run({ species: 'oryza_sativa', id: 'Os01g0100100', max_per_species: 1 }, ctx);
    expect(out.text).toContain('正文每物种最多 1 条，展示 1 条');
    expect((out.structured?.records as unknown[]).length).toBe(2);
    expect(out.structured?.shown).toBe(1);
  });

  it('目标物种只开放拟南芥（G5 实测方向），其他物种在联网前拒绝', async () => {
    const { ctx, calls } = ok(read('homology-oryza-os01.json').payload);
    await expect(homology.run({ species: 'oryza_sativa', id: 'Os01g0100100', target_species: 'triticum_aestivum' }, ctx))
      .rejects.toBeInstanceOf(InvalidArgumentError);
    expect(calls).toHaveLength(0);
    await expect(homology.run({ species: 'oryza_sativa', id: 'Os01g0100100', max_per_species: 11 }, ctx))
      .rejects.toBeInstanceOf(InvalidArgumentError);
    await expect(homology.run({ species: 'homo_sapiens', id: 'Os01g0100100' }, ctx))
      .rejects.toBeInstanceOf(InvalidArgumentError);
  });

  it('上游 data=[] 是合法空：不冒充“没有同源基因”，并提示可重试', async () => {
    const { ctx } = ok({ data: [] });
    const out = await homology.run({ species: 'oryza_sativa', id: 'Os01g0100100' }, ctx);
    expect(out.text).toContain('data=[]');
    expect(out.text).toContain('不等同于该基因没有同源基因');
    expect(out.structured?.total_homologies).toBe(0);
  });

  it('回显 id 与请求不一致 → 身份不符，拒绝展示', async () => {
    const payload = read('homology-oryza-os01.json').payload as { data: Array<{ id: string }> };
    const { ctx } = ok({ data: [{ ...payload.data[0], id: 'Os09g9999999' }] });
    await expect(homology.run({ species: 'oryza_sativa', id: 'Os01g0100100' }, ctx))
      .rejects.toBeInstanceOf(UpstreamShapeError);
  });

  it('上游 500 → 明确失败（不重试），保留请求证据', async () => {
    const url = 'https://rest.ensembl.org/homology/id/oryza_sativa/Os01g0100100?type=all;content-type=application/json';
    const http = (async () => {
      throw new UpstreamError('上游返回 HTTP 500', { url, status: 500, attempts: 1 });
    }) as Fetcher;
    try {
      await homology.run({ species: 'oryza_sativa', id: 'Os01g0100100' }, { http });
      throw new Error('should fail');
    } catch (error) {
      expect(error).toBeInstanceOf(UpstreamError);
      expect((error as UpstreamError).message).toContain('同源端点本次失败');
      expect((error as UpstreamError).meta.request).toContain('GET https://rest.ensembl.org/homology/id/oryza_sativa/Os01g0100100');
    }
  });
});
