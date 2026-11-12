import { InvalidArgumentError, UpstreamError, UpstreamShapeError } from '../../core/errors.js';
import { utf8Bytes } from '../../core/format.js';
import { fetchPrepared, finishResult, MAX_BODY_BYTES, prepareRequest } from '../../core/request.js';
import type { HttpResult, ToolDefinition } from '../../core/types.js';
import { manifest } from './manifest.js';

function integer(args: Record<string, unknown>, key: string, fallback: number, max: number): number {
  const value = args[key] === undefined ? fallback : args[key];
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1 || value > max) {
    throw new InvalidArgumentError(`${key}须为1–${max}的整数`);
  }
  return value;
}

function flag(args: Record<string, unknown>, key: string): boolean {
  const value = args[key];
  if (value === undefined) return false;
  if (typeof value !== 'boolean') throw new InvalidArgumentError(`${key}须为布尔值 true/false`);
  return value;
}

/** 不拼接多个FASTA记录；只对同ID且头行、序列均完全相同的重复件去重。 */
function parseSingleFasta(value: unknown, id: string, kind: string, url: string) {
  const fail = (): never => { throw new UpstreamShapeError('所选FASTA缺失、格式/身份不符，或包含不同记录；拒绝拼接序列', { url }); };
  if (typeof value !== 'string' || !value.trim()) return fail();
  const lines = value.trim().split(/\r?\n/);
  const records: Array<{ header: string; id: string; sequence: string }> = [];
  for (const line of lines) {
    if (line.startsWith('>')) {
      const headerId = line.slice(1).split(/\s/, 1)[0]!;
      if (headerId !== id && headerId !== `${id}.1`) return fail();
      records.push({ header: line, id: headerId, sequence: '' });
    } else {
      const current = records[records.length - 1];
      const alphabet = kind === 'gene' ? /^[ACGTRYSWKMBDHVN]+$/i : /^[ACDEFGHIKLMNPQRSTVWYBXZJUO*]+$/i;
      if (!current || !alphabet.test(line)) return fail();
      current.sequence += line;
    }
  }
  const first = records[0];
  if (!first || !first.sequence || records.some(r => r.id !== first.id || r.header !== first.header || r.sequence !== first.sequence)) return fail();
  return { recordId: first.id, sequence: first.sequence, upstreamRecords: records.length };
}

/** 批量记录的白名单投影；错误文本只留首行并截断，避免把上游正文泼进 structuredContent。 */
function failedReason(value: unknown): string {
  const text = typeof value === 'string' ? value.trim().split(/\r?\n/, 1)[0]!.trim() : '';
  return text ? text.slice(0, 240) : 'upstream reported ok=false without an error message';
}

const BATCH_LIMIT = 50;
/** 一次工具调用内允许的上游请求数上限：50 个 ID 二分隔离最坏约 127 次，留一倍余量。 */
const BATCH_REQUEST_CAP = 200;

interface BatchRecord {
  gene_id: string;
  sequence: string;
  record_id: string;
  length: number;
}

export const geneSequence: ToolDefinition = {
  name: 'wheatomics_sequence',
  description: '按小麦基因ID取基因或蛋白序列：单基因按offset/length本地分块；或多个基因（≤50）批量取、逐条容错并报成功/失败清单；或列出某个BLAST库的全部序列ID（仅限具体物种库，拒绝all_protein等超大聚合库）。批量与列库的完整记录只在include_records=true时放进structuredContent，正文只给计数与失败清单。不接区间序列；offset是所选去重序列的本地1起位置，不是基因组坐标。',
  parameters: {
    type: 'object',
    properties: {
      gene_id: { type: 'string', description: '单个小麦基因ID，例如TraesCS5A02G391700；可带转录本后缀.1' },
      gene_ids: { type: 'string', description: `批量基因ID（空格/逗号分隔，最多${BATCH_LIMIT}个）；与gene_id互斥` },
      sequence_type: { type: 'string', enum: ['gene', 'protein'], default: 'gene', description: 'gene=基因序列（碱基）；protein=蛋白（氨基酸残基），默认gene' },
      offset: { type: 'integer', minimum: 1, maximum: Number.MAX_SAFE_INTEGER, default: 1, description: '单基因模式下所选去重序列的本地1起位置，不是基因组坐标' },
      length: { type: 'integer', minimum: 1, maximum: 1000, default: 1000, description: '单基因模式本地最多返回长度，1–1000，默认1000；不发给上游，不是上游分页' },
      database: { type: 'string', description: 'list_ids=true时必填：具体物种BLAST库名，例如AABBDD_Chinese_Spring2.1.add_Description.pep' },
      list_ids: { type: 'boolean', default: false, description: 'true=列出database中的全部序列ID（走/sequence/chromosomes）；与gene_id/gene_ids互斥' },
      include_records: { type: 'boolean', default: false, description: 'true=批量/列库的完整记录放进structuredContent；正文仍只给计数与失败清单。单基因模式忽略此项' },
    },
    additionalProperties: false,
  },
  async run(args, ctx) {
    const allowed = ['gene_id', 'gene_ids', 'sequence_type', 'offset', 'length', 'database', 'list_ids', 'include_records'];
    for (const key of Object.keys(args)) {
      if (!allowed.includes(key)) throw new InvalidArgumentError(`序列工具仅接受${allowed.join('、')}，不开放区间`);
    }
    const kind = args.sequence_type === undefined ? 'gene' : args.sequence_type;
    if (kind !== 'gene' && kind !== 'protein') throw new InvalidArgumentError('sequence_type仅接受gene或protein');
    const listIds = flag(args, 'list_ids');
    const includeRecords = flag(args, 'include_records');
    const hasSingle = args.gene_id !== undefined && args.gene_id !== null && args.gene_id !== '';
    const hasBatch = args.gene_ids !== undefined && args.gene_ids !== null && args.gene_ids !== '';
    if ([listIds, hasSingle, hasBatch].filter(Boolean).length !== 1) {
      throw new InvalidArgumentError('gene_id、gene_ids、list_ids=true 三者必须且只能给一个');
    }
    if (!listIds && (args.database !== undefined)) throw new InvalidArgumentError('database 只在 list_ids=true 时接受');

    if (listIds) return runList(args, ctx, includeRecords);
    if (hasBatch) return runBatch(args, ctx, kind, includeRecords);
    return runSingle(args, ctx, kind);
  },
};

/** 单基因：保持 0.1.2 的本地分块语义不变。 */
async function runSingle(args: Record<string, unknown>, ctx: Parameters<ToolDefinition['run']>[1], kind: 'gene' | 'protein') {
  const id = args.gene_id;
  if (typeof id !== 'string' || !/^Traes[A-Za-z0-9]{1,40}(?:\.\d{1,3})?$/.test(id)) {
    throw new InvalidArgumentError('gene_id须为小麦基因ID，例如TraesCS5A02G391700');
  }
  const offset = integer(args, 'offset', 1, Number.MAX_SAFE_INTEGER);
  const length = integer(args, 'length', 1000, 1000);
  const url = new URL(`${manifest.apiBase}/sequence/by-gene`);
  url.searchParams.set('gene_id', id);
  const prepared = prepareRequest({ url: url.href, sourceName: manifest.displayName, presentation: { sequence_type: kind, offset, length } });
  const started = Date.now();
  let res: HttpResult;
  try {
    res = await fetchPrepared(ctx, prepared);
  } catch (error) {
    // 只对本次精确by-gene URL + JSON 404 + 实测detail结构判查无；HTML404、改版404和其他端点绝不吞。
    if (!(error instanceof UpstreamError) || error.meta.url !== url.href || error.meta.status !== 404) throw error;
    let missing = false;
    const mediaType = (error.meta.contentType ?? '').split(';', 1)[0]!.trim();
    // 完整媒体类型匹配，不把application/jsonp或前后缀漂移当JSON。
    if (/^application\/(?:json|[!#$%&'*+.^_`|~0-9a-z-]+\+json)$/i.test(mediaType)) {
      try {
        const payload = JSON.parse(error.meta.bodySnippet ?? '');
        missing = payload?.detail === `No sequence found for ${id} (tried: ${id}, ${id}.1).`;
      } catch { /* 未匹配已验证查无结构，不降级成功。 */ }
    }
    if (!missing) throw new UpstreamError('序列端点返回404，但未匹配已验证的查无结构，不能判断记录是否存在', {
      url: prepared.url, request: prepared.request, status: 404, attempts: error.meta.attempts,
    });
    return finishResult({ body: `本次按基因查询未找到序列（已验证的by-gene JSON 404）；不代表基因不存在。`,
      res: { url: prepared.url, status: 404, data: null, durationMs: Date.now() - started, attempts: error.meta.attempts ?? 1 },
      prepared, sourceId: manifest.id, raw: { gene_id: id, sequence_type: kind, found: false },
      extra: `${manifest.versionNote}；404耗时为本地观测本次调用总耗时` });
  }
  if (res.status !== 200 || !res.data || typeof res.data !== 'object' || Array.isArray(res.data)) {
    throw new UpstreamShapeError('序列响应不是约定的200 JSON对象', { url: prepared.url });
  }
  const data = res.data as Record<string, unknown>;
  if (data.gene_id !== id) throw new UpstreamShapeError('序列响应gene_id与请求不符', { url: prepared.url });
  const parsed = parseSingleFasta(data[`${kind}_sequence`], id, kind, prepared.url);
  const total = parsed.sequence.length;
  const unit = kind === 'gene' ? '碱基' : parsed.sequence.includes('*') ? '序列符号（含*终止标记）' : '残基';
  const chunk = parsed.sequence.slice(offset - 1, offset - 1 + length);
  const end = chunk.length ? offset + chunk.length - 1 : undefined;
  const next = end !== undefined && end < total ? end + 1 : undefined;
  const body = [
    `${id} ${kind}｜共${total}${unit}；本地1起位置，非基因组坐标。`,
    `上游${parsed.upstreamRecords > 1 ? '重复' : ''}返回${parsed.upstreamRecords}条${parsed.upstreamRecords > 1 ? '，同ID同内容，已去重' : ''}；使用单条${parsed.recordId}。`,
    chunk.length ? `第${offset}–${end}位（${chunk.length}${unit}；本地分块，非完整FASTA）：\n${chunk}` : `offset=${offset}已越过末尾；不是查无序列。`,
    next ? `下一块offset=${next}，length=${length}。` : '已到末尾，无下一块。',
  ].join('\n');
  // 在公共收尾前断言，确保分块绝不会被统一截断成半块。
  if (utf8Bytes(body) > MAX_BODY_BYTES) throw new InvalidArgumentError('序列分块正文超过1408 UTF-8字节，请减小length后重试（未返回截断序列）');
  return finishResult({ body, res, prepared, sourceId: manifest.id, extra: manifest.versionNote,
    raw: { gene_id: id, sequence_type: kind, record_id: parsed.recordId, upstream_records: parsed.upstreamRecords,
      duplicates_removed: parsed.upstreamRecords - 1, total_length: total, unit, offset, shown_length: chunk.length,
      end, next_offset: next, sequence: chunk } });
}

/** 批量：逐条容错。上游只要混进一个缺失 ID 就整批报 failed，所以失败时二分隔离，绝不整批丢。 */
async function runBatch(
  args: Record<string, unknown>,
  ctx: Parameters<ToolDefinition['run']>[1],
  kind: 'gene' | 'protein',
  includeRecords: boolean,
) {
  const rawIds = args.gene_ids;
  if (typeof rawIds !== 'string') throw new InvalidArgumentError('gene_ids 必须是字符串');
  const ids = [...new Set(rawIds.split(/[\s,;]+/).map((s) => s.trim()).filter(Boolean))];
  if (ids.length === 0) throw new InvalidArgumentError('gene_ids 解析后为空');
  if (ids.length > BATCH_LIMIT) throw new InvalidArgumentError(`gene_ids 一次最多 ${BATCH_LIMIT} 个，收到 ${ids.length} 个；请分批查询`);
  for (const id of ids) {
    if (!/^Traes[A-Za-z0-9]{1,40}(?:\.\d{1,3})?$/.test(id)) {
      throw new InvalidArgumentError(`gene_ids 含非法小麦基因ID：${id}`);
    }
    if (/\.\d{1,3}$/.test(id)) {
      throw new InvalidArgumentError(`gene_ids 用基因ID，不要带转录本后缀（批量端点会自动加 .1）：${id}`);
    }
  }
  if (args.offset !== undefined || args.length !== undefined) {
    throw new InvalidArgumentError('offset/length 只用于单基因模式，批量模式一次返回完整序列');
  }
  const database = kind === 'protein' ? 'all_protein' : 'all_gene';
  const requests: Array<{ url: string; status: number; durationMs: number; ids: number }> = [];
  let primary: { prepared: ReturnType<typeof prepareRequest>; res: HttpResult } | undefined;
  const successes = new Map<string, BatchRecord>();
  const failures = new Map<string, string>();

  const requestOnce = async (subset: string[]): Promise<{ ok: BatchRecord[]; failed: Array<{ id: string; reason: string }> }> => {
    if (requests.length >= BATCH_REQUEST_CAP) {
      throw new UpstreamShapeError(`批量容错请求数超过 ${BATCH_REQUEST_CAP} 次上限；拒绝继续重试（已取到的记录不丢，见 structuredContent）`, { url: primary?.prepared.url ?? `${manifest.apiBase}/sequence/batch` });
    }
    const url = new URL(`${manifest.apiBase}/sequence/batch`);
    url.searchParams.set('database', database);
    url.searchParams.set('ID', subset.join(' '));
    const prepared = prepareRequest({ url: url.href, sourceName: manifest.displayName, presentation: { batch: subset.length, sequence_type: kind } });
    const res = await fetchPrepared(ctx, prepared);
    requests.push({ url: prepared.url, status: res.status, durationMs: res.durationMs, ids: subset.length });
    primary ??= { prepared, res };
    const fail = (): never => { throw new UpstreamShapeError('批量序列响应结构、数据库或计数与约定不符', { url: prepared.url }); };
    if (res.status !== 200 || !res.data || typeof res.data !== 'object' || Array.isArray(res.data)) return fail();
    const envelope = res.data as Record<string, unknown>;
    if (envelope.success !== true || !envelope.data || typeof envelope.data !== 'object' || Array.isArray(envelope.data)) return fail();
    const data = envelope.data as Record<string, unknown>;
    if (data.database !== database || data.requested !== subset.length
      || !Number.isSafeInteger(data.succeeded) || !Number.isSafeInteger(data.failed)
      || (data.succeeded as number) + (data.failed as number) !== subset.length
      || !Array.isArray(data.records) || data.records.length !== subset.length) return fail();
    const wanted = new Set(subset);
    const ok: BatchRecord[] = [];
    const failed: Array<{ id: string; reason: string }> = [];
    const seen = new Set<string>();
    for (const item of data.records) {
      if (!item || typeof item !== 'object' || Array.isArray(item)) return fail();
      const row = item as Record<string, unknown>;
      const id = row.sequence_id;
      if (typeof id !== 'string' || !wanted.has(id) || seen.has(id)) return fail();
      seen.add(id);
      if (row.ok === true) {
        const parsed = parseSingleFasta(row.fasta, id, kind, prepared.url);
        ok.push({ gene_id: id, sequence: parsed.sequence, record_id: parsed.recordId, length: parsed.sequence.length });
      } else if (row.ok === false) {
        failed.push({ id, reason: failedReason(row.error) });
      } else {
        return fail();
      }
    }
    if (ok.length !== data.succeeded || failed.length !== data.failed) return fail();
    return { ok, failed };
  };

  /** 上游整批归零时二分到单条；成功记录直接收下，失败只记单条原因。 */
  const collect = async (subset: string[]): Promise<void> => {
    const { ok, failed } = await requestOnce(subset);
    for (const record of ok) successes.set(record.gene_id, record);
    if (failed.length === 0) return;
    if (subset.length === 1) {
      failures.set(failed[0]!.id, failed[0]!.reason);
      return;
    }
    // 上游可能只失败其中几条；先把已成功的记下，再只对失败列表继续二分。
    const failedIds = failed.map((f) => f.id);
    if (failedIds.length === subset.length) {
      const mid = Math.ceil(subset.length / 2);
      await collect(subset.slice(0, mid));
      await collect(subset.slice(mid));
      return;
    }
    if (failedIds.length === 1) {
      failures.set(failedIds[0]!, failed[0]!.reason);
      return;
    }
    const mid = Math.ceil(failedIds.length / 2);
    await collect(failedIds.slice(0, mid));
    await collect(failedIds.slice(mid));
  };

  await collect(ids);
  const failedIds = ids.filter((id) => !successes.has(id));
  const succeeded = ids.length - failedIds.length;
  const totalBases = [...successes.values()].reduce((sum, r) => sum + r.length, 0);
  const bodyLines = [
    `批量${kind === 'protein' ? '蛋白' : '基因'}序列｜database=${database}`,
    `请求 ${ids.length} 条，成功 ${succeeded}，失败 ${failedIds.length}；上游请求 ${requests.length} 次（失败批次二分到单条，未整批丢弃）。`,
    failedIds.length ? `失败 ID（${failedIds.length}）：${failedIds.join(', ')}` : '失败 ID（0）：无。',
    includeRecords ? '完整记录（含序列）见 structuredContent。' : '本次未请求完整记录；需要序列请设 include_records=true。',
  ];
  // 失败清单可能很长：逐项裁到正文预算内，并显式说明余下在哪。
  let body = bodyLines.join('\n');
  if (utf8Bytes(body) > MAX_BODY_BYTES && failedIds.length > 0) {
    let shown = failedIds.length;
    while (shown > 0 && utf8Bytes([
      bodyLines[0], bodyLines[1],
      `失败 ID（${failedIds.length}，正文仅列前 ${shown} 个）：${failedIds.slice(0, shown).join(', ')}${failedIds.length > shown ? ` …另有 ${failedIds.length - shown} 个` : ''}`,
      bodyLines[3],
    ].join('\n')) > MAX_BODY_BYTES) shown -= 1;
    body = [
      bodyLines[0], bodyLines[1],
      `失败 ID（${failedIds.length}，正文仅列前 ${shown} 个）：${failedIds.slice(0, shown).join(', ')}${failedIds.length > shown ? ` …另有 ${failedIds.length - shown} 个` : ''}`,
      bodyLines[3],
    ].join('\n');
  }
  if (utf8Bytes(body) > MAX_BODY_BYTES) body = body.slice(0, 1200);
  const structured = includeRecords ? {
    mode: 'batch' as const,
    database,
    sequence_type: kind,
    requested: ids.length,
    succeeded,
    failed: failedIds.length,
    upstream_requests: requests.length,
    total_bases: totalBases,
    records: [...successes.values()],
    failed_ids: failedIds,
    failures: failedIds.map((id) => ({ gene_id: id, reason: failures.get(id) ?? 'failed in an upstream batch' })),
  } : undefined;
  return finishResult({
    body,
    res: primary!.res,
    prepared: primary!.prepared,
    sourceId: manifest.id,
    extra: `${manifest.versionNote}；批量逐条容错，失败 ID 见正文/structuredContent`,
    raw: { mode: 'batch', database, sequence_type: kind, requested: ids.length, succeeded, failed: failedIds.length,
      upstream_requests: requests.length, failed_ids: failedIds },
    ...(structured ? { structured } : {}),
  });
}

/** 列库：只允许具体物种库；all_protein 这类聚合库有 1975 万条、518 MB，直接拒绝。 */
const MAX_LISTED_IDS = 1_000_000;
async function runList(
  args: Record<string, unknown>,
  ctx: Parameters<ToolDefinition['run']>[1],
  includeRecords: boolean,
) {
  for (const key of ['gene_id', 'gene_ids', 'offset', 'length']) {
    if (args[key] !== undefined) throw new InvalidArgumentError(`${key} 不能与 list_ids=true 同时使用`);
  }
  const database = args.database;
  if (typeof database !== 'string' || !/^[A-Za-z0-9_.-]{1,120}$/.test(database)) {
    throw new InvalidArgumentError('list_ids=true 时必须给 database（字母/数字/下划线/点/短横线，≤120字符）');
  }
  if (/^all_(?:protein|gene)$/i.test(database)) {
    throw new InvalidArgumentError(`database=${database} 是跨物种聚合库（all_protein 约1975万条、518 MB），拒绝整库枚举；请用具体物种库，例如 AABBDD_Chinese_Spring2.1.add_Description.pep`);
  }
  const url = new URL(`${manifest.apiBase}/sequence/chromosomes`);
  url.searchParams.set('database', database);
  const prepared = prepareRequest({ url: url.href, sourceName: manifest.displayName, presentation: { list_ids: true } });
  const res = await fetchPrepared(ctx, prepared);
  if (res.status !== 200 || !res.data || typeof res.data !== 'object' || Array.isArray(res.data)) {
    throw new UpstreamShapeError('序列ID清单响应不是约定的200 JSON对象', { url: prepared.url });
  }
  const envelope = res.data as Record<string, unknown>;
  if (envelope.success !== true || !envelope.data || typeof envelope.data !== 'object' || Array.isArray(envelope.data)) {
    throw new UpstreamShapeError('序列ID清单响应结构不符', { url: prepared.url });
  }
  const data = envelope.data as Record<string, unknown>;
  if (data.database !== database || !Number.isSafeInteger(data.count) || (data.count as number) < 0
    || !Array.isArray(data.chromosomes) || data.count !== data.chromosomes.length) {
    throw new UpstreamShapeError('序列ID清单的database/count/chromosomes与约定不符', { url: prepared.url });
  }
  const ids = data.chromosomes.map((item) => {
    if (typeof item !== 'string' || item.length === 0 || item.length > 200) {
      throw new UpstreamShapeError('序列ID清单含非法ID', { url: prepared.url });
    }
    return item;
  });
  if (ids.length > MAX_LISTED_IDS) {
    throw new InvalidArgumentError(`database=${database} 有 ${ids.length} 条序列，超过 ${MAX_LISTED_IDS} 条的单次枚举上限；请换更具体的库`);
  }
  const body = [
    `序列ID清单｜database=${database}`,
    `共 ${ids.length} 条序列ID${includeRecords ? '；完整清单见 structuredContent。' : '；本次未请求完整清单，设 include_records=true 可取回。'}`,
    '该清单是BLAST库里的序列ID（蛋白库带转录本后缀.1），不是基因组坐标。',
  ].join('\n');
  const structured = includeRecords ? {
    mode: 'list' as const,
    database,
    count: ids.length,
    ids,
  } : undefined;
  return finishResult({
    body,
    res,
    prepared,
    sourceId: manifest.id,
    extra: `${manifest.versionNote}；序列ID清单来自/sequence/chromosomes`,
    raw: { mode: 'list', database, count: ids.length },
    ...(structured ? { structured } : {}),
  });
}
