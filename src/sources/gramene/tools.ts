import { InvalidArgumentError, UpstreamError, UpstreamShapeError } from '../../core/errors.js';
import { renderFields, utf8Bytes } from '../../core/format.js';
import { validateArgs } from '../../core/invoke.js';
import { fetchPrepared, finishResult, MAX_BODY_BYTES, prepareRequest, withRequestEvidence } from '../../core/request.js';
import type { HttpResult, JsonSchema, ToolContext, ToolDefinition } from '../../core/types.js';
import { diagnoseZero, endpointOf, renderZeroDiagnosis, zeroStructured } from './diagnosis.js';
import { manifest } from './manifest.js';

type Obj = Record<string, unknown>;

const EMAIL_PATTERN = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/;
const MAX_ID_CODE_POINTS = 64;
const MAX_IDS = 10;
const BODY_BUDGET = MAX_BODY_BYTES - 128;
const DESCRIPTION_LIMIT = 120;
const SEARCH_DOCS_SHOWN = 10;
const EXPRESSION_GROUPS_SHOWN = 2;
const EXPRESSION_EXPERIMENTS_SHOWN = 3;
const TAXON_SYNONYMS_SHOWN = 3;
/** 正文里外显子/功能域各最多展示前 N 条；完整结构走 structuredContent。 */
const EXONS_SHOWN = 8;
const DOMAINS_SHOWN = 8;
const DOMAIN_DESCRIPTION_LIMIT = 40;
/** 结构摘要单行的正文预算（UTF-8 字节）：超了先减少展示条数，不整条基因丢弃。 */
const STRUCTURE_LINE_BUDGET = 400;

const string = (description: string): JsonSchema => ({ type: 'string', description });
const integer = (minimum: number, maximum: number, value: number): JsonSchema => ({ type: 'integer', minimum, maximum, default: value });

function object(value: unknown, url: string, what: string): Obj {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new UpstreamShapeError(`${what}不是对象`, { url });
  }
  return value as Obj;
}

function nonEmptyString(value: unknown, url: string, what: string): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new UpstreamShapeError(`${what}缺失或不是非空字符串`, { url });
  }
  return value.trim();
}

function optString(data: Obj, key: string, url: string): string | undefined {
  const value = data[key];
  if (value === null || value === undefined) return undefined;
  if (typeof value !== 'string') throw new UpstreamShapeError(`字段 ${key} 类型不是字符串`, { url });
  const text = value.trim();
  return text ? text : undefined;
}

function optScalar(data: Obj, key: string, url: string): string | number | undefined {
  const value = data[key];
  if (value === null || value === undefined) return undefined;
  if (typeof value === 'string') return value.trim() ? value.trim() : undefined;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  throw new UpstreamShapeError(`字段 ${key} 既不是字符串也不是数字`, { url });
}

function countOf(data: Obj, key: string, url: string): number {
  const value = data[key];
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw new UpstreamShapeError(`字段 ${key} 不是非负数`, { url });
  }
  return value;
}

function numberField(data: Obj, key: string, url: string, what: string): number {
  const value = data[key];
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new UpstreamShapeError(`${what}的 ${key} 不是有限数字`, { url });
  }
  return value;
}

function optNumber(data: Obj, key: string, url: string, what: string): number | undefined {
  const value = data[key];
  if (value === null || value === undefined) return undefined;
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new UpstreamShapeError(`${what}的 ${key} 不是有限数字`, { url });
  }
  return value;
}

interface ExonRecord {
  id?: string;
  start: number;
  end: number;
  strand?: number;
  phase?: number;
}

interface DomainRecord {
  type: string;
  name: string;
  description?: string;
  db?: string;
  interpro?: string;
  start: number;
  end: number;
  transcript?: string;
}

interface TranscriptRecord {
  id?: string;
  exonCount: number;
  translationId?: string;
  translationLength?: number;
}

interface GeneStructureRecord {
  id: string;
  exons: ExonRecord[];
  transcripts: TranscriptRecord[];
  domains: DomainRecord[];
}

/** 读 `gene_structure`：缺失是合法形态（如实说明），存在但字段类型不符按结构漂移报错。 */
function readGeneStructure(doc: Obj, url: string): { ok: true; structure: GeneStructureRecord } | { ok: false; reason: string } {
  const raw = doc.gene_structure;
  if (raw === null || raw === undefined) return { ok: false, reason: '上游未提供 gene_structure（无外显子/功能域数据）' };
  const source = object(raw, url, 'gene_structure');

  const exons: ExonRecord[] = [];
  if (source.exons !== null && source.exons !== undefined) {
    if (!Array.isArray(source.exons)) throw new UpstreamShapeError('gene_structure.exons 不是数组', { url });
    for (const item of source.exons) {
      const exon = object(item, url, 'gene_structure.exons 成员');
      exons.push({
        id: optString(exon, 'id', url),
        start: numberField(exon, 'start', url, '外显子'),
        end: numberField(exon, 'end', url, '外显子'),
        strand: optNumber(exon, 'strand', url, '外显子'),
        phase: optNumber(exon, 'phase', url, '外显子'),
      });
    }
  }

  const transcripts: TranscriptRecord[] = [];
  const domains: DomainRecord[] = [];
  if (source.transcripts !== null && source.transcripts !== undefined) {
    if (!Array.isArray(source.transcripts)) throw new UpstreamShapeError('gene_structure.transcripts 不是数组', { url });
    for (const item of source.transcripts) {
      const transcript = object(item, url, 'gene_structure.transcripts 成员');
      const transcriptId = optString(transcript, 'id', url);
      let exonCount = 0;
      if (transcript.exons !== null && transcript.exons !== undefined) {
        if (!Array.isArray(transcript.exons)) throw new UpstreamShapeError('transcript.exons 不是数组', { url });
        exonCount = transcript.exons.length;
      }
      const translation =
        transcript.translation === null || transcript.translation === undefined
          ? undefined
          : object(transcript.translation, url, 'transcript.translation');
      transcripts.push({
        id: transcriptId,
        exonCount,
        translationId: translation ? optString(translation, 'id', url) : undefined,
        translationLength: translation ? optNumber(translation, 'length', url, 'translation') : undefined,
      });
      const features = translation?.features;
      if (features === null || features === undefined) continue;
      const featureMap = object(features, url, 'translation.features');
      for (const [type, value] of Object.entries(featureMap)) {
        if (value === null || value === undefined) continue;
        const feature = object(value, url, `translation.features.${type}`);
        if (feature.entries === null || feature.entries === undefined) continue;
        if (!Array.isArray(feature.entries)) throw new UpstreamShapeError(`translation.features.${type}.entries 不是数组`, { url });
        for (const entryItem of feature.entries) {
          const entry = object(entryItem, url, `translation.features.${type}.entries 成员`);
          domains.push({
            type,
            name: optString(entry, 'name', url) ?? optString(entry, 'id', url) ?? '（未命名）',
            description: safe(optString(entry, 'description', url)),
            db: safe(optString(entry, 'db', url)),
            interpro: safe(optString(entry, 'interpro', url)),
            start: numberField(entry, 'start', url, '功能域'),
            end: numberField(entry, 'end', url, '功能域'),
            transcript: transcriptId,
          });
        }
      }
    }
  }

  return { ok: true, structure: { id: String(doc._id ?? ''), exons, transcripts, domains } };
}

function exonLabel(exon: ExonRecord, index: number): string {
  const extra = [
    exon.strand === undefined ? undefined : `链 ${exon.strand}`,
    exon.phase === undefined ? undefined : `phase ${exon.phase}`,
  ]
    .filter(Boolean)
    .join('，');
  return `#${index + 1} ${exon.start}–${exon.end}${extra ? `（${extra}）` : ''}`;
}

function domainLabel(domain: DomainRecord): string {
  const description = domain.description === undefined
    ? ''
    : `（${[...domain.description].slice(0, DOMAIN_DESCRIPTION_LIMIT).join('')}${[...domain.description].length > DOMAIN_DESCRIPTION_LIMIT ? '…' : ''}）`;
  const type = domain.type === 'domain' ? '' : `［${domain.type}］`;
  return `${domain.name}${description} ${domain.start}–${domain.end} aa${type}`;
}

/**
 * 正文里的结构摘要：每类最多展示前 N 条，并明确「共 X 条，已展示 Y 条」。
 * 单行再按字节预算收缩展示条数——否则大基因（几十个外显子/域）整条基因会被 4 KB 闸丢掉，
 * 连“共几条”都看不到；这里宁可少展示，也要保住总数和 structuredContent 指向。
 */
function structureLines(structure: GeneStructureRecord): string[] {
  const exonLine = (() => {
    const total = structure.exons.length;
    if (total === 0) return '  外显子：共 0 条（上游 gene_structure.exons 为空）';
    let shown = Math.min(EXONS_SHOWN, total);
    for (;;) {
      const details = structure.exons.slice(0, shown).map((exon, index) => exonLabel(exon, index)).join('、');
      const line = `  外显子：共 ${total} 条，已展示 ${shown} 条（${details}${shown < total ? '、…' : ''}）${
        shown < total ? '；完整坐标见 structuredContent' : ''
      }`;
      if (utf8Bytes(line) <= STRUCTURE_LINE_BUDGET || shown <= 1) return line;
      shown -= 1;
    }
  })();

  const domainLine = (() => {
    const total = structure.domains.length;
    if (total === 0) return '  功能域：共 0 条（上游 translation.features 未给带坐标的条目）';
    const typeCounts = [...new Set(structure.domains.map((domain) => domain.type))]
      .map((type) => `${type} ${structure.domains.filter((domain) => domain.type === type).length}`)
      .join('、');
    let shown = Math.min(DOMAINS_SHOWN, total);
    for (;;) {
      const details = structure.domains.slice(0, shown).map((domain) => domainLabel(domain)).join('；');
      const line = `  功能域：共 ${total} 条（${typeCounts}），已展示 ${shown} 条（${details}${shown < total ? '；…' : ''}）${
        shown < total ? '；完整条目见 structuredContent' : ''
      }`;
      if (utf8Bytes(line) <= STRUCTURE_LINE_BUDGET || shown <= 1) return line;
      shown -= 1;
    }
  })();

  return [exonLine, domainLine];
}

function safe(text: string | undefined): string | undefined {
  if (text === undefined) return undefined;
  return EMAIL_PATTERN.test(text) ? undefined : text;
}

function safeEcho(value: unknown): string {
  const text = String(value);
  if (EMAIL_PATTERN.test(text)) return '（上游取值含联系方式，已省略）';
  return [...text].slice(0, 64).join('');
}

function scrubBody(body: string): string {
  const kept: string[] = [];
  let omitted = 0;
  for (const line of body.split('\n')) {
    if (EMAIL_PATTERN.test(line)) {
      omitted += 1;
      continue;
    }
    kept.push(line);
  }
  if (omitted === 0) return body;
  return `${kept.join('\n')}\n（另有 ${omitted} 行含联系方式文本，已整行省略）`;
}

function scrubRaw(value: unknown): unknown {
  if (typeof value === 'string') return EMAIL_PATTERN.test(value) ? null : value;
  if (Array.isArray(value)) return value.map((item) => scrubRaw(item));
  if (value && typeof value === 'object') {
    const out: Obj = {};
    for (const [key, item] of Object.entries(value as Obj)) out[key] = scrubRaw(item);
    return out;
  }
  return value;
}

function fitLines(lines: string[], url: string): string {
  let body = '';
  for (const line of lines) {
    const candidate = body ? `${body}\n${line}` : line;
    if (utf8Bytes(candidate) > BODY_BUDGET) break;
    body = candidate;
  }
  if (!body) throw new UpstreamShapeError('首个摘要行已超出正文预算，无法在不失真的前提下展示', { url });
  return body;
}

function fitBlocks(header: string, blocks: string[], url: string): { body: string; dropped: number } {
  if (utf8Bytes(header) > BODY_BUDGET) throw new UpstreamShapeError('摘要头部已超出正文预算', { url });
  let body = header;
  let dropped = 0;
  for (const block of blocks) {
    const candidate = `${body}\n${block}`;
    if (utf8Bytes(candidate) > BODY_BUDGET) {
      dropped += 1;
      continue;
    }
    body = candidate;
  }
  return { body, dropped };
}

function intArg(raw: unknown, fallback: number, minimum: number, maximum: number, key: string): number {
  if (raw === undefined || raw === null) return fallback;
  if (typeof raw !== 'number' || !Number.isInteger(raw)) throw new InvalidArgumentError(`参数 ${key} 必须是整数`);
  if (raw < minimum || raw > maximum) {
    throw new InvalidArgumentError(`参数 ${key} 必须在 ${minimum}–${maximum} 之间（收到 ${raw}），不做静默夹取`);
  }
  return raw;
}

/** 文本型 ID 列表：逗号/空白分隔，1–10 个，每个 ≤64 码点，无控制字符。 */
function idsArg(args: Record<string, unknown>): string[] {
  const raw = args.ids;
  if (typeof raw !== 'string') throw new InvalidArgumentError('参数 ids 必须是字符串（多个 ID 用逗号或空白分隔）');
  if (raw.trim() === '') throw new InvalidArgumentError('参数 ids 不能为空（尚未联网）');
  if (raw !== raw.trim()) throw new InvalidArgumentError('参数 ids 首尾含空白；本仓不改写输入，请去掉空白后重试（尚未联网）');
  if (/[\u0000-\u001F\u007F]/.test(raw)) throw new InvalidArgumentError('参数 ids 含控制字符（换行/制表符等）；请用逗号分隔（尚未联网）');
  const ids = raw.split(/[\s,;]+/).map((item) => item.trim()).filter(Boolean);
  if (ids.length === 0) throw new InvalidArgumentError('参数 ids 解析后为空');
  if (ids.length > MAX_IDS) throw new InvalidArgumentError(`参数 ids 一次最多 ${MAX_IDS} 个，收到 ${ids.length} 个；请分批查询`);
  for (const id of ids) {
    if ([...id].length > MAX_ID_CODE_POINTS) {
      throw new InvalidArgumentError(`单个 ID 超过 ${MAX_ID_CODE_POINTS} 个 Unicode 码点：${safeEcho(id)}`);
    }
    if (/[\u0000-\u001F\u007F]/.test(id)) throw new InvalidArgumentError(`ID 含控制字符：${safeEcho(id)}`);
    if (id === '.' || id === '..') throw new InvalidArgumentError('ID 不能是 "." 或 ".."');
  }
  return ids;
}

/** 请求集合与返回 `_id` 对账：多余 _id 直接判身份不符；缺少的逐个列出。 */
function reconcileIds(
  requested: string[],
  docs: Obj[],
  url: string,
  request: string,
): { returned: string[]; missing: string[] } {
  const wanted = new Set(requested);
  const returned = docs.map((doc) => String(doc._id ?? ''));
  const extras = returned.filter((id) => !wanted.has(id));
  if (extras.length > 0) {
    throw new UpstreamShapeError(
      `返回了请求集合之外的 _id：${extras.slice(0, 3).map((id) => safeEcho(id)).join('、')}——身份不符，拒绝把无关记录当结果；请检查 ID 的大小写与形式（大小写/版本后缀未由本仓验证）`,
      { url, request },
    );
  }
  const seen = new Set(returned);
  return { returned, missing: requested.filter((id) => !seen.has(id)) };
}

/** 分类单元 ID：实测只有数字型，且数字单值会被上游校验器拒绝，因此这里要求纯数字。 */
function taxonIdsArg(args: Record<string, unknown>): string[] {
  const ids = idsArg(args);
  const normalized: string[] = [];
  for (const id of ids) {
    if (!/^[0-9]{1,12}$/.test(id)) {
      throw new InvalidArgumentError(`分类单元 ID 只接受 NCBI 数字 taxid（如 4530）；收到「${safeEcho(id)}」`);
    }
    // 前导零按数值归一：上游 `_id` 是整数（4530），若不归一，`04530` 会被身份对账误判成"请求集合外"。
    const value = id.replace(/^0+(?=\d)/, '');
    if (!normalized.includes(value)) normalized.push(value);
  }
  return normalized;
}

/**
 * 拼 idList 查询串。
 *
 * 上游把 `idList` 当**数组**校验：裸数字单值（`idList=4530`）会被推断成 integer 并报 400
 * （Expected type array but found type integer）；字符串单值虽然实测能过，但那是推断的巧合，不是保证。
 * 因此**只要只有一个值，也按数组语义重复发送两次**（`idList=X&idList=X`）：
 * 实测 `genes`/`expression`/`taxonomy` 重复后都只返回 1 条文档（8,520 / 1,405 / 375 B），
 * 因此再按 `_id` 去重后输出，不会重复展示。多值则每个 ID 一个参数。
 */
function idListQuery(ids: string[]): { query: string; duplicated: boolean } {
  const duplicated = ids.length === 1;
  const parts = duplicated ? [ids[0]!, ids[0]!] : ids;
  return {
    query: parts.map((id) => `idList=${encodeURIComponent(id)}`).join('&'),
    duplicated,
  };
}

function dedupeById(docs: Obj[]): Obj[] {
  const seen = new Set<string>();
  const out: Obj[] = [];
  for (const doc of docs) {
    const key = String(doc._id);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(doc);
  }
  return out;
}

function checked(def: ToolDefinition): ToolDefinition {
  const run = def.run;
  def.run = async (args, ctx) => {
    validateArgs(def, args);
    return withRequestEvidence(ctx, (scoped) => run(args, scoped));
  };
  return def;
}

async function request(ctx: ToolContext, pathAndQuery: string) {
  const prepared = prepareRequest({ url: `${manifest.apiBase}${pathAndQuery}`, sourceName: manifest.displayName });
  const res = await fetchPrepared(ctx, prepared);
  if (res.status < 200 || res.status >= 300) {
    throw new UpstreamError(`上游 HTTP ${res.status}，不是成功结果`, {
      url: prepared.url,
      request: prepared.request,
      status: res.status,
      contentType: res.contentType,
    });
  }
  // 注意：/search 的 content-type 是 text/plain 而正文是 JSON，所以这里不按 content-type 拒绝；
  // 结构校验交给各工具的数组/对象断言。
  return { prepared, res };
}

function finish(
  body: string,
  res: HttpResult,
  raw: unknown,
  prepared: ReturnType<typeof prepareRequest>,
  extra: string,
  structured?: Record<string, unknown>,
) {
  return finishResult({
    body: scrubBody(body),
    res,
    raw: scrubRaw(raw),
    prepared,
    sourceId: manifest.id,
    extra,
    ...(structured ? { structured: scrubRaw(structured) as Record<string, unknown> } : {}),
  });
}

const search = checked({
  name: 'gramene_search',
  description:
    '在 Gramene v69 用自由文本 q 全文检索（Solr 风格）：返回上游 numFound 与前若干条命中（id/名称/分类单元/类型），并标明“本次返回 N 条”。只覆盖已实测物种（Oryza sativa / Indica Group），不声称覆盖全部禾本科；只能全文检索，不能按字段精确过滤。',
  parameters: {
    type: 'object',
    properties: {
      q: string('自由文本查询，例如 Oryza、zinc；最多128码点'),
      rows: integer(1, 50, 10),
      start: integer(0, 1000000, 0),
    },
    required: ['q'],
    additionalProperties: false,
  },
  async run(args, ctx) {
    const raw = args.q;
    if (typeof raw !== 'string') throw new InvalidArgumentError('参数 q 必须是字符串');
    const q = raw;
    if (q.trim() === '') throw new InvalidArgumentError('参数 q 不能为空（尚未联网）');
    if (q !== q.trim()) throw new InvalidArgumentError('参数 q 首尾含空白；本仓不改写输入，请去掉空白后重试（尚未联网）');
    if ([...q].length > 128) throw new InvalidArgumentError('参数 q 最多 128 个 Unicode 码点');
    if (/[\u0000-\u001F\u007F]/.test(q)) throw new InvalidArgumentError('参数 q 含控制字符（尚未联网）');
    const rows = intArg(args.rows, 10, 1, 50, 'rows');
    const start = intArg(args.start, 0, 0, 1_000_000, 'start');

    const { prepared, res } = await request(ctx, `/search?q=${encodeURIComponent(q)}&rows=${rows}&start=${start}`);
    const data = res.data;
    if (!data || typeof data !== 'object' || Array.isArray(data)) {
      throw new UpstreamShapeError('/search 响应不是对象（正文是 JSON 而非 content-type 所称的文本）', {
        url: prepared.url,
        request: prepared.request,
      });
    }
    const envelope = data as Obj;
    const response = envelope.response;
    if (!response || typeof response !== 'object' || Array.isArray(response)) {
      throw new UpstreamShapeError('/search 响应缺少 response 对象', { url: prepared.url, request: prepared.request });
    }
    const body = object(response, prepared.url, '/search 的 response');
    const numFound = countOf(body, 'numFound', prepared.url);
    if (!Array.isArray(body.docs)) {
      throw new UpstreamShapeError('/search 的 response.docs 不是数组', { url: prepared.url, request: prepared.request });
    }
    const docs = body.docs as unknown[];

    if (numFound === 0) {
      const text = [
        `检索 q=${q}：上游 numFound=0；本次请求 rows=${rows}、start=${start}；本次返回 0 条。`,
        '本次没有匹配结果（numFound=0，是合法空结果，不是上游故障）。',
        '覆盖只到已实测物种（Oryza sativa / Indica Group），不声称覆盖全部禾本科。',
      ].join('\n');
      return finish(text, res, { numFound: 0, start, rows, returned: 0, ids: [] }, prepared, '数据版本 v69（Swagger basePath）；与 Ensembl 版本对应未核验');
    }

    if (docs.length === 0) {
      if (start >= numFound) {
        const text = [
          `检索 q=${q}：上游 numFound=${numFound}；本次请求 rows=${rows}、start=${start}；本次返回 0 条。`,
          `start=${start} 已越过末页（numFound=${numFound}）：这是分页越界，不是“没有匹配”。请把 start 调回 0–${Math.max(0, numFound - 1)}。`,
          '覆盖只到已实测物种（Oryza sativa / Indica Group），不声称覆盖全部禾本科。',
        ].join('\n');
        return finish(text, res, { numFound, start, rows, returned: 0, ids: [] }, prepared, '数据版本 v69（Swagger basePath）；与 Ensembl 版本对应未核验');
      }
      throw new UpstreamShapeError(
        `docs 为空但 start=${start} 仍在 numFound=${numFound} 范围内，该空形态未实测，不判为“没有匹配”`,
        { url: prepared.url, request: prepared.request },
      );
    }

    const rowsOut: string[][] = [];
    for (const item of docs.slice(0, SEARCH_DOCS_SHOWN)) {
      const doc = object(item, prepared.url, 'search docs 成员');
      rowsOut.push([
        String(doc.id ?? '-'),
        safe(optString(doc, 'name', prepared.url)) ?? '-',
        String(optScalar(doc, 'taxon_id', prepared.url) ?? '-'),
        safe(optString(doc, 'biotype', prepared.url)) ?? '-',
      ]);
    }
    const header = [
      `检索 q=${q}：上游 numFound=${numFound}；本次请求 rows=${rows}、start=${start}；本次返回 ${docs.length} 条。`,
      `numFound 是上游命中总数，本次最多展示 ${SEARCH_DOCS_SHOWN} 条；不写“共 N 条”代替展示数。`,
      '覆盖只到已实测物种（Oryza sativa / Indica Group），不声称覆盖全部禾本科。',
    ].join('\n');
    // 逐行放进正文，并为“另有 N 条本次未展示”预留空间；shown 只能是实际进正文的行数。
    const footerFor = (shownCount: number) => `\n另有 ${rowsOut.length - shownCount} 条本次未展示（4 KB 预算）。`;
    let body2 = header;
    let shown = 0;
    for (let count = 1; count <= rowsOut.length; count += 1) {
      const table = `| id | 名称 | taxon_id | 类型 |\n| --- | --- | --- | --- |\n${rowsOut
        .slice(0, count)
        .map((row) => `| ${row.map((cell) => String(cell).replace(/\|/g, '/')).join(' | ')} |`)
        .join('\n')}`;
      const candidate = `${header}\n${table}`;
      const needsFooter = count < rowsOut.length;
      if (utf8Bytes(needsFooter ? `${candidate}${footerFor(count)}` : candidate) > BODY_BUDGET) break;
      body2 = candidate;
      shown = count;
    }
    if (shown < rowsOut.length) body2 = `${body2}${footerFor(shown)}`;
    return finish(
      body2,
      res,
      { numFound, start, rows, returned: docs.length, shown, ids: rowsOut.map((row) => row[0]) },
      prepared,
      '数据版本 v69（Swagger basePath）；/search 的 content-type 为 text/plain，正文是 JSON',
    );
  },
});

const gene = checked({
  name: 'gramene_gene',
  description:
    '按精确文档 ID 列表取 Gramene 基因记录（这是 /genes 的 idList 入口，不是按名称检索）：名称、描述、类型、分类单元、物种系统名与位置。可选 include_structure=true 附带外显子坐标（start/end，相对基因模型起点、不是染色体坐标；上游给 strand/phase 时一并给出）与功能域起止（name/description/aa start/end）；正文每类只列前 8 条并写明“共 X 条，已展示 Y 条”，完整结构放在 structuredContent。默认 false，输出与旧版一致。单条原始响应约 8.5 KB（含 xrefs），本工具只输出裁剪后的关键字段、不返回 xrefs；查无是 200 + 空数组，不能据此断言记录不存在；回 0 时会给出 zero_reason 与输入 ID 空间诊断。',
  parameters: {
    type: 'object',
    properties: {
      ids: string('一个或多个文档 ID，逗号或空白分隔，最多10个，例如 BGIOSGA001967'),
      include_structure: {
        type: 'boolean',
        description: '为 true 时附带外显子与功能域（正文每类最多 8 条，完整结构见 structuredContent）；默认 false，不改变原输出',
        default: false,
      },
    },
    required: ['ids'],
    additionalProperties: false,
  },
  async run(args, ctx) {
    const ids = idsArg(args);
    const rawInclude = args.include_structure;
    if (rawInclude !== undefined && rawInclude !== null && typeof rawInclude !== 'boolean') {
      throw new InvalidArgumentError('参数 include_structure 必须是布尔值');
    }
    const includeStructure = rawInclude === true;
    const { query, duplicated } = idListQuery(ids);
    const { prepared, res } = await request(ctx, `/genes?${query}`);
    if (!Array.isArray(res.data)) {
      throw new UpstreamShapeError('/genes 响应不是数组（查无是空数组，不是对象）', { url: prepared.url, request: prepared.request });
    }
    const docs = (res.data as unknown[]).map((item) => object(item, prepared.url, '基因文档'));
    const unique = duplicated ? dedupeById(docs) : docs;
    const { missing } = reconcileIds(ids, unique, prepared.url, prepared.request);

    const header = [
      `基因查询：请求 ${ids.length} 个 ID；本次返回 ${docs.length} 条${duplicated ? '（上游要求 idList 为数组；本仓对单个 ID 也重复发送一次，已按 _id 去重）' : ''}。`,
      missing.length > 0 ? `未返回的 ID：${missing.map((id) => safeEcho(id)).join('、')}（上游数组里没有这些 _id）` : '',
      includeStructure
        ? `已附带外显子/功能域摘要：外显子坐标相对基因模型起点（不是染色体坐标，染色体区间见“位置”），正文每类最多展示 ${EXONS_SHOWN} 条，完整结构（未截断）见 structuredContent。`
        : '本工具只输出关键字段，不含 xrefs（原始单条约 8.5 KB）。',
    ]
      .filter(Boolean)
      .join('\n');

    if (unique.length === 0) {
      const diagnosis = diagnoseZero({
        ids,
        endpoint: endpointOf(prepared.url),
        status: res.status,
        durationMs: res.durationMs,
        attempts: res.attempts,
      });
      const text = [
        `基因查询：请求 ${ids.length} 个 ID；本次返回 0 条。`,
        '本次未返回基因记录（上游空数组）。',
        renderZeroDiagnosis(diagnosis),
      ].join('\n');
      const zero = zeroStructured(diagnosis);
      const base = { requested: ids, returned: 0, ids: [] };
      return finish(
        text,
        res,
        { ...base, ...zero },
        prepared,
        '数据版本 v69（Swagger basePath）；与 Ensembl 版本对应未核验',
        includeStructure
          ? { ...base, exonCoordinateSystem: 'gene_model', genes: [], ...zero }
          : { ...base, ...zero },
      );
    }

    const blocks: string[] = [];
    const structures: Array<GeneStructureRecord & { unavailable?: string }> = [];
    for (const doc of unique) {
      const id = nonEmptyString(doc._id, prepared.url, '基因文档 _id');
      const location = doc.location === null || doc.location === undefined ? undefined : object(doc.location, prepared.url, 'location');
      const desc = safe(optString(doc, 'description', prepared.url));
      const descText = desc === undefined ? undefined : `${[...desc].slice(0, DESCRIPTION_LIMIT).join('')}${[...desc].length > DESCRIPTION_LIMIT ? '…（已截断）' : ''}`;
      const lines = [
        `- ${id}｜${safe(optString(doc, 'name', prepared.url)) ?? '（无名称）'}（${safe(optString(doc, 'biotype', prepared.url)) ?? '无类型'}）`,
      ];
      if (descText) lines.push(`  描述：${descText}`);
      const fields = renderFields([
        ['物种系统名', safe(optString(doc, 'system_name', prepared.url))],
        ['taxon_id', optScalar(doc, 'taxon_id', prepared.url)],
        ['位置', location ? `${String(optScalar(location, 'region', prepared.url) ?? '?')}:${String(optScalar(location, 'start', prepared.url) ?? '?')}-${String(optScalar(location, 'end', prepared.url) ?? '?')}（链 ${String(optScalar(location, 'strand', prepared.url) ?? '?')}）` : undefined],
        ['装配', location ? safe(optString(location, 'map', prepared.url)) : undefined],
      ]);
      if (fields) lines.push(...fields.split('\n').map((line) => `  ${line}`));
      if (includeStructure) {
        const reading = readGeneStructure(doc, prepared.url);
        if (reading.ok) {
          structures.push(reading.structure);
          lines.push(...structureLines(reading.structure));
        } else {
          structures.push({ id, exons: [], transcripts: [], domains: [], unavailable: reading.reason });
          lines.push(`  结构：${reading.reason}`);
        }
      }
      blocks.push(lines.join('\n'));
    }

    const fitted = fitBlocks(header, blocks, prepared.url);
    const omission = fitted.dropped > 0 ? `\n另有 ${fitted.dropped} 条基因本次未展示（4 KB 预算，整条省略）。` : '';
    const body = utf8Bytes(`${fitted.body}${omission}`) <= BODY_BUDGET ? `${fitted.body}${omission}` : fitted.body;
    return finish(
      body,
      res,
      {
        requested: ids,
        duplicatedForNumericSingle: duplicated,
        returned: docs.length,
        ids: unique.map((doc) => String(doc._id)),
        missingIds: missing,
        droppedBlocks: fitted.dropped,
      },
      prepared,
      '数据版本 v69（Swagger basePath）；description 超过 120 字会标注截断',
      includeStructure ? { requested: ids, returned: docs.length, exonCoordinateSystem: 'gene_model', genes: structures } : undefined,
    );
  },
});

const expression = checked({
  name: 'gramene_expression',
  description:
    '按精确基因文档 ID 取 Gramene v69 的差异表达记录（/expression 的 idList 入口）：按实验列出 group、p_value、l2fc，最多展示 3 个实验、每实验 2 个比较。数值是上游原值，本工具不做显著性判定、不做跨实验合并；查无是 200 + 空数组。',
  parameters: { type: 'object', properties: { ids: string('一个或多个基因文档 ID，逗号或空白分隔，最多10个，例如 BGIOSGA001967') }, required: ['ids'], additionalProperties: false },
  async run(args, ctx) {
    const ids = idsArg(args);
    const { query, duplicated } = idListQuery(ids);
    const { prepared, res } = await request(ctx, `/expression?${query}`);
    if (!Array.isArray(res.data)) {
      throw new UpstreamShapeError('/expression 响应不是数组（查无是空数组，不是对象）', { url: prepared.url, request: prepared.request });
    }
    const docs = (res.data as unknown[]).map((item) => object(item, prepared.url, '表达文档'));
    const unique = duplicated ? dedupeById(docs) : docs;
    const { missing } = reconcileIds(ids, unique, prepared.url, prepared.request);

    const header = [
      `表达查询：请求 ${ids.length} 个 ID；本次返回 ${docs.length} 条${duplicated ? '（单个 ID 按数组语义重复发送，已按 _id 去重）' : ''}。`,
      missing.length > 0 ? `未返回的 ID：${missing.map((id) => safeEcho(id)).join('、')}（上游数组里没有这些 _id）` : '',
      '数值是上游 p_value / l2fc 原值，不做显著性判定，也不跨实验合并。',
    ]
      .filter(Boolean)
      .join('\n');

    if (unique.length === 0) {
      const text = `${header}\n本次未返回表达记录（上游空数组，本次返回 0 条）。`;
      return finish(text, res, { requested: ids, returned: 0, ids: [] }, prepared, '数据版本 v69（Swagger basePath）');
    }

    const blocks: string[] = [];
    for (const doc of unique) {
      const id = nonEmptyString(doc._id, prepared.url, '表达文档 _id');
      const experiments = Object.entries(doc).filter(([key]) => key.startsWith('E-'));
      const lines = [`- ${id}：本次返回 ${experiments.length} 个实验`];
      for (const [name, value] of experiments.slice(0, EXPRESSION_EXPERIMENTS_SHOWN)) {
        if (!Array.isArray(value)) throw new UpstreamShapeError(`实验 ${name} 的记录不是数组`, { url: prepared.url });
        lines.push(`  ${name}：${value.length} 个比较`);
        for (const row of value.slice(0, EXPRESSION_GROUPS_SHOWN)) {
          const entry = object(row, prepared.url, '表达比较');
          lines.push(
            `    ${safe(optString(entry, 'group', prepared.url)) ?? '（无 group）'}｜p_value ${String(optScalar(entry, 'p_value', prepared.url) ?? '?')}｜l2fc ${String(optScalar(entry, 'l2fc', prepared.url) ?? '?')}`,
          );
        }
        if (value.length > EXPRESSION_GROUPS_SHOWN) lines.push(`    …该实验另有 ${value.length - EXPRESSION_GROUPS_SHOWN} 个比较未展示`);
      }
      if (experiments.length > EXPRESSION_EXPERIMENTS_SHOWN) lines.push(`  …另有 ${experiments.length - EXPRESSION_EXPERIMENTS_SHOWN} 个实验未展示`);
      blocks.push(lines.join('\n'));
    }

    const fitted = fitBlocks(header, blocks, prepared.url);
    const omission = fitted.dropped > 0 ? `\n另有 ${fitted.dropped} 条基因本次未展示（4 KB 预算）。` : '';
    const body = utf8Bytes(`${fitted.body}${omission}`) <= BODY_BUDGET ? `${fitted.body}${omission}` : fitted.body;
    return finish(
      body,
      res,
      { requested: ids, returned: docs.length, ids: unique.map((doc) => String(doc._id)), missingIds: missing, droppedBlocks: fitted.dropped },
      prepared,
      '数据版本 v69（Swagger basePath）；p_value/l2fc 为上游原值',
    );
  },
});


const taxonomy = checked({
  name: 'gramene_taxonomy',
  description:
    '按 NCBI 数字 taxid 取 Gramene v69 的分类单元记录（/taxonomy 的 idList 入口）：名称、rank、基因数、同义名与祖先链长度。只接受数字 taxid（如 4530 / 39946001），前导零按数值归一（04530 与 4530 视为同一 taxid）；实测数值型单值直接传会被上游校验器拒绝，本仓重复一次发送，输出会注明这条规避写法。查无是 200 + 空数组，不能据此断言 taxid 不存在。',
  parameters: { type: 'object', properties: { ids: string('一个或多个 NCBI 数字 taxid，逗号或空白分隔，最多10个，例如 4530,39946001') }, required: ['ids'], additionalProperties: false },
  async run(args, ctx) {
    const ids = taxonIdsArg(args);
    const { query, duplicated } = idListQuery(ids);
    const { prepared, res } = await request(ctx, `/taxonomy?${query}`);
    if (!Array.isArray(res.data)) {
      throw new UpstreamShapeError('/taxonomy 响应不是数组（查无是空数组，不是对象）', { url: prepared.url, request: prepared.request });
    }
    const docs = (res.data as unknown[]).map((item) => object(item, prepared.url, '分类单元文档'));
    const unique = duplicated ? dedupeById(docs) : docs;
    const { missing } = reconcileIds(ids, unique, prepared.url, prepared.request);

    const header = [
      `分类单元查询：请求 ${ids.length} 个 taxid；本次返回 ${docs.length} 条${duplicated ? '（上游要求数组；本仓对单个 ID 也重复发送一次，已按 _id 去重）' : ''}。`,
      missing.length > 0 ? `未返回的 ID：${missing.map((id) => safeEcho(id)).join('、')}（上游数组里没有这些 _id）` : '',
      'ancestors 是上游给的 taxid 链，不含名称。',
    ]
      .filter(Boolean)
      .join('\n');

    if (unique.length === 0) {
      const text = `${header}\n本次未返回分类单元记录（上游空数组，本次返回 0 条）；不能据此断言该 taxid 不存在。`;
      return finish(text, res, { requested: ids, returned: 0, ids: [] }, prepared, '数据版本 v69（Swagger basePath）');
    }

    const blocks: string[] = [];
    for (const doc of unique) {
      const id = String(doc._id ?? '');
      if (!id) throw new UpstreamShapeError('分类单元文档缺少 _id', { url: prepared.url });
      const ancestors = Array.isArray(doc.ancestors) ? doc.ancestors.length : undefined;
      const synonyms = Array.isArray(doc.synonym) ? doc.synonym.filter((item): item is string => typeof item === 'string').slice(0, TAXON_SYNONYMS_SHOWN) : [];
      blocks.push(
        [
          `- ${id}｜${safe(optString(doc, 'name', prepared.url)) ?? '（无名称）'}（${safe(optString(doc, 'rank', prepared.url)) ?? '无 rank'}）`,
          `  基因数 num_genes：${String(optScalar(doc, 'num_genes', prepared.url) ?? '未知')}`,
          ancestors === undefined ? undefined : `  祖先链长度：${ancestors}（上游只给 taxid，未给名称）`,
          synonyms.length ? `  同义名：${synonyms.join('、')}` : undefined,
        ]
          .filter(Boolean)
          .join('\n'),
      );
    }

    const fitted = fitBlocks(header, blocks, prepared.url);
    const omission = fitted.dropped > 0 ? `\n另有 ${fitted.dropped} 个分类单元本次未展示（4 KB 预算）。` : '';
    const body = utf8Bytes(`${fitted.body}${omission}`) <= BODY_BUDGET ? `${fitted.body}${omission}` : fitted.body;
    return finish(
      body,
      res,
      { requested: ids, returned: docs.length, ids: unique.map((doc) => String(doc._id)), missingIds: missing, droppedBlocks: fitted.dropped },
      prepared,
      '数据版本 v69（Swagger basePath）；num_genes 为上游字段',
    );
  },
});

export const tools: ToolDefinition[] = [search, gene, expression, taxonomy];
