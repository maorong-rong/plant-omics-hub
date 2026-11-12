import { InvalidArgumentError, UpstreamShapeError } from '../../core/errors.js';
import { renderTable, utf8Bytes } from '../../core/format.js';
import { fetchPrepared, finishResult, MAX_BODY_BYTES, prepareRequest } from '../../core/request.js';
import { optionalStringArg, requireStringArg } from '../../core/shape.js';
import type { HttpResult, ToolContext, ToolDefinition } from '../../core/types.js';
import { manifest } from './manifest.js';

/** 与 optionalIntArg 不同：越界必须拒绝，不能夹取后照样发请求。 */
function strictInt(args: Record<string, unknown>, key: string, fallback: number, min: number, max: number): number {
  const raw = args[key];
  if (raw === undefined || raw === null) return fallback;
  if (typeof raw !== 'number' || !Number.isSafeInteger(raw) || raw < min || raw > max) {
    throw new InvalidArgumentError(`${key} 须为${min}–${max}的整数`);
  }
  return raw;
}

/** 只接实测默认注释表；表名不开放为参数，避免把别的表当成同一套坐标。 */
const ANNOTATION_TABLE = 'Genefunc_CS_IWGSC03G_table';
/** 上游 interval 端点的硬上限；本地先挡，省一次 400。 */
const MAX_REGION_BP = 30_000_000;
const MAX_REGION_CHARS = 40;

interface ProjectedRecord {
  gene_id: string;
  gene_secondary?: string;
  chromosome: string;
  start_mb: number;
  end_mb: number;
  strand?: string;
}

function projectRecord(row: Record<string, unknown>, shape: () => never): ProjectedRecord {
  if (typeof row.gene_primary !== 'string' || !/^Traes[A-Za-z0-9.]{1,30}$/.test(row.gene_primary)
    || typeof row.chromosome !== 'string' || !/^chr[0-9A-Za-z_]{1,20}$/.test(row.chromosome)
    || typeof row.start_mb !== 'number' || !Number.isFinite(row.start_mb) || row.start_mb < 0
    || typeof row.end_mb !== 'number' || !Number.isFinite(row.end_mb) || row.end_mb < row.start_mb) return shape();
  const record: ProjectedRecord = {
    gene_id: row.gene_primary,
    chromosome: row.chromosome,
    start_mb: row.start_mb,
    end_mb: row.end_mb,
  };
  // 不输出 description/domain 等自由文本；只保留可复算的结构字段。
  if (typeof row.gene_secondary === 'string' && /^Traes[A-Za-z0-9.]{1,30}$/.test(row.gene_secondary)) {
    record.gene_secondary = row.gene_secondary;
  }
  if (row.strand === '+' || row.strand === '-' || row.strand === '.') record.strand = row.strand;
  return record;
}

/** 两个模式共用的分页渲染：返回本页记录、正文与计数。 */
function paginate(records: ProjectedRecord[], offset: number, limit: number, mode: 'pfam' | 'region', label: string) {
  const total = records.length;
  const pageStart = Math.min(offset, total);
  let shown = Math.min(limit, Math.max(0, total - pageStart));
  const render = (count: number) => {
    const slice = records.slice(pageStart, pageStart + count);
    const after = total - pageStart - count;
    const head = mode === 'pfam'
      ? `Pfam ${label}：表 ${ANNOTATION_TABLE}；共 ${total} 条，展示第 ${pageStart + (count ? 1 : 0)}–${pageStart + count} 条（${count} 条）${after > 0 ? `，本页之后还有 ${after} 条` : '，已到末尾'}。`
      : `区间 ${label}：表 ${ANNOTATION_TABLE}；共 ${total} 条，展示第 ${pageStart + (count ? 1 : 0)}–${pageStart + count} 条（${count} 条）${after > 0 ? `，本页之后还有 ${after} 条` : '，已到末尾'}。`;
    return [
      head,
      '坐标单位：Mb；本地分页（offset/limit），不是上游分页。',
      count === 0
        ? (total === 0 ? '上游明确返回 count=0、records=[]；本次无匹配，不代表没有该记录。' : `offset=${offset} 已越过末尾；不是查无。`)
        : renderTable(
          ['基因', '染色体', '起点 Mb', '终点 Mb', '链'],
          slice.map((r) => [r.gene_id, r.chromosome, r.start_mb, r.end_mb, r.strand ?? '-']),
          { maxRows: count, maxCell: 40 },
        ),
    ].join('\n');
  };
  while (shown > 0 && utf8Bytes(render(shown)) > MAX_BODY_BYTES) shown -= 1;
  const body = render(shown);
  return { total, pageStart, shown, omitted: total - pageStart - shown, hasMore: pageStart + shown < total, body };
}

export const geneAnnotation: ToolDefinition = {
  name: 'wheatomics_gene_annotation',
  description: '查询 WheatOmics 小麦基因注释：按 Pfam 结构域编号（如 PF00319）或按基因组区间（如 chr1A:8650000..8660000，≤30 Mb）查默认注释表 Genefunc_CS_IWGSC03G_table。两种模式都支持本地 offset/limit 分页（上游一次返回全部记录）。坐标单位为 Mb。不是按基因 ID 查详情，也不覆盖 feature 级（外显子/CDS）注释或全植物。',
  parameters: {
    type: 'object',
    properties: {
      pfam_id: { type: 'string', description: 'Pfam 编号，例如 PF00319；与 region 互斥' },
      region: { type: 'string', description: '基因组区间，例如 chr1A:8650000..8660000；与 pfam_id 互斥，单次跨度≤30000000 bp' },
      offset: { type: 'integer', minimum: 0, maximum: 1_000_000_000, default: 0, description: '本地分页起点（0 起，表示第几个匹配记录），不是上游分页' },
      limit: { type: 'integer', minimum: 1, maximum: 20, default: 5, description: '本地每页最多展示条数（1–20，默认5）；字节预算可能进一步减少' },
      include_records: { type: 'boolean', default: false, description: 'true=把全部匹配记录放进 structuredContent（正文仍只展示本页）；批量导出用' },
    },
    additionalProperties: false,
  },
  async run(args, ctx) {
    for (const key of Object.keys(args)) {
      if (!['pfam_id', 'region', 'offset', 'limit', 'include_records'].includes(key)) {
        throw new InvalidArgumentError('基因注释查询只接受 pfam_id、region、offset、limit、include_records');
      }
    }
    const pfam = optionalStringArg(args, 'pfam_id', 20);
    const region = optionalStringArg(args, 'region', MAX_REGION_CHARS);
    if ((pfam === undefined) === (region === undefined)) {
      throw new InvalidArgumentError('pfam_id 与 region 必须且只能给一个');
    }
    const offset = strictInt(args, 'offset', 0, 0, 1_000_000_000);
    const limit = strictInt(args, 'limit', 5, 1, 20);
    const includeRecords = args.include_records === undefined ? false : args.include_records;
    if (typeof includeRecords !== 'boolean') throw new InvalidArgumentError('include_records 须为布尔值');
    if (pfam !== undefined) return runPfam(pfam, offset, limit, includeRecords, ctx);
    return runRegion(region!, offset, limit, includeRecords, ctx);
  },
};

async function runPfam(pfam: string, offset: number, limit: number, includeRecords: boolean, ctx: ToolContext) {
  if (!/^PF\d{5,6}$/.test(pfam)) throw new InvalidArgumentError('pfam_id 须为 PF 加5–6位数字，例如 PF00319');
  const url = new URL(`${manifest.apiBase}/genes/functions/pfam`);
  url.searchParams.set('ID', pfam);
  const prepared = prepareRequest({ url: url.href, sourceName: manifest.displayName, presentation: { limit, offset } });
  const res = await fetchPrepared(ctx, prepared);
  const shape = (): never => { throw new UpstreamShapeError('Pfam 响应结构、身份或计数与约定不符', { url: prepared.url }); };
  const object = (value: unknown): Record<string, unknown> => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return shape();
    return value as Record<string, unknown>;
  };
  const envelope = object(res.data);
  if (envelope.success !== true) return shape();
  const data = object(envelope.data);
  if (data.domain !== pfam || data.table !== ANNOTATION_TABLE
    || !Number.isSafeInteger(data.count) || (data.count as number) < 0 || !Array.isArray(data.records)) return shape();
  const records = data.records.map(object);
  if (data.count !== records.length) return shape();
  const projected = records.map((r) => {
    // Pfam 模式额外要求 domain 字段确实属于请求的家族，防止上游把别的家族混进来。
    if (typeof r.domain !== 'string' || !r.domain.split(';').some((part) => part.trim().startsWith(`${pfam}:`))) return shape();
    return projectRecord(r, shape);
  });
  const page = paginate(projected, offset, limit, 'pfam', pfam);
  if (utf8Bytes(page.body) > MAX_BODY_BYTES) return shape();
  const structured = includeRecords ? {
    mode: 'pfam' as const,
    table: ANNOTATION_TABLE,
    domain: pfam,
    count: projected.length,
    offset,
    records: projected,
  } : undefined;
  return finishResult({
    body: page.body,
    res,
    prepared,
    sourceId: manifest.id,
    raw: { mode: 'pfam', table: data.table, domain: pfam, count: page.total, offset, limit,
      shown: page.shown, omitted: page.omitted, has_more: page.hasMore,
      ...(page.hasMore ? { next_offset: page.pageStart + page.shown } : {}),
      records: projected.slice(page.pageStart, page.pageStart + page.shown) },
    extra: `${manifest.versionNote}；注释表由上游返回，不推断组装或注释版本`,
    ...(structured ? { structured } : {}),
  });
}

async function runRegion(region: string, offset: number, limit: number, includeRecords: boolean, ctx: ToolContext) {
  const match = /^([0-9A-Za-z_.]{1,30}):(\d{1,12})\.\.(\d{1,12})$/.exec(region);
  if (!match) throw new InvalidArgumentError('region 须形如 chr1A:8650000..8660000（染色体:起点..终点，bp）');
  const start = Number(match[2]);
  const end = Number(match[3]);
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || end < start) {
    throw new InvalidArgumentError('region 的起点/终点须为整数且 end ≥ start');
  }
  if (end - start + 1 > MAX_REGION_BP) {
    throw new InvalidArgumentError(`region 跨度 ${end - start + 1} bp 超过上游 ${MAX_REGION_BP} bp 上限；请切成≤30 Mb 的窗口`);
  }
  const url = new URL(`${manifest.apiBase}/genes/functions/interval`);
  url.searchParams.set('ID', region);
  const prepared = prepareRequest({ url: url.href, sourceName: manifest.displayName, presentation: { limit, offset } });
  const res: HttpResult = await fetchPrepared(ctx, prepared);
  const shape = (): never => { throw new UpstreamShapeError('区间注释响应结构、身份或计数与约定不符', { url: prepared.url }); };
  const object = (value: unknown): Record<string, unknown> => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return shape();
    return value as Record<string, unknown>;
  };
  const envelope = object(res.data);
  if (envelope.success !== true) return shape();
  const data = object(envelope.data);
  if (data.table !== ANNOTATION_TABLE || data.region !== region
    || !Number.isSafeInteger(data.count) || (data.count as number) < 0 || !Array.isArray(data.records)) return shape();
  const records = data.records.map(object);
  if (data.count !== records.length) return shape();
  const projected = records.map((r) => projectRecord(r, shape));
  const page = paginate(projected, offset, limit, 'region', region);
  if (utf8Bytes(page.body) > MAX_BODY_BYTES) return shape();
  const structured = includeRecords ? {
    mode: 'region' as const,
    table: ANNOTATION_TABLE,
    region,
    count: projected.length,
    offset,
    records: projected,
  } : undefined;
  return finishResult({
    body: page.body,
    res,
    prepared,
    sourceId: manifest.id,
    raw: { mode: 'region', table: data.table, region, count: page.total, offset, limit,
      shown: page.shown, omitted: page.omitted, has_more: page.hasMore,
      ...(page.hasMore ? { next_offset: page.pageStart + page.shown } : {}),
      records: projected.slice(page.pageStart, page.pageStart + page.shown) },
    extra: `${manifest.versionNote}；区间注释表由上游返回，不推断组装或注释版本`,
    ...(structured ? { structured } : {}),
  });
}
