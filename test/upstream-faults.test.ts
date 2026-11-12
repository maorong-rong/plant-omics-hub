/**
 * 五类上游故障回归（wsl-P3）。
 *
 * 目的：把「上游坏了」与「上游说没有」在**自动化**里彻底分开。这五类故障在真实世界里
 * 长得几乎一样（工具没返回数据），但本仓对它们的契约完全不同：
 *
 * | # | 故障 | 触发方式（本文件的桩） | 本仓契约 |
 * |---|---|---|---|
 * | 1 | 连接失败（DNS / 拒绝连接） | fetch 抛 TypeError + cause.code | 按共享层重试，耗尽后**抛错**（`无法连接上游`） |
 * | 2 | 上游 5xx | HTTP 500/503 | 退避重试；耗尽后**抛错**（`上游后端暂时不可用`） |
 * | 3 | 上游 429 + `Retry-After` | HTTP 429 + 头 | 按 `Retry-After` 退避重试；耗尽后**抛错**并保留限流元数据 |
 * | 4 | 空结果（合法但零条） | HTTP 200 + `[]` / `{"results":[]}` | **成功返回**，正文写明「0 条」，不报故障 |
 * | 5 | 业务信封失败 | HTTP 200 + `success:false` / `code` 非 200/300 | **抛错**，不许落到空结果分支 |
 *
 * 全部用桩/回放，不联网：连接层用 `createFetcher` 注入假 fetch；源层用回放 fetcher 或
 * `createFetcher` 转发的假 fetch。断言的是**现有契约**，没有新增错误类型、没有改重试策略。
 */

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import { UpstreamError, UpstreamShapeError } from '../src/core/errors.js';
import { createFetcher } from '../src/core/http.js';
import { invokeTool } from '../src/core/invoke.js';
import type { Fetcher, ToolDefinition } from '../src/core/types.js';
import { tools as grameneTools } from '../src/sources/gramene/tools.js';
import { tools as icgTools } from '../src/sources/icg/tools.js';
import { tools as uniprotTools } from '../src/sources/uniprot/tools.js';
import { tools as wheatomicsTools } from '../src/sources/wheatomics/tools.js';

const response = (status: number, body = '{}', headers: Record<string, string> = {}) =>
  new Response(body, { status, headers });

function toolOf(tools: readonly ToolDefinition[], name: string): ToolDefinition {
  const tool = tools.find((item) => item.name === name);
  if (!tool) throw new Error(`缺少工具 ${name}`);
  return tool;
}

/** 回放一份本地 payload：模拟「HTTP 200 + 合法 JSON」，用来单测源层契约。 */
function replay<T>(
  payload: T,
  init: { status?: number; contentType?: string; headers?: Record<string, string> } = {},
): Fetcher {
  return async <R>(url: string) => ({
    data: payload as R,
    url,
    status: init.status ?? 200,
    contentType: init.contentType ?? 'application/json',
    durationMs: 3,
    attempts: 1,
    headers: init.headers,
    bodyKind: 'json',
  });
}

/** 连接层失败：Node fetch 的真实形态是 TypeError('fetch failed') + cause.code。 */
function connectionFailure(code: string): typeof fetch {
  return (async () => {
    const error = new TypeError('fetch failed');
    (error as { cause?: unknown }).cause = { code };
    throw error;
  }) as unknown as typeof fetch;
}

/** 取到抛出的 UpstreamError；若没抛错（被当成空结果）就显式失败。 */
async function caught(promise: Promise<unknown>): Promise<UpstreamError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof UpstreamError) return error;
    throw error;
  }
  throw new Error('预期抛错，实际成功返回——故障被误报成了空结果');
}

describe('① 连接失败（DNS / 超时 / 拒绝连接）→ 重试后抛错，不当空结果', () => {
  it('DNS 解析失败（ENOTFOUND）：按共享层重试，耗尽后抛「无法连接上游」', async () => {
    let calls = 0;
    const fetchImpl = (async () => {
      calls += 1;
      const error = new TypeError('fetch failed');
      (error as { cause?: unknown }).cause = { code: 'ENOTFOUND' };
      throw error;
    }) as unknown as typeof fetch;

    // retries:1 → 2 次尝试；断言「重试发生过」而不是一次失败就放弃。
    const fetchJson = createFetcher({ timeoutMs: 500, retries: 1 }, fetchImpl);
    const error = await caught(fetchJson('https://example.org/x'));

    expect(error).toBeInstanceOf(UpstreamError);
    expect(error.message).toContain('无法连接上游');
    expect(error.meta.attempts).toBe(2);
    expect(calls).toBe(2);
  });

  it('拒绝连接（ECONNREFUSED）：同样抛错；关掉重试时只发一次请求', async () => {
    let calls = 0;
    const fetchImpl = (async () => {
      calls += 1;
      const error = new TypeError('fetch failed');
      (error as { cause?: unknown }).cause = { code: 'ECONNREFUSED' };
      throw error;
    }) as unknown as typeof fetch;

    const fetchJson = createFetcher({ timeoutMs: 500, retries: 0 }, fetchImpl);
    const error = await caught(fetchJson('https://example.org/x'));

    expect(error.message).toContain('无法连接上游');
    expect(error.meta.attempts).toBe(1);
    expect(calls).toBe(1);
  });

  it('源工具层：连接失败必须抛错，不许渲染成「0 条」成功结果', async () => {
    const tool = toolOf(grameneTools, 'gramene_gene');
    const http = createFetcher({ timeoutMs: 500, retries: 0 }, connectionFailure('ENOTFOUND'));

    const error = await caught(invokeTool(tool, { ids: 'BGIOSGA001967' }, { http }));

    expect(error.message).toContain('无法连接上游');
    // 若被吞成成功结果，caught() 会先失败——这条断言是「空结果 vs 故障」的分界线。
    expect(error.message).not.toContain('本次未返回');
  });
});

describe('② 上游 5xx → 退避重试；耗尽后抛错并保留状态码', () => {
  it('5xx 重试成功：返回真实尝试次数（第 2 次拿到数据）', async () => {
    let calls = 0;
    const fetchImpl = (async () => {
      calls += 1;
      return calls < 2 ? response(500, 'boom', { 'content-type': 'text/plain' }) : response(200, '{"ok":true}');
    }) as unknown as typeof fetch;

    const fetchJson = createFetcher({ timeoutMs: 500, retries: 1 }, fetchImpl);
    const result = await fetchJson<{ ok: boolean }>('https://example.org/x');

    expect(result.status).toBe(200);
    expect(result.data.ok).toBe(true);
    expect(result.attempts).toBe(2);
    expect(calls).toBe(2);
  });

  it('持续 503：重试耗尽后抛「上游后端暂时不可用」，带 status=503 与尝试次数', async () => {
    let calls = 0;
    const fetchImpl = (async () => {
      calls += 1;
      return response(503, 'maintenance', { 'content-type': 'text/html' });
    }) as unknown as typeof fetch;

    const fetchJson = createFetcher({ timeoutMs: 500, retries: 1 }, fetchImpl);
    const error = await caught(fetchJson('https://example.org/x'));

    expect(error.message).toContain('上游后端暂时不可用');
    expect(error.meta.status).toBe(503);
    expect(error.meta.attempts).toBe(2);
    expect(calls).toBe(2);
  });

  it('源工具层：持续 5xx 必须抛错（不是「源里没有这条记录」）', async () => {
    const tool = toolOf(grameneTools, 'gramene_gene');
    const fetchImpl = (async () => response(503, 'down')) as unknown as typeof fetch;
    const http = createFetcher({ timeoutMs: 500, retries: 0 }, fetchImpl);

    const error = await caught(invokeTool(tool, { ids: 'BGIOSGA001967' }, { http }));

    expect(error.message).toContain('上游后端暂时不可用');
    expect(error.meta.status).toBe(503);
  });
});

describe('③ 上游 429（带 Retry-After）→ 按 Retry-After 退避，耗尽后抛错', () => {
  it('按 Retry-After 秒数退避（不是默认 400/1200 ms），重试成功后返回', async () => {
    let calls = 0;
    const fetchImpl = (async () => {
      calls += 1;
      return calls < 3
        ? response(429, 'slow down', { 'retry-after': '0.01' })
        : response(200, '{"ok":true}');
    }) as unknown as typeof fetch;

    const started = Date.now();
    const fetchJson = createFetcher({ timeoutMs: 500, retries: 2 }, fetchImpl);
    const result = await fetchJson<{ ok: boolean }>('https://example.org/x');
    const elapsed = Date.now() - started;

    expect(result.attempts).toBe(3);
    expect(calls).toBe(3);
    // 两次重试各等 10 ms（Retry-After=0.01 s）；默认退避是 400 + 1200 ms。
    expect(elapsed).toBeGreaterThanOrEqual(15);
    // 放宽到 600 ms 只为容忍 CI 调度抖动；默认退避（1600 ms）仍会明显超限。
    expect(elapsed).toBeLessThan(600);
  });

  it('持续 429：重试耗尽后抛错，并保留 Retry-After 与 status 元数据', async () => {
    let calls = 0;
    const fetchImpl = (async () => {
      calls += 1;
      return response(429, 'rate limited', { 'retry-after': '0.02' });
    }) as unknown as typeof fetch;

    const fetchJson = createFetcher({ timeoutMs: 500, retries: 1 }, fetchImpl);
    const error = await caught(fetchJson('https://example.org/x'));

    expect(error.message).toContain('限流');
    expect(error.meta.status).toBe(429);
    expect(error.meta.retryAfter).toBe('0.02');
    expect(calls).toBe(2);
  });
});

describe('④ 空结果（合法但零条）→ 成功返回，正文写明「0 条」', () => {
  it('Gramene /genes 空数组：返回「本次未返回基因记录」，不是故障', async () => {
    const tool = toolOf(grameneTools, 'gramene_gene');
    // 真实 fixture：/genes?idList=NOT_A_REAL_ID → 200 + 空数组（fixtures/README）。
    const { payload } = JSON.parse(
      readFileSync(new URL('../src/sources/gramene/fixtures/genes-empty.json', import.meta.url), 'utf8'),
    ) as { payload: unknown };
    const result = await invokeTool(tool, { ids: 'NOT_A_REAL_ID' }, { http: replay(payload) });

    expect(result.meta.status).toBe(200);
    expect(result.text).toContain('本次未返回基因记录');
    expect(result.text).toContain('0 条');
    expect(result.text).toContain('本次未取到');
  });

  it('UniProt 空 results + x-total-results:0：返回「命中 0 条」，不是故障', async () => {
    const tool = toolOf(uniprotTools, 'uniprot_search_proteins');
    // 真实观测（登记表 2026-11-03）：空结果 = 200 + {"results":[]} + x-total-results: 0。
    const http = replay({ results: [] }, { headers: { 'x-total-results': '0' } });
    const result = await invokeTool(tool, { organism_id: 3702, gene: 'NOT_A_GENE_XYZ' }, { http });

    expect(result.meta.status).toBe(200);
    expect(result.text).toContain('命中 0 条');
  });
});

describe('⑤ 业务信封失败（HTTP 200 但 body 报失败）→ 抛错，不落空结果分支', () => {
  it('WheatOmics success=false：直接抛错（data 不可用，不许当查无）', async () => {
    const tool = toolOf(wheatomicsTools, 'wheatomics_search_known_genes');
    // 真实信封：{success,message,timestamp,data}；success=false 时 data 不可用。
    const http = replay({ success: false, message: '上游明确失败', timestamp: '2026-11-09T00:00:00Z', data: null });

    const error = await caught(invokeTool(tool, { searchid: 'VRN1' }, { http }));

    expect(error).toBeInstanceOf(UpstreamError);
    expect(error.message).toContain('success=false');
  });

  it('ICG code=500：抛结构错误；code=300 仍是「查无」而非失败（不发明新契约）', async () => {
    const tool = toolOf(icgTools, 'icg_lookup');

    // 失败信封：HTTP 200 + code 既不是 "200" 也不是 "300" → 未预期，必须抛错。
    const bad = await caught(
      invokeTool(tool, { entity: 'species', id: 'ICG00115' }, {
        http: replay({ code: '500', message: '上游内部失败', result: null }),
      }),
    );
    expect(bad).toBeInstanceOf(UpstreamShapeError);
    expect(bad.message).toContain('未预期的 code=500');

    // 对照：code="300" + result:null 是上游的「查无」形态（fixtures/not-found.json），
    // 属于合法空结果，工具应成功返回「未找到」，不能和上面的失败混为一谈。
    const notFound = await invokeTool(tool, { entity: 'species', id: 'ICG99999' }, {
      http: replay({ code: '300', message: 'No valid data!', result: null }),
    });
    expect(notFound.meta.status).toBe(200);
    expect(notFound.text).toContain('未找到');
  });
});
