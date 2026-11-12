import { InvalidArgumentError, UpstreamError, UpstreamShapeError } from '../../core/errors.js';
import { provenance, renderFields, renderTable, utf8Bytes } from '../../core/format.js';
import {
  fetchPrepared,
  finishResult,
  MAX_BODY_BYTES,
  MAX_TAIL_BYTES,
  prepareRequest,
} from '../../core/request.js';
import type { PreparedRequest } from '../../core/request.js';
import {
  objectsOf,
  optionalArrayField,
  optionalIntArg,
  optionalStringArg,
  requireArrayField,
  requireStringArg,
  splitIds,
} from '../../core/shape.js';
import type { HttpResult, ToolContext, ToolDefinition, ToolResult } from '../../core/types.js';
import { manifest } from './manifest.js';
import { geneAnnotation } from './annotation.js';
import { geneSequence } from './sequence.js';
import {
  diagnoseZero,
  generationLabel,
  renderZeroDiagnosis,
  responseBytes,
} from './diagnosis.js';
import type { GenerationSupport } from './diagnosis.js';

// ── 上游信封（按 2026-10-27 实测写；**只有信封是本人确认过的契约**） ──────────

interface Envelope<T> {
  success?: boolean;
  message?: string;
  timestamp?: string;
  data?: T;
}

/** 单次批量查询的基因数上限。上游没写死，我们自己定，避免拼出超长 URL。 */
const MAX_GENES_PER_QUERY = 50;
/** 基因 ID 换算单次上限（ID 用 CRLF 拼进查询串，太长会被网关拒）。 */
const MAX_IDS_PER_CONVERSION = 200;
/**
 * resolve 模式单次上限：`/api/genes/resolve` 只能逐 ID 查（实测约 0.7 s/个），
 * 20 个约 14 s；再大就撞调用方耐心与超时预算，宁可报错让调用方分批。
 */
const MAX_RESOLVE_IDS = 20;
/** 表达条件默认展示条数（仅当条件超过全展开阈值时才截断）。 */
const DEFAULT_TOP_CONDITIONS = 8;
/** 条件数不超过这个值就全部展示，不做截断。 */
const MAX_INLINE_CONDITIONS = 20;

// ── 小工具 ────────────────────────────────────────────────────────────────

function endpoint(path: string, query?: Record<string, string | number | undefined>): string {
  const url = new URL(`${manifest.apiBase}${path}`);
  for (const [key, value] of Object.entries(query ?? {})) {
    if (value === undefined || value === '') continue;
    url.searchParams.set(key, String(value));
  }
  return url.toString();
}

/** 拆掉 `{success,message,data}` 信封；success=false 直接抛，因为此时 data 不可用。 */
function unwrap<T>(payload: unknown, url: string): T {
  const envelope = payload as Envelope<T> | null;
  if (!envelope || typeof envelope !== 'object' || !('data' in envelope)) {
    throw new UpstreamError('上游响应不是约定的 {success,message,data} 信封——契约可能已变', {
      url,
      bodySnippet: envelope ? `keys=${Object.keys(envelope).slice(0, 10).join(',')}` : 'non-object',
    });
  }
  if (envelope.success === false) {
    throw new UpstreamError(`上游 success=false：${envelope.message ?? '未给原因'}`, { url });
  }
  if (envelope.data === undefined || envelope.data === null) {
    throw new UpstreamError('上游 data 为空', { url });
  }
  return envelope.data;
}

/** 预检在网络之前；局部result闭包保证收尾使用同一份完整请求证据。 */
async function query(ctx: ToolContext, url: string, presentation: Record<string, unknown> = {}) {
  const prepared = prepareRequest({ url, sourceName: manifest.displayName, presentation });
  const res = await fetchPrepared(ctx, prepared);
  const result = (body: string, response: HttpResult, raw: unknown, extra?: string,
    structured?: Record<string, unknown>): ToolResult =>
    finishResult({ body, res: response, raw, prepared, sourceId: manifest.id,
      ...(structured ? { structured } : {}),
      extra: [manifest.versionNote, extra].filter(Boolean).join('；') });
  return { res, result };
}

function num(value: unknown, digits = 3): string {
  /**
   * 缺值不许变成 0（2026-11-01）：`Number(null) === 0`、`Number('') === 0`，
   * 直接转会把"上游没给"渲染成"0"，用户会当成"确实为零"——与 STRING 的 `score:null→0` 同一条纪律。
   * 这里只做展示，但展示出来的假 0 同样会让人做错判断。
   */
  if (value === null || value === undefined || value === '') return '未提供';
  if (typeof value === 'object') return '未提供';
  const n = Number(value);
  if (!Number.isFinite(n)) return '-';
  return Number(n.toFixed(digits)).toString();
}

/**
 * 数值字段的**安全取数**。
 *
 * `Number(null) === 0`、`Number('') === 0`、`Number(undefined) === NaN`——
 * 前两个会把手上的"缺值"渲染成"表达量 0 ± 0"，看起来完全正常，实际是**编造数据**
 * （审查 P1）。所以缺值一律判为 NaN，由 `num()` 渲染成 `-`。
 */
function toNum(value: unknown): number {
  if (value === null || value === undefined || value === '') return Number.NaN;
  if (typeof value === 'object') return Number.NaN;
  const n = Number(value);
  return Number.isFinite(n) ? n : Number.NaN;
}

function str(value: unknown): string | undefined {
  if (value === null || value === undefined) return undefined;
  const text = String(value).trim();
  return text.length ? text : undefined;
}

/**
 * 上游把「对照物种」压成一列，值可能是**逗号分隔的多个基因 ID**，也可能是一个点号（无记录）。
 * 拆成数组是为了模型能直接机器消费；`.` / 空 / null 一律算「无对应记录」。
 */
function splitCounterparts(value: unknown): string[] {
  const text = str(value);
  if (!text || text === '.') return [];
  return text
    .split(',')
    .map((item) => item.trim())
    .filter((item) => item.length > 0 && item !== '.');
}

/** 固定大小切片；不丢尾部（最后一片可以更短）。 */
function chunk<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let index = 0; index < items.length; index += size) out.push(items.slice(index, index + size));
  return out;
}

/**
 * 按 UTF-8 字节预算「多显示一条是一点」地收敛正文：`build(shown)` 必须**单调**（shown 越大越长）。
 * 返回实际展示条数与最终文本——展示条数只能等于**真正渲染出来的条数**，不许用结论证明结论。
 */
function fitLines(
  budget: number,
  total: number,
  build: (shown: number) => string[],
): { text: string; shown: number } {
  let shown = total;
  let text = build(shown).join('\n');
  while (shown > 0 && utf8Bytes(text) > budget) {
    shown -= 1;
    text = build(shown).join('\n');
  }
  return { text, shown };
}

/**
 * 表达值的 three-state：上游没有 missing 标记，`value=0` 既可能是真 0，也可能是没测。
 *
 * 这条是 #75 真跑暴露的：302×15 矩阵里 34 个基因全 0，分析层只能把 0 留白。
 * 工具层不许把 0 当 0 —— 分不清就标 `zero_or_unmeasured`，由调用方决定怎么用。
 */
type ExpressionStatus = 'measured' | 'zero_or_unmeasured' | 'missing' | 'unknown';

function expressionStatus(value: number, std: number): ExpressionStatus {
  if (!Number.isFinite(value)) return 'unknown';
  if (value === 0 && (!Number.isFinite(std) || std === 0)) return 'zero_or_unmeasured';
  return 'measured';
}

// ── 工具 ──────────────────────────────────────────────────────────────────

const searchKnownGenes: ToolDefinition = {
  name: 'wheatomics_search_known_genes',
  description:
    '在小麦「已克隆功能基因」库里模糊搜索（基因 ID、基因名、性状、物种、DOI 均可命中）。'
    + '当用户问「小麦里调控某某性状的有哪些已知基因」「TaVRN1 是什么基因」时先调这个；'
    + '返回的是人工整理过的克隆基因条目，不同于全基因组注释。',
  parameters: {
    type: 'object',
    properties: {
      searchid: {
        type: 'string',
        description: '搜索关键词，支持部分匹配，例如 VRN1、TaMs5-B、male sterility、vernalization',
      },
      limit: {
        type: 'integer',
        description: '最多返回多少条（1–50，默认 15）',
        default: 15,
        minimum: 1,
        maximum: 50,
      },
    },
    required: ['searchid'],
    additionalProperties: false,
  },
  async run(args, ctx: ToolContext): Promise<ToolResult> {
    const searchid = requireStringArg(args, 'searchid', 200);
    const limit = optionalIntArg(args, 'limit', 15, 1, 50);
    const url = endpoint('/genes/known/search', { searchid });
    const { res, result } = await query(ctx, url, { limit });
    const data = unwrap<unknown>(res.data, url);

    // 字段缺失 = 契约变了，不许退化成「没有匹配」
    const records = objectsOf(requireArrayField(data, 'records', url, '已知基因搜索'));
    const total = Number((data as { total?: unknown }).total);

    if (records.length === 0) {
      return result(
        `没有匹配「${searchid}」的已知克隆基因（上游明确返回 0 条，不是解析失败）。`,
        res,
        data,
        `total=0`,
      );
    }

    const rows = records.slice(0, limit).map((r) => [
      r.gene_id,
      r.gene_name,
      r.phenotype,
      r.chrom_pos,
      Array.isArray(r.dois) ? r.dois.slice(0, 2).join('; ') : r.dois,
    ]);
    const body = [
      `关键词「${searchid}」命中 ${Number.isFinite(total) ? total : records.length} 条已知克隆基因。`,
      '',
      // maxRows 必须跟随 limit，否则用户要 50 条、实际只渲染 20 条（审查 R08.4）
      renderTable(['gene_id', 'gene_name', 'phenotype', 'chrom_pos', 'DOI'], rows, {
        maxCell: 45,
        maxRows: limit,
      }),
    ].join('\n');

    return result(body, res, data, `total=${Number.isFinite(total) ? total : records.length}`);
  },
};

const geneDetail: ToolDefinition = {
  name: 'wheatomics_gene_detail',
  description:
    '按基因 ID 取小麦基因的标准化详情（描述、染色体位置、蛋白长度、分子量、等电点、功能注释、JBrowse 链接）；'
    + '或按 dataset_id 取 WheatOmics 基因组目录记录（gene_count、genome_size、gene_table、blast_pep_db、版本字段）。'
    + '接受 01G / 02G / 03G 三种前缀的 ID（上游各端点对这三个版本叫法不完全一致，本工具按前缀识别）。'
    + '当用户给出一个具体小麦基因 ID 并想知道「它是什么、在哪、蛋白多长」，或要核对某组装/注释版本的官方基因数时用这个。',
  parameters: {
    type: 'object',
    properties: {
      gene_id: {
        type: 'string',
        description: '小麦基因 ID，例如 TraesCS5A02G391700（02G）、TraesCS5A01G391700（01G）、TraesCS5A03G0935400（03G）',
      },
      dataset_id: {
        type: 'string',
        description: '基因组目录 ID，例如 Chinese_Spring1.0 / Chinese_Spring2.1；与 gene_id 互斥',
      },
    },
    additionalProperties: false,
  },
  async run(args, ctx) {
    for (const key of Object.keys(args)) {
      if (!['gene_id', 'dataset_id'].includes(key)) throw new InvalidArgumentError('基因详情只接受 gene_id 或 dataset_id');
    }
    if ((args.gene_id === undefined) === (args.dataset_id === undefined)) {
      throw new InvalidArgumentError('gene_id 与 dataset_id 必须且只能给一个');
    }
    if (args.dataset_id !== undefined) return runDataset(args, ctx);
    const geneId = requireStringArg(args, 'gene_id', 200);
    const url = endpoint(`/genes/detail/${encodeURIComponent(geneId)}`);
    const { res, result } = await query(ctx, url);
    const data = unwrap<Record<string, unknown>>(res.data, url);

    const start = data.start;
    const end = data.end;
    const span = typeof start === 'number' && typeof end === 'number' ? `${start}–${end}` : undefined;
    const body = renderFields([
      ['查询基因', data.query_gene ?? geneId],
      ['对应 ID（同源版本）', data.gene_ids],
      ['描述', data.description ?? '（上游无人工描述）'],
      ['上游 genome 字段', data.genome],
      ['染色体', data.chromosome],
      ['区间', span],
      ['链方向', data.strand],
      ['蛋白长度（aa）', data.protein_length],
      // 上游 molecular_weight 未标单位：245 aa 的蛋白返回 27838.39，量级像 Da。
      // 不替它猜单位——猜错就是 1000 倍的错误（这条比"看起来完整"重要）。
      ['分子量（上游原值，单位未标注）', data.molecular_weight],
      ['等电点', data.isoelectric_point],
      ['功能注释', data.functions],
    ]);

    if (Object.keys(data).length === 0 || body === '') {
      const zero = diagnoseZero({
        endpoint: `/api/genes/detail/{gene_id}`,
        generation: generationLabel(wheatGeneration(geneId)),
        support: 'supported',
        supportBasis: 'gene_detail 接受 01G/02G/03G 前缀（工具描述与实测）',
        status: res.status,
        durationMs: res.durationMs,
        bytes: responseBytes(res),
      });
      return result(
        `上游返回了空对象：该 ID 本次未取到记录。\n${renderZeroDiagnosis(zero)}`,
        res,
        data,
        'empty',
        { query_gene: geneId, zero },
      );
    }

    return result(
      body,
      res,
      data,
    );
  },
};

/** 目录模式：只投影可核验的结构字段；版本未知就写 null，不猜。 */
async function runDataset(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
  const datasetId = requireStringArg(args, 'dataset_id', 120);
  if (!/^[A-Za-z0-9_.-]{1,120}$/.test(datasetId)) throw new InvalidArgumentError('dataset_id 只接受字母/数字/下划线/点/短横线');
  const url = endpoint(`/genomes/${encodeURIComponent(datasetId)}`);
  const { res, result } = await query(ctx, url);
  const data = unwrap<Record<string, unknown>>(res.data, url);
  if (data.dataset_id !== datasetId) throw new UpstreamShapeError('基因组目录响应dataset_id与请求不符', { url });
  if (typeof data.species !== 'string' || data.species.length === 0) {
    throw new UpstreamShapeError('基因组目录响应缺 species 字段', { url });
  }
  const numberOrNull = (key: string): number | null => {
    const value = data[key];
    if (value === null || value === undefined) return null;
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
      throw new UpstreamShapeError(`基因组目录字段 ${key} 不是非负数字`, { url });
    }
    return value;
  };
  const stringOrNull = (key: string): string | null => {
    const value = data[key];
    if (value === null || value === undefined) return null;
    if (typeof value !== 'string') throw new UpstreamShapeError(`基因组目录字段 ${key} 不是字符串`, { url });
    return value;
  };
  const geneTable = stringOrNull('gene_table');
  const projected = {
    dataset_id: datasetId,
    display_name: stringOrNull('display_name'),
    species: data.species,
    ploidy: stringOrNull('ploidy'),
    assembly_level: stringOrNull('assembly_level'),
    assembly_version: stringOrNull('assembly_version'),
    genome_size: numberOrNull('genome_size'),
    chromosome_count: numberOrNull('chromosome_count'),
    gene_count: numberOrNull('gene_count'),
    gene_table: geneTable,
    blast_pep_db: stringOrNull('blast_pep_db'),
    annotation_source: stringOrNull('annotation_source'),
    doi: stringOrNull('doi'),
    publication_year: numberOrNull('publication_year'),
  };

  // 同一次调用里顺带核对注释表的官方行数；表级接口失败不拖垮目录结果，但必须留痕。
  let tableRows: number | null = null;
  let tableRowsNote: string | null = null;
  if (geneTable) {
    const tablesUrl = endpoint('/genes/functions/tables');
    const tablesPrepared = prepareRequest({ url: tablesUrl, sourceName: manifest.displayName, presentation: { table: geneTable } });
    try {
      const tablesRes = await fetchPrepared(ctx, tablesPrepared);
      const tables = unwrap<Record<string, unknown>>(tablesRes.data, tablesUrl);
      const rows = Array.isArray(tables.tables) ? tables.tables : [];
      const hit = rows.find((row) => row && typeof row === 'object' && (row as Record<string, unknown>).name === geneTable);
      if (hit && typeof (hit as Record<string, unknown>).rows === 'number' && Number.isSafeInteger((hit as Record<string, unknown>).rows)) {
        tableRows = (hit as Record<string, unknown>).rows as number;
      } else {
        tableRowsNote = `表级接口未列出 ${geneTable}`;
      }
    } catch (error) {
      tableRowsNote = `表级接口查询失败：${error instanceof Error ? error.message.slice(0, 160) : String(error).slice(0, 160)}`;
    }
  }

  const body = renderFields([
    ['数据集', projected.dataset_id],
    ['显示名', projected.display_name],
    ['物种', projected.species],
    ['倍性', projected.ploidy],
    ['组装级别', projected.assembly_level],
    ['组装版本（上游原值）', projected.assembly_version],
    ['基因组大小（bp）', projected.genome_size],
    ['染色体数', projected.chromosome_count],
    ['官方基因数 gene_count', projected.gene_count],
    ['注释表', projected.gene_table],
    ['注释表行数（表级接口）', tableRows],
    ['蛋白 BLAST 库', projected.blast_pep_db],
    ['注释来源', projected.annotation_source],
    ['DOI', projected.doi],
    ['发表年', projected.publication_year],
  ]);
  const structured = {
    mode: 'dataset',
    ...projected,
    table_rows: tableRows,
    table_rows_note: tableRowsNote,
  };
  return result(body, res, structured, projected.gene_table ? `gene_table=${projected.gene_table}` : undefined, structured);
}

const expressionProjects: ToolDefinition = {
  name: 'wheatomics_expression_projects',
  description:
    '列出 WheatOmics 已整合的小麦表达谱项目（芯片/RNA-seq，含组织、发育期、胁迫、激素处理等）。'
    + '当用户想找「有没有干旱胁迫下的表达数据」「有哪些籽粒发育的表达谱」时用；'
    + '先用它拿到 project 标识，再调 wheatomics_expression_query。'
    + '结果按 group 汇总，可用 keyword 过滤具体项目。',
  parameters: {
    type: 'object',
    properties: {
      keyword: {
        type: 'string',
        description: '可选，在项目 id / 描述里做不区分大小写的子串过滤，例如 drought、grain、PRJEB5314',
      },
    },
    additionalProperties: false,
  },
  async run(args, ctx) {
    const keyword = optionalStringArg(args, 'keyword', 200);
    const url = endpoint('/expression/projects');
    const { res, result } = await query(ctx, url, { keyword: keyword ?? null });
    const data = unwrap<unknown>(res.data, url);
    const projects = objectsOf(requireArrayField(data, 'projects', url, '表达项目列表'));

    if (projects.length === 0) {
      return result('上游明确返回 0 个表达项目。', res, data, 'projects=0');
    }

    // 上游返回 600 KB 量级，绝不整表输出。默认只给 group 汇总。
    const byGroup = new Map<string, number>();
    for (const project of projects) {
      const group = str(project.group) ?? '(未分组)';
      byGroup.set(group, (byGroup.get(group) ?? 0) + 1);
    }

    const lines = [`共 ${projects.length} 个表达谱项目，按 group 汇总：`, ''];
    lines.push(
      renderTable(
        ['group', '项目数'],
        [...byGroup.entries()].sort((a, b) => b[1] - a[1]).map(([group, count]) => [group, count]),
        { maxCell: 50, maxRows: 30 },
      ),
    );

    if (keyword) {
      const needle = keyword.toLowerCase();
      const hits = projects.filter((project) =>
        [project.id, project.description, project.group, project.subgroup]
          .filter(Boolean)
          .some((field) => String(field).toLowerCase().includes(needle)),
      );
      lines.push('', `按关键词「${keyword}」匹配 ${hits.length} 个：`, '');
      lines.push(
        hits.length
          ? renderTable(
              ['project', 'group', 'description'],
              hits.map((project) => [project.id, project.group, project.description]),
              { maxCell: 70, maxRows: 20 },
            )
          : '（无匹配。可直接不带 keyword 看 group 汇总，或换更宽的关键词）',
      );
    } else {
      lines.push('', '提示：加 keyword 可筛出具体项目 id；拿到 id 后用 wheatomics_expression_query 查表达量。');
    }

    return result(lines.join('\n'), res, { total: projects.length }, `projects=${projects.length}`);
  },
};

const expressionQuery: ToolDefinition = {
  name: 'wheatomics_expression_query',
  description:
    '查一个或多个小麦基因在指定表达谱项目里的表达量：**均值 ± 标准差**，按表达量降序给最高的若干个条件。'
    + '当用户问「这个基因在哪些组织/处理下高表达」时用。'
    + '已给出具体条件名（如 grain）时传 condition 只看那类条件；'
    + 'project 不填则用上游默认项目，建议先用 wheatomics_expression_projects 选项目。'
    + '**正文只给摘要；完整矩阵（行=基因、列=条件、逐点 mean/std/status）在 structuredContent**，不再受 4 KB 正文上限影响。'
    + 'status：measured=上游给了有限值；zero_or_unmeasured=value=0 且 std=0/未给——上游没有 missing 标记，'
    + '**无法区分「测得 0」与「未测量」，按未知处理**，不许当 0 用；missing=该基因没有这个条件的点。'
    + '注意：表达值单位随项目而定，上游未逐点标注，**跨项目不可直接比较大小**。',
  parameters: {
    type: 'object',
    properties: {
      gene_ids: {
        type: 'string',
        description: '一个或多个基因 ID，用逗号分隔（最多 50 个），例如 TraesCS5A02G391700,TraesCS1A02G001000',
      },
      project: {
        type: 'string',
        description: '表达项目标识（来自 wheatomics_expression_projects 的 project 列），例如 PRJEB5314_paired_tbl',
      },
      condition: {
        type: 'string',
        description: '可选，按条件名子串过滤，例如 grain、root、Z85（不区分大小写）。用它可以专门看被默认排序挤掉的条件下',
      },
      top: {
        type: 'integer',
        description: '每个基因最多列多少个条件（按表达量降序，1–30，默认 8）',
        default: 8,
        minimum: 1,
        maximum: 30,
      },
    },
    required: ['gene_ids'],
    additionalProperties: false,
  },
  async run(args, ctx) {
    // 逗号/空白分隔的多基因；上游也支持重复参数，这里统一用逗号串
    const ids = splitIds(requireStringArg(args, 'gene_ids', 2_000), MAX_GENES_PER_QUERY, 'gene_ids');
    const project = optionalStringArg(args, 'project', 200);
    const condition = optionalStringArg(args, 'condition', 100);
    const top = optionalIntArg(args, 'top', DEFAULT_TOP_CONDITIONS, 1, 30);

    const url = endpoint('/expression/query', { gene_ids: ids.join(','), project });
    const { res, result } = await query(ctx, url, { condition: condition ?? null, top });
    const data = unwrap<Record<string, unknown>>(res.data, url);

    const results = objectsOf(requireArrayField(data, 'results', url, '表达查询'));
    const needle = condition?.toLowerCase();

    interface KeptPoint { label: string; value: number; std: number }
    interface MatrixRow {
      gene_id: string;
      project: string | null;
      values: Array<{ label: string; mean: number | null; std: number | null; status: ExpressionStatus }>;
      measured_count: number;
      zero_or_unmeasured_count: number;
      missing_count: number;
      unknown_count: number;
    }

    // 列 = 上游返回的条件（按出现顺序求并集）。行 = 基因；某基因没给的条件点记 missing，不补 0。
    const conditionOrder: string[] = [];
    const perGene = results.map((entry) => {
      const points: KeptPoint[] = (optionalArrayField(entry, 'points', url, '表达查询') ?? []).map((raw) => {
        const p = raw as { label?: unknown; value?: unknown; std?: unknown };
        return { label: str(p.label) ?? '?', value: toNum(p.value), std: toNum(p.std) };
      });
      const kept = needle ? points.filter((p) => p.label.toLowerCase().includes(needle)) : points;
      for (const point of kept) if (!conditionOrder.includes(point.label)) conditionOrder.push(point.label);
      return { geneId: str(entry.gene_id) ?? '?', project: str(entry.project) ?? null, kept };
    });

    const rows: MatrixRow[] = perGene.map(({ geneId, project: geneProject, kept }) => {
      const byLabel = new Map(kept.map((point) => [point.label, point] as const));
      const values = conditionOrder.map((label) => {
        const point = byLabel.get(label);
        if (!point) return { label, mean: null, std: null, status: 'missing' as const };
        return {
          label,
          mean: Number.isFinite(point.value) ? point.value : null,
          std: Number.isFinite(point.std) ? point.std : null,
          status: expressionStatus(point.value, point.std),
        };
      });
      return {
        gene_id: geneId,
        project: geneProject,
        values,
        measured_count: values.filter((value) => value.status === 'measured').length,
        zero_or_unmeasured_count: values.filter((value) => value.status === 'zero_or_unmeasured').length,
        missing_count: values.filter((value) => value.status === 'missing').length,
        unknown_count: values.filter((value) => value.status === 'unknown').length,
      };
    });

    const header: string[] = [`项目：${str(data.project) ?? project ?? '(上游默认)'}｜找到基因 ${num(data.genes_found, 0)} 个`];
    const notFound = data.genes_not_found;
    if (Array.isArray(notFound) && notFound.length > 0) {
      header.push(`未找到：${notFound.slice(0, 20).join(', ')}${notFound.length > 20 ? ` 等 ${notFound.length} 个` : ''}`);
    }
    const converted = data.genes_converted;
    if (converted && typeof converted === 'object' && !Array.isArray(converted)) {
      const pairs = Object.entries(converted as Record<string, unknown>);
      if (pairs.length > 0) {
        // 正文只列前 3 对（一行 3 对 ≈ 150 B，列 5 对会挤掉两条基因摘要）；完整转换表在 structuredContent.genes_converted。
        header.push(`ID 版本已由上游自动转换：${pairs.slice(0, 3).map(([from, to]) => `${from} → ${String(to)}`).join('；')}`
          + `${pairs.length > 3 ? ` 等 ${pairs.length} 个` : ''}`);
      }
    }

    /**
     * 单基因查询保留逐条件明细（用户问"这个基因在哪些组织高表达"时最有用）；
     * 多基因查询改**一行一基因的紧凑摘要**——不然 12 个基因 × 15 个条件的逐条件串会把
     * 1408 B 正文预算吃光，出现「正文展示 0 个基因」这种废摘要。
     */
    const compact = rows.length > 1;
    const lineFor = (index: number): string => {
      const { geneId, kept } = perGene[index]!;
      const row = rows[index]!;
      const counts = `有值 ${row.measured_count}、零或未测 ${row.zero_or_unmeasured_count}、缺 ${row.missing_count}`;
      if (compact) {
        const best = row.values
          .filter((value) => value.mean !== null && value.status !== 'missing')
          .reduce<null | { label: string; mean: number }>((acc, value) => (
            acc === null || (value.mean as number) > acc.mean ? { label: value.label, mean: value.mean as number } : acc
          ), null);
        const top = row.measured_count === 0
          ? `无已确认表达值（${row.zero_or_unmeasured_count} 个 0 或未测量）`
          : best ? `最高 ${best.label}=${num(best.mean)}` : '无可用数值';
        return `- ${geneId}：${top}（共 ${row.values.length} 个条件；${counts}）`;
      }
      /**
       * 条件少就**全给**（15 个条件也就 300 字符），条件多才按表达量降序截前 N。
       *
       * 这条是审查 R02 直接逼出来的：原来无脑 `slice(0, 12)`，而 WheatOmics 的点是
       * 按组织/发育期排好序的，籽粒条件排在最后 —— 真实 fixture 里 3 个 grain 条件
       * 全部被裁掉，用户问"籽粒里怎么表达"时工具给不出答案，却也没报错。
       */
      const showAll = kept.length <= MAX_INLINE_CONDITIONS;
      const ordered = showAll
        ? kept
        : [...kept].sort(
            (a, b) => (Number.isFinite(b.value) ? b.value : -Infinity) - (Number.isFinite(a.value) ? a.value : -Infinity),
          );
      const shown = showAll ? ordered : ordered.slice(0, top);

      const rendered = shown
        .map((p) => `${p.label}=${num(p.value)}${Number.isFinite(p.std) ? `±${num(p.std)}` : ''}`)
        .join('；');

      // 用 reduce 而不是 Math.min(...arr)：点数上万时 spread 会 RangeError
      const finiteValues = kept.map((p) => p.value).filter((v) => Number.isFinite(v));
      let range = '';
      if (finiteValues.length > 0) {
        const { min, max } = finiteValues.reduce(
          (acc, v) => ({ min: Math.min(acc.min, v), max: Math.max(acc.max, v) }),
          { min: Number.POSITIVE_INFINITY, max: Number.NEGATIVE_INFINITY },
        );
        range = `，范围 ${num(min)}–${num(max)}`;
      }
      const scope = needle ? `含「${condition}」的 ${kept.length} 个条件` : `共 ${kept.length} 个条件`;
      const omitted = kept.length > shown.length
        ? `，按表达量降序列前 ${shown.length}（其余用 condition / top 继续查看）`
        : '';
      return `- ${geneId}：${rendered || '无数据'}（${scope}${omitted}${range}；${counts}）`;
    };

    const footer = [
      '',
      '（正文只给摘要；完整矩阵（行=基因、列=条件、逐点 mean/std/status）在 structuredContent）',
      '注：表达值单位随项目而定，上游未逐点标注；跨项目不可直接比较大小；±后为标准差。'
      + '0 与「未测量」上游不区分（status=zero_or_unmeasured，按未知处理，不许当 0）；上游没给该条件点则 status=missing。',
    ];

    let body: string;
    let shownGenes = rows.length;
    if (rows.length === 0) {
      body = [...header, '', '上游未返回任何表达记录（genes_not_found 里可能已列出原因）。', ...footer].join('\n');
      shownGenes = 0;
    } else {
      const fit = fitLines(MAX_BODY_BYTES - 100, rows.length, (shown) => {
        const lines = [...header, ''];
        for (let index = 0; index < shown; index += 1) lines.push(lineFor(index));
        if (shown < rows.length) {
          lines.push('', `（正文只展示前 ${shown} 个基因，另有 ${rows.length - shown} 个基因的完整矩阵在 structuredContent）`);
        }
        lines.push(...footer);
        return lines;
      });
      body = fit.text;
      shownGenes = fit.shown;
    }

    const unitNote = '上游未逐点标注单位（未知）；同一项目内按上游原值呈现，跨项目不可直接比较大小';
    const structured = {
      project: str(data.project) ?? project ?? null,
      genes_requested: ids,
      genes_found: Number.isFinite(toNum(data.genes_found)) ? toNum(data.genes_found) : null,
      genes_not_found: Array.isArray(notFound) ? notFound : [],
      genes_converted: converted && typeof converted === 'object' && !Array.isArray(converted) ? converted : {},
      conditions: conditionOrder,
      unit: { value: null, note: unitNote },
      status_policy: {
        measured: '上游给了有限数值（value≠0，或 value=0 但 std>0）',
        zero_or_unmeasured: 'value=0 且 std=0/未给：上游没有 missing 标记，无法区分「测得 0」与「未测量」，按未知处理，不许当 0 用',
        missing: '该基因在本项目里没有这个条件的点（上游未返回）',
        unknown: '上游给了非数值',
      },
      rows,
      body_shown_genes: shownGenes,
      note: '完整矩阵在本字段；正文只给摘要，不受 4 KB 正文截断影响',
    };

    return result(body, res, structured, `conditions=${conditionOrder.length}`, structured);
  },
};

const searchPapers: ToolDefinition = {
  name: 'wheatomics_search_papers',
  description:
    '检索 WheatOmics 收录的小麦族（Triticeae）文献元数据，可按关键词、性状、基因、时间窗过滤。'
    + '当用户想找「小麦耐旱相关近年文献」或为某个基因找参考文献时用。'
    + '返回的是该平台的精选文献库，不是 PubMed 全量。',
  parameters: {
    type: 'object',
    properties: {
      q: {
        type: 'string',
        description: '全文关键词（标题/摘要/刊物/作者/AI 标签），例如 vernalization、drought、grain weight',
      },
      limit: {
        type: 'integer',
        description: '返回条数（1–50，默认 10）',
        default: 10,
        minimum: 1,
        maximum: 50,
      },
      sinceDays: {
        type: 'integer',
        description: '只看最近 N 天入库的文献；用于「这周新增了什么」',
        minimum: 1,
      },
    },
    additionalProperties: false,
  },
  async run(args, ctx) {
    const q = optionalStringArg(args, 'q', 200);
    const limit = optionalIntArg(args, 'limit', 10, 1, 50);
    const sinceDays = optionalIntArg(args, 'sinceDays', 0, 0, 3_650) || undefined;
    const url = endpoint('/papers', { q, limit, since_days: sinceDays });
    const { res, result } = await query(ctx, url);
    const data = unwrap<Record<string, unknown>>(res.data, url);
    const papers = objectsOf(requireArrayField(data, 'papers', url, '文献检索'));
    const total = Number(data.total);

    if (papers.length === 0) {
      return result(`没有匹配「${q ?? '(未给关键词)'}」的文献（上游明确返回 0 条）。`, res, data, 'total=0');
    }

    const rows = papers.slice(0, limit).map((paper) => [
      paper.pmid ?? paper.pubmedid,
      paper.pub_date,
      paper.journal,
      paper.paper_title ?? paper.fga_title,
    ]);
    const body = [
      `命中 ${Number.isFinite(total) ? total : papers.length} 条文献（本次显示 ${Math.min(limit, papers.length)} 条）：`,
      '',
      renderTable(['PMID', '日期', '刊物', '标题'], rows, { maxCell: 80, maxRows: limit }),
    ].join('\n');

    return result(body, res, data, `total=${Number.isFinite(total) ? total : papers.length}`);
  },
};

const convertGeneIds: ToolDefinition = {
  name: 'wheatomics_convert_gene_ids',
  description:
    '把小麦基因 ID 在不同注释版本间换算，统一转成上游所称的 02G（IWGSC v1.1）格式。'
    + '两种模式：①给 `gene_version` 时走 ID 表（MIPS v2.2 / TGACv1 / IWGSC v1.0 → 02G）；'
    + '②**不给 `gene_version` 时走 `/api/genes/resolve` 逐 ID 解析**（03G/02G→02G，最多 20 个 ID）——'
    + '这是 03G 编号换 02G 的唯一上游通道（实测 03G 直查 PPI/GO 返回 0，就是编号代次问题）。'
    + '01G 转录本 ID（带 `.1`）在 resolve 里 count=0，会自动回退到 IWGSCv1_result 表换算。'
    + '**换算得到的是基因级 02G**：GO 富集按端点要求再补 `.1`（实测 02G+.1 有结果），'
    + 'PPI_poppin 带不带 `.1` 都行、PPI_result 需 01G 转录本 + `.1`。'
    + '**上游只有 →02G 单向**：WheatOmics 站内没有 02G→01G 端点（id-conversion 反查 not_found、resolve 对 01G 返回 count=0）；'
    + '官方 IWGSC v1.0↔v1.1 对应表在 URGI 存在，但本仓未接入、也不在工具里生成映射，标「未知/未实现」。'
    + '注意：这只是 ID 表之间的映射，**不等于确认了参考组装版本**。',
  parameters: {
    type: 'object',
    properties: {
      ids: {
        type: 'string',
        description: '一个或多个基因 ID，用逗号或换行分隔。给 gene_version 时是转录本 ID（须带 .1，最多 200 个）；'
          + '不给 gene_version 时走 resolve（基因级 ID，最多 20 个），例如 TraesCS5A03G0935400',
      },
      gene_version: {
        type: 'string',
        description: '源版本对应的表名；**不填**则用 /api/genes/resolve 逐 ID 解析（03G/02G→02G，01G+.1 回退 IWGSCv1_result）',
        enum: ['MIPS_result', 'TGACv1_result', 'IWGSCv1_result'],
      },
      source_generation: {
        type: 'string',
        description: '可选：显式声明输入 ID 的源代次（01G/02G/03G），不填按 ID 前缀识别。'
          + '03G/02G 走 /api/genes/resolve；01G 仍回退 IWGSCv1_result。与 gene_version 互斥',
        enum: ['01G', '02G', '03G'],
      },
    },
    required: ['ids'],
    additionalProperties: false,
  },
  async run(args, ctx) {
    const idsRaw = requireStringArg(args, 'ids', 20_000);
    const geneVersion = optionalStringArg(args, 'gene_version', 50);
    if (geneVersion !== undefined
      && !['MIPS_result', 'TGACv1_result', 'IWGSCv1_result'].includes(geneVersion)) {
      throw new InvalidArgumentError(`gene_version 只能是 MIPS_result / TGACv1_result / IWGSCv1_result，收到 ${geneVersion}`);
    }
    const declaredGenerationRaw = optionalStringArg(args, 'source_generation', 10);
    const declaredGeneration = declaredGenerationRaw?.toUpperCase();
    if (declaredGeneration !== undefined && !['01G', '02G', '03G'].includes(declaredGeneration)) {
      throw new InvalidArgumentError(`source_generation 只能是 01G / 02G / 03G，收到 ${declaredGenerationRaw}`);
    }
    if (declaredGeneration !== undefined && geneVersion !== undefined) {
      throw new InvalidArgumentError('gene_version 与 source_generation 不能同时给：前者是 ID 表名，后者是输入代次（尚未联网）');
    }

    // ── 模式①：显式 ID 表（行为与既有一致） ──────────────────────────────
    if (geneVersion !== undefined) {
      const list = splitIds(idsRaw, MAX_IDS_PER_CONVERSION, 'ids');
      const url = endpoint('/id-conversion', {
        ID: list.join('\r\n'),
        gene_version: geneVersion,
      });
      const { res, result } = await query(ctx, url);
      const data = unwrap<Record<string, unknown>>(res.data, url);
      const mappings = objectsOf(requireArrayField(data, 'mappings', url, 'ID 换算'));

      const lines = [
        `源版本：${str(data.version) ?? geneVersion}｜输入 ${list.length} 个 ID｜映射成功 ${mappings.length} 个`,
      ];
      if (mappings.length) {
        lines.push('');
        lines.push(
          renderTable(
            ['输入 ID', '参考基因（02G）', '关系', '长度'],
            mappings.map((m) => [m.query_gene, m.reference_gene, m.code, m.length]),
            { maxCell: 45, maxRows: Math.min(mappings.length, 40) },
          ),
        );
      }
      const notFound = data.not_found;
      if (Array.isArray(notFound) && notFound.length) {
        lines.push('', `未找到（${notFound.length}）：${notFound.slice(0, 30).join(', ')}${notFound.length > 30 ? ' …' : ''}`);
      }
      const structured = {
        mode: 'version_table',
        gene_version: geneVersion,
        version: str(data.version) ?? null,
        input_count: list.length,
        mapped: mappings.length,
        mappings: mappings.map((m) => ({
          input: m.query_gene,
          resolved_02g: m.reference_gene,
          code: m.code,
          length: m.length,
        })),
        not_found: Array.isArray(notFound) ? notFound : [],
        note: '只把 ID 表里的源版本映射到 02G；上游没有 02G→01G 端点（未知，不推算）',
      };
      return result(lines.join('\n'), res, structured, `mapped=${mappings.length}`, structured);
    }

    // ── 模式②：/api/genes/resolve 逐 ID 解析（03G/02G → 02G） ─────────────
    const list = splitIds(idsRaw, MAX_RESOLVE_IDS, 'ids');
    interface ResolvedRow {
      input: string;
      resolved_02g: string | null;
      method: 'resolve' | 'id-conversion(IWGSCv1_result)' | null;
      chromosome: string | null;
      start_mb: unknown;
      end_mb: unknown;
      strand: unknown;
      gene_primary: unknown;
      table: unknown;
      dataset: unknown;
      description: unknown;
      domain: unknown;
      request: string;
    }

    const rowsOut: ResolvedRow[] = [];
    const unresolved: Array<{ id: string; reason: string }> = [];
    const prepareds: PreparedRequest[] = [];
    let primary: { prepared: PreparedRequest; res: HttpResult } | undefined;
    let lastError: UpstreamError | undefined;

    for (let index = 0; index < list.length; index += 1) {
      const id = list[index]!;
      const prepared = prepareRequest({
        url: endpoint('/genes/resolve', { ID: id }),
        sourceName: manifest.displayName,
        presentation: { mode: 'resolve', id: index + 1, total: list.length },
      });
      prepareds.push(prepared);
      try {
        const res = await fetchPrepared(ctx, prepared, { timeoutMs: 20_000, retries: 0, maxTotalMs: 25_000 });
        primary = { prepared, res };
        const data = unwrap<Record<string, unknown>>(res.data, prepared.url);
        const mappings = objectsOf(requireArrayField(data, 'mappings', prepared.url, 'ID 解析'));
        const hit = mappings.find((mapping) => str(mapping.chinese_spring_02g) ?? str(mapping.gene_secondary));
        if (hit) {
          rowsOut.push({
            input: id,
            resolved_02g: str(hit.chinese_spring_02g) ?? str(hit.gene_secondary) ?? null,
            method: 'resolve',
            chromosome: str(hit.chromosome) ?? null,
            start_mb: hit.start_mb,
            end_mb: hit.end_mb,
            strand: hit.strand,
            gene_primary: hit.gene_primary,
            table: hit.table,
            dataset: hit.dataset,
            description: hit.description,
            domain: hit.domain,
            request: prepared.request,
          });
          continue;
        }

        // 01G：resolve 不认（count=0），上游唯一通道是 IWGSCv1_result 表（需要 .1 后缀）。
        const generation = declaredGeneration !== undefined
          ? declaredGeneration.replace(/G$/, '')
          : wheatGeneration(id);
        if (generation === '01') {
          if (!id.endsWith('.1')) {
            unresolved.push({ id, reason: '01G 在 resolve 里 count=0；id-conversion 需要转录本 ID（带 .1 后缀）' });
            continue;
          }
          const convUrl = endpoint('/id-conversion', { ID: id, gene_version: 'IWGSCv1_result' });
          const convPrepared = prepareRequest({
            url: convUrl,
            sourceName: manifest.displayName,
            presentation: { mode: 'resolve', fallback: 'IWGSCv1_result', id: index + 1 },
          });
          prepareds.push(convPrepared);
          const convRes = await fetchPrepared(ctx, convPrepared, { timeoutMs: 20_000, retries: 0, maxTotalMs: 25_000 });
          primary = { prepared: convPrepared, res: convRes };
          const convData = unwrap<Record<string, unknown>>(convRes.data, convPrepared.url);
          const convMappings = objectsOf(requireArrayField(convData, 'mappings', convPrepared.url, 'ID 换算'));
          const convHit = convMappings[0];
          if (convHit) {
            rowsOut.push({
              input: id,
              resolved_02g: str(convHit.reference_gene) ?? null,
              method: 'id-conversion(IWGSCv1_result)',
              chromosome: null,
              start_mb: null,
              end_mb: null,
              strand: null,
              gene_primary: null,
              table: 'IWGSCv1_result',
              dataset: null,
              description: null,
              domain: null,
              request: convPrepared.request,
            });
            continue;
          }
          unresolved.push({ id, reason: 'IWGSCv1_result 表里 not_found' });
          continue;
        }
        unresolved.push({ id, reason: `resolve count=0（上游未收录该 ID；03G/02G 用基因级 ID，不带 .1）` });
      } catch (error) {
        if (!(error instanceof UpstreamError)) throw error;
        lastError ??= error;
        unresolved.push({ id, reason: `查询失败：${error.message}` });
      }
    }

    if (!primary) {
      throw lastError ?? new UpstreamError('ID 解析全部失败（无可用响应）', { url: endpoint('/genes/resolve', { ID: list[0] }) });
    }

    const tableRows = rowsOut.map((row) => [
      row.input,
      row.resolved_02g ?? '-',
      row.method ?? '-',
      row.chromosome ?? '-',
      Number.isFinite(toNum(row.start_mb)) ? `${num(row.start_mb, 6)}–${num(row.end_mb, 6)}` : '-',
      row.table ?? '-',
      row.dataset ?? '-',
    ]);
    const scopeGeneration = declaredGeneration !== undefined
      ? generationLabel(declaredGeneration)
      : generationLabel(list.length === 1 ? wheatGeneration(list[0]!) : sharedGeneration(list));
    const zero = rowsOut.length === 0
      ? diagnoseZero({
        endpoint: '/api/genes/resolve（01G 回退 /api/id-conversion）',
        generation: scopeGeneration,
        support: generationSupport(scopeGeneration?.replace(/G$/, ''), ['01', '02', '03'], []),
        supportBasis: 'resolve 实测支持 03G/02G→02G；01G 转录本走 IWGSCv1_result 表回退',
        status: primary.res.status,
        durationMs: primary.res.durationMs,
        bytes: responseBytes(primary.res),
      })
      : undefined;
    const head = `模式：resolve（/api/genes/resolve 逐 ID）｜源代次 ${scopeGeneration ?? '未识别/混合'}`
      + `｜输入 ${list.length} 个｜映射成功 ${rowsOut.length} 个`
      + (unresolved.length ? `｜未映射 ${unresolved.length} 个` : '');
    const note = '注：WheatOmics 只有 →02G 单向；站内无 02G→01G 端点（id-conversion 反查 not_found、resolve 对 01G 返回 count=0）。'
      + '官方 IWGSC v1.0↔v1.1 对应表存在（URGI），但本仓未接入，标「未知/未实现」，不推算。';
    const { body, shown } = fitTable(
      (shownCount) => [
        head,
        note,
        ...(zero ? [renderZeroDiagnosis(zero)] : []),
        `正文展示 ${shownCount} 条（完整映射见 structuredContent）`,
      ],
      ['输入 ID', '02G', '方式', '染色体', '位置(Mb)', '表', '数据集'],
      tableRows,
      primary.prepared.url,
      MAX_BODY_BYTES - 300,
      40,
    );
    const notFoundText = unresolved.length
      ? `\n未映射（${unresolved.length}）：${unresolved.slice(0, 10).map((item) => `${item.id}（${item.reason}）`).join('；')}${unresolved.length > 10 ? ' …' : ''}`
      : '';
    const tail = shown < tableRows.length
      ? `\n（本次正文展示 ${shown} 条，另有 ${tableRows.length - shown} 条映射未展示；完整映射见 structuredContent）`
      : '';

    const structured = {
      mode: 'resolve',
      endpoint: '/api/genes/resolve',
      source_generation: declaredGeneration ?? null,
      input_count: list.length,
      mapped: rowsOut.length,
      mappings: rowsOut,
      not_found: unresolved,
      ...(zero ? { zero } : {}),
      notes: {
        direction: 'WheatOmics 只有 →02G 单向、站内无 02G→01G 端点；官方 IWGSC 对应表存在但本仓未接入（未知/未实现），本工具不推算',
        resolve_scope: 'resolve 逐 ID 扫描 Genefunc 表，返回 gene_primary（输入代次）与 gene_secondary / chinese_spring_02g（02G）',
        id_form: '03G/02G 用基因级 ID（不带 .1）；01G 转录本需 .1 后缀并回退 IWGSCv1_result',
        // #77 补充事实（v2 报告 E19）：/api/id-conversion 明确不认 03G，原文错误串照抄；03G→02G 走的是 resolve。
        id_conversion_03g: 'GET /api/id-conversion?gene_version=03G 实测 HTTP 400，原文 {"detail":"Unsupported id conversion table: 03G"}；'
          + '03G→02G 由 /api/genes/resolve 完成（本工具），02G→01G 上游无端点（未知）。',
      },
    };

    // 逐 ID 请求的完整证据：短 URL 通常放得下；放不下时余下部分进 structuredContent.mappings[].request。
    const others = prepareds.filter((prepared) => prepared !== primary.prepared).map((prepared) => prepared.request);
    const buildExtra = (kept: string[]): string => {
      const parts = [`mapped=${rowsOut.length}/${list.length}`];
      if (kept.length > 0) parts.push(`逐 ID 请求：${kept.join('；')}`);
      if (kept.length < others.length) parts.push(`另有 ${others.length - kept.length} 个请求见 structuredContent.mappings[].request`);
      return [manifest.versionNote, ...parts].filter(Boolean).join('；');
    };
    let keptOthers = others;
    let extra = buildExtra(keptOthers);
    const tailBytes = (text: string): number => utf8Bytes(provenance({
      sourceName: manifest.displayName,
      request: primary.prepared.request,
      status: primary.res.status,
      durationMs: primary.res.durationMs,
      at: '9999-12-31T23:59:59.999Z',
      extra: text,
    }));
    while (keptOthers.length > 0 && tailBytes(extra) > MAX_TAIL_BYTES) {
      keptOthers = keptOthers.slice(0, -1);
      extra = buildExtra(keptOthers);
    }
    if (tailBytes(extra) > MAX_TAIL_BYTES) throw new InvalidArgumentError('逐 ID 证据超出 2560 字节上限，请减少 ids（尚未联网）');

    return finishResult({
      body: `${body}${tail}${notFoundText}`,
      res: primary.res,
      prepared: primary.prepared,
      sourceId: manifest.id,
      raw: structured,
      structured,
      extra,
    });
  },
};

// ── 2026-10-29 新增：跨物种同源 / VariantHub 目录 / VariantHub 区间查询 ──────
//
// 三者的上游证据与契约见各自端点的 fixture 说明。
// 两条贯穿始终的纪律：
//   1. **0 条 ≠ 不存在**。WheatOmics 的 VariantHub 里，`genome_concordant=false`
//      的数据集（本批 29 个中 2 个）坐标与参考基因组不一致；查这类数据集时
//      0 条不能解读为"没有变异"。**为什么返回 0，本仓未查明，不做推断**——
//      早先写的"本应有数据却返回 0 条"是基于仿造数据的推断，已撤回。
//      所以空结果只能表述为"该数据集在该区间返回 0 条"，不能断言"没有变异"。
//   2. **端点语义已证实为闭区间，但不写基数命名**。五次边界实验证明
//      `start <= pos <= end`（④⑤ 两次证伪半开解释）；`start==end` 被上游 400 拒绝，
//      是上游对该形态的校验行为，本仓在**本地拒绝**并提示改用区间查询。从 `pos=168831` 反推 1-based/0-based
//      没有依据，因此描述里两者都不写。

/** 正文预算：与 Gramene 一致的留白策略，给尾部计数行留位置。 */
const HOMOLOG_BODY_BUDGET = MAX_BODY_BYTES - 160;
/**
 * **变异数据集目录**的正文预算：`MAX_BODY_BYTES - 200`。
 *
 * 这 200 B 保护的是**表格后另拼的省略句**（"表中仅列 N 个，共 M 个；用 keyword 缩小范围"）——
 * 目录工具是"先排表、后拼 tail"的形态，不留位就会在正文顶满时被裁。
 * 不是给出处尾注（尾注由 `core/request.ts` 按整包 4096 B 另留，不与 1408 相减）。
 * 凡"后拼省略句"的调用点都必须留位；曾误把这个常量放大到 1408，见 `9f488c4`。
 */
const VARIANT_CATALOG_BODY_BUDGET = MAX_BODY_BYTES - 200;

/** 仅 `variant_query` 使用：缺口句已进 `fitTable` 试排，正文可用满 1408 B（表格让位）。 */
const VARIANT_QUERY_BODY_BUDGET = MAX_BODY_BYTES;

/** 同源结果的物种展示顺序：实测返回 Rice + Arabidopsis，其余物种原样追加。 */
const SPECIES_ORDER = ['Rice', 'Arabidopsis'];

function optNumber(data: Record<string, unknown>, key: string, url: string, what: string): number | undefined {
  const value = data[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new UpstreamShapeError(`${what} 的 ${key} 不是有限数字（实际 ${typeof value}）——上游契约可能已变`, { url });
  }
  return value;
}

/**
 * **必须有**的非负整数计数（审查 WHT3-01）。
 *
 * 教训：原来用 `optNumber` 读 `count` / `total` / `total_shown`，缺字段时得到 `undefined`，
 * 而空数组分支又会打印「上游明确 count=0」——**这个 0 是我们自己编的，不是上游给的**。
 * 上游删掉计数字段、数组里塞了 `null`，都会被静默报成"合法查无"。
 *
 * 现在：计数字段缺失或不是非负整数 → 结构漂移。想报"0 条"，必须真的读到 `0`。
 */
function requireCount(data: Record<string, unknown>, key: string, url: string, what: string): number {
  const value = data[key];
  if (value === undefined) {
    throw new UpstreamShapeError(
      `${what} 响应里没有 \`${key}\` 字段——无法确认本次是否真的返回 0 条；这不等于"没有结果"`,
      { url, bodySnippet: `keys=${Object.keys(data).slice(0, 12).join(',')}` },
    );
  }
  if (value === null) {
    throw new UpstreamShapeError(`${what} 的 \`${key}\` 是 null——无法确认返回条数，不当成 0`, { url });
  }
  if (typeof value !== 'number' || !Number.isFinite(value) || !Number.isInteger(value) || value < 0) {
    throw new UpstreamShapeError(`${what} 的 \`${key}\` 不是非负整数（实际 ${String(value)}）——上游契约可能已变`, { url });
  }
  return value;
}

/**
 * 严格取对象数组（审查 WHT3-01）。
 *
 * 不能用公共 `objectsOf()`：它会把 `null` 之类的元素**静默过滤掉**，
 * 于是 `records=[null]` 会被当成空数组，进而被报成"本次 0 条"。
 * 元素不是对象就是结构漂移，必须抛。
 */
function strictObjects(rows: unknown[], url: string, what: string): Array<Record<string, unknown>> {
  return rows.map((row, index) => {
    if (row === null || typeof row !== 'object' || Array.isArray(row)) {
      throw new UpstreamShapeError(
        `${what} 第 ${index + 1} 个元素不是对象（实际 ${row === null ? 'null' : Array.isArray(row) ? '数组' : typeof row}）`
        + '——上游契约可能已变；不能把它当成"没有结果"',
        { url },
      );
    }
    return row as Record<string, unknown>;
  });
}

/**
 * 逐行试排，只统计**真正进了正文**的行数。
 *
 * 这是 Gramene 那轮 `shown=-1` 的教训：整表放不进正文时不能把"未展示"算成负一行，
 * 尾部"另有 N 条"必须是 `rows.length - shown`。
 *
 * 审查 WHT3-04 追加：头部必须由 `shown` **算出来**，不能在试排前就先写死"展示 N 条"。
 * 所以 `headLines` 收的是函数而不是字符串——否则首行说 20 条、表格 8 行、尾行又说 8 条。
 */
function fitTable(
  headLines: (shown: number) => string[],
  columns: string[],
  rows: unknown[][],
  url: string,
  budget: number,
  maxCell: number,
): { body: string; shown: number } {
  const emptyHead = headLines(0).join('\n');
  if (utf8Bytes(emptyHead) > budget) {
    throw new UpstreamShapeError('摘要头部已超出正文预算，无法在不失真的前提下展示', { url });
  }
  let best = { body: emptyHead, shown: 0 };
  for (let count = 1; count <= rows.length; count += 1) {
    const head = headLines(count).join('\n');
    const candidate = `${head}\n${renderTable(columns, rows.slice(0, count), { maxRows: count, maxCell })}`;
    if (utf8Bytes(candidate) > budget) break;
    best = { body: candidate, shown: count };
  }
  return best;
}

const crossSpeciesHomologs: ToolDefinition = {
  name: 'wheatomics_cross_species_homologs',
  description:
    '把一个小麦基因映射到其他物种的同源基因（BLAST 比对结果，含 identity、覆盖度、E 值、得分），用于跨物种功能推断。'
    + '当用户问「这个小麦基因在水稻/拟南芥里对应哪个基因」时用。'
    + '**覆盖范围只有水稻与拟南芥**——实测返回的 species 是 Rice 与 Arabidopsis，不是全部物种，也不代表全部禾本科。'
    + '注意：上游没有给出直系同源/旁系同源的分类字段，本工具**不区分 ortholog 与 paralog**，只报同源命中；'
    + 'max_targets 是**每个物种**的返回上限，不是总条数。'
    + '查无返回"本次返回 0 条"，不代表该基因没有同源基因。',
  parameters: {
    type: 'object',
    properties: {
      gene_id: {
        type: 'string',
        description: '小麦基因 ID，例如 TraesCS5A02G391700（只接受单个 ID；不做格式猜测，上游对查无的 ID 返回合法空结果）',
      },
      max_targets: {
        type: 'integer',
        description: '每个物种最多返回几个同源基因（1–100，默认 3）。是**每物种**上限，不是总数',
        default: 3,
        minimum: 1,
        maximum: 100,
      },
    },
    required: ['gene_id'],
    additionalProperties: false,
  },
  async run(args, ctx) {
    const geneId = requireStringArg(args, 'gene_id', 200);
    const maxTargets = optionalIntArg(args, 'max_targets', 3, 1, 100);

    const url = endpoint('/homologs/wheat-rice-arabidopsis', { gene_id: geneId, max_targets: maxTargets });
    const { res, result } = await query(ctx, url, { max_targets: maxTargets });
    const data = unwrap<Record<string, unknown>>(res.data, url);

    // 身份对账：返回的 query_gene 必须就是请求的那个基因，否则拒绝展示。
    const echoed = data.query_gene;
    if (typeof echoed !== 'string' || echoed.trim() === '') {
      throw new UpstreamShapeError('同源响应缺少 query_gene，无法确认这是本次请求的结果——上游契约可能已变', { url });
    }
    if (echoed.trim() !== geneId) {
      throw new UpstreamShapeError(
        `返回的 query_gene（${echoed.trim()}）与请求的 gene_id（${geneId}）不一致——身份不符，拒绝把无关记录当同源结果；请检查 ID 大小写与形式`,
        { url },
      );
    }

    const hits = strictObjects(requireArrayField(data, 'hits', url, '同源查询'), url, '同源查询 hits');
    // 计数必须真实存在（审查 WHT3-01）：缺 count 时不许自己编一个 0。
    const declared = requireCount(data, 'count', url, '同源查询');
    if (declared !== hits.length) {
      throw new UpstreamShapeError(
        `上游自相矛盾：count=${declared} 但 hits 实际 ${hits.length} 条——不挑一个当真值`,
        { url },
      );
    }

    /**
     * 逐条身份对账（审查 WHT3-02）。
     *
     * 原来只查顶层 `query_gene`。缓存混包或上游串号时，顶层可能是对的、单条却是别的基因，
     * 那种记录会被当成"本次请求的同源结果"展示，而完整 GET 出处反而替错误归属背书。
     */
    const mismatched = hits
      .map((hit, index) => ({ index, echoed: hit.query_gene }))
      .filter(({ echoed }) => echoed !== undefined && echoed !== null && String(echoed).trim() !== geneId)
      .map(({ index, echoed }) => `第 ${index + 1} 条 query_gene=${String(echoed).trim()}`);
    if (mismatched.length > 0) {
      throw new UpstreamShapeError(
        `单条命中记录的 query_gene 与请求的 gene_id（${geneId}）不一致：${mismatched.slice(0, 3).join('、')}`
        + '——身份不符，拒绝把无关基因的同源记录当成结果；请检查 ID 大小写与形式',
        { url },
      );
    }

    if (hits.length === 0) {
      const generation = wheatGeneration(geneId);
      const zero = diagnoseZero({
        endpoint: '/api/homologs/wheat-rice-arabidopsis',
        generation: generationLabel(generation),
        support: generationSupport(generation, ['02'], ['03']),
        supportBasis: '同源 BLAST 库实测 02G 有正例（6 条）、03G 302/302 回 0；01G 未测',
        status: res.status,
        durationMs: res.durationMs,
        bytes: responseBytes(res),
      });
      const emptyStructured = {
        query_gene: geneId,
        count: 0,
        max_targets: maxTargets,
        species_covered: ['Rice', 'Arabidopsis'],
        hits: [],
        zero,
        note: '0 条只表示本次比对无命中；上游没有 ortholog/paralog 分类字段',
      };
      return result(
        `「${geneId}」本次返回 0 条同源基因（上游 count=0）。\n`
        + '说明：本工具只覆盖水稻与拟南芥两个物种；0 条只表示本次比对无命中，不代表该基因没有同源基因。\n'
        + renderZeroDiagnosis(zero),
        res,
        // 空结果也走白名单（审查 WHT3-03）：不能因为"没记录"就把整包 data 原样带出去。
        emptyStructured,
        'count=0',
        emptyStructured,
      );
    }

    // 按物种分组，实测物种优先，其余原样追加（不为未测物种编造名字）。
    const grouped = new Map<string, Array<Record<string, unknown>>>();
    for (const hit of hits) {
      const species = str(hit.species) ?? '(上游未给物种)';
      const bucket = grouped.get(species);
      if (bucket) bucket.push(hit);
      else grouped.set(species, [hit]);
    }
    const ordered = [...grouped.keys()].sort((a, b) => {
      const ai = SPECIES_ORDER.indexOf(a);
      const bi = SPECIES_ORDER.indexOf(b);
      if (ai !== -1 && bi !== -1) return ai - bi;
      if (ai !== -1) return -1;
      if (bi !== -1) return 1;
      return a.localeCompare(b);
    });

    const counts = ordered.map((species) => `${species} ${grouped.get(species)!.length}`).join('、');

    const rows = hits.map((hit) => [
      hit.species,
      hit.target_gene,
      hit.gene_name,
      Number.isFinite(toNum(hit.identity)) ? `${num(hit.identity, 2)}%` : '-',
      Number.isFinite(toNum(hit.qcovs)) ? `${num(hit.qcovs, 1)}%` : '-',
      hit.evalue,
      hit.score,
    ]);

    // 头部由 shown 算出来（审查 WHT3-04）：先写死"展示 N 条"会和表格实际行数冲突。
    const { body, shown } = fitTable(
      (shownCount) => [
        `「${geneId}」命中 ${hits.length} 条同源基因（${counts}）｜max_targets=${maxTargets} 是**每物种**上限`
        + (shownCount < hits.length ? `｜本次正文展示 ${shownCount} 条` : ''),
        '注：不区分直系/旁系同源（上游无该字段）；覆盖范围仅水稻与拟南芥。',
      ],
      ['物种', '同源基因', '基因名', 'identity', '覆盖度', 'E 值', '得分'],
      rows,
      url,
      HOMOLOG_BODY_BUDGET,
      60,
    );
    const tail = shown < rows.length ? `\n（本次正文展示 ${shown} 条，另有 ${rows.length - shown} 条未展示；可减小 max_targets 或按物种分开查询）` : '';
    /**
     * 机器可消费形态（封装层补齐第 6 条）：每条命中的 gene id / species / identity / E-value
     * 都在这里逐字段给出，正文表格只当摘要。字段名沿用上游原名（identity/qcovs/evalue/score），
     * 不做单位换算、不补上游没给的 ortholog/paralog 分类。
     */
    const structured = {
      query_gene: geneId,
      count: declared,
      max_targets: maxTargets,
      species_covered: ['Rice', 'Arabidopsis'],
      species_counts: Object.fromEntries(ordered.map((species) => [species, grouped.get(species)!.length])),
      hits: hits.map((hit) => ({
        target_gene: hit.target_gene,
        gene_name: hit.gene_name,
        species: hit.species,
        identity: hit.identity,
        qcovs: hit.qcovs,
        evalue: hit.evalue,
        score: hit.score,
        description: hit.description,
      })),
      note: '上游没有 ortholog/paralog 分类字段，本字段不区分直系/旁系同源；max_targets 是每物种上限',
    };
    return result(`${body}${tail}`, res, structured, `count=${hits.length}`, structured);
  },
};

/**
 * G4：小麦共线出口（`/api/synteny/search`）。
 *
 * 2026-11-10 实测（E07）：区间 `chr1A:8000000-9000000` → 200 / 10,397 B / `count=40`，
 * 五列 `chinese_spring/durum_wheat/wild_emmer/triticum_urartu/aegilops_tauschii`；
 * 单基因 `TraesCS1A02G013100`（默认表 `CSsymaptbl`）→ 200 / `count=0`，
 * 而 `TraesCS1A01G018500LC`（同区间实际返回的 01G 编号）→ `count=1`。
 *
 * 结论（已判明，不是"未知"）：**默认表按 IWGSC RefSeq v1.1（01G）编号索引**；
 * 02G 编号在该表查不到。这是**编号代次/表键**问题，不是"必须区间"——
 * 01G 单基因能查到，区间里返回的也全是 01G。工具保留单基因入口并如实解释 0 条，
 * 不把单基因路径藏起来。
 */
const SYNTENY_REGION = /^([A-Za-z0-9._-]{1,40}):(\d{1,12})-(\d{1,12})$/;
const SYNTENY_MAX_SPAN_BP = 5_000_000;

function syntenyRegion(raw: unknown): string {
  if (typeof raw !== 'string') {
    throw new InvalidArgumentError('region 必须是字符串 chr:start-end（bp；尚未联网）');
  }
  const text = raw.trim();
  const match = SYNTENY_REGION.exec(text);
  if (!match) {
    throw new InvalidArgumentError('region 必须是 chr:start-end（bp），例如 chr1A:8000000-9000000（尚未联网）');
  }
  const start = Number(match[2]);
  const end = Number(match[3]);
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end <= start) {
    throw new InvalidArgumentError(`region 坐标非法：${text}（要求 0 ≤ start < end；尚未联网）`);
  }
  if (end - start > SYNTENY_MAX_SPAN_BP) {
    throw new InvalidArgumentError(
      `region 跨度 ${end - start} bp 超过本地上限 ${SYNTENY_MAX_SPAN_BP} bp；请缩小范围（尚未联网）`,
    );
  }
  return `${match[1]}:${start}-${end}`;
}

function syntenyGeneId(raw: unknown): string {
  if (typeof raw !== 'string') throw new InvalidArgumentError('gene_id 必须是字符串（尚未联网）');
  const text = raw.trim();
  if (!/^[A-Za-z0-9._-]{1,60}$/.test(text)) {
    throw new InvalidArgumentError(`gene_id 形状非法：${text.slice(0, 40)}（尚未联网）`);
  }
  return text;
}

/** 从中国春 ID 取注释代次：TraesCS1A02G013100 → "02"。不是中国春 ID 时返回 undefined。 */
function wheatGeneration(geneId: string): string | undefined {
  return /^TraesCS[0-9]+[ABD](\d{2})G/.exec(geneId)?.[1];
}

/** 一组 ID 的代次一致时才返回该代次；混代/识别不出按 null（诊断里记「未知」）。 */
function sharedGeneration(geneIds: readonly string[]): string | null {
  const generations = new Set(geneIds.map((geneId) => wheatGeneration(geneId)).filter(Boolean));
  return generations.size === 1 ? [...generations][0]! : null;
}

/** 把「输入代次 + 端点实测支持/不支持/未测」翻成零值诊断的 support 字段。 */
function generationSupport(
  generation: string | null | undefined,
  supported: readonly string[],
  unsupported: readonly string[],
): GenerationSupport {
  if (!generation) return 'unknown';
  if (supported.includes(generation)) return 'supported';
  if (unsupported.includes(generation)) return 'unsupported';
  return 'unknown';
}

/** 共线记录的对应物种列：null / "." / 空都表示该物种无对应记录，显示 "-"。 */
function syntenyCounterpart(value: unknown): string {
  const text = str(value);
  return text && text !== '.' ? text : '-';
}

/** 对照物种列名与中文标注（顺序与上游 records 一致）。 */
const SYNTENY_COUNTERPART_KEYS = [
  ['chinese_spring', '中国春'],
  ['durum_wheat', '硬粒小麦'],
  ['wild_emmer', '野生二粒'],
  ['triticum_urartu', '乌拉尔图'],
  ['aegilops_tauschii', '节节麦'],
] as const;

/**
 * 封装层补齐第 1 条：让「对照物种没有 bp 坐标」这件事**有字段、有证据**，而不是留白。
 *
 * 实测（2026-11-10）：`/api/synteny/search` 的五列对照物种只有基因 ID（一列还可能是
 * 逗号分隔的多个 ID），不含坐标；再拿 4 个真实对照 ID 去问 `/api/genes/resolve`，
 * 全部 `count=0`。所以坐标是**上游未给、未知**——本工具不推算、不拿小麦坐标顶替。
 */
const SYNTENY_COUNTERPART_COORDINATE_NOTE =
  '上游 /api/synteny/search 的对照物种列只有基因 ID，不返回 bp 坐标；'
  + '本仓 2026-11-10 用 /api/genes/resolve 实测 4 个对照 ID'
  + '（TRIDC1AG001520 / TuG1812G0100000209.01 / AET1Gv20035300 / TRITD1Av1G003820）均返回 count=0。'
  + '因此对照物种坐标=未知，本工具不推算、不用小麦坐标顶替。';

const syntenySearch: ToolDefinition = {
  name: 'wheatomics_synteny',
  description:
    '查小麦（中国春）与硬粒小麦/野生二粒小麦/乌拉尔图小麦/节节麦的共线关系：可按基因组区间（chr:start-end，bp）或按单个基因 ID。'
    + '返回每条小麦基因在五个物种里的对应基因（上游 start_mb/end_mb 单位是 Mb）。'
    + '**默认共线表 CSsymaptbl 按 IWGSC RefSeq v1.1（01G）编号索引**：实测 02G 编号（如 TraesCS1A02G013100）单基因查返回 count=0，'
    + '而同一区间的 01G 编号（如 TraesCS1A01G018500LC）能查到——这是编号代次/表键问题，不是"必须区间"，本工具不隐藏单基因入口。'
    + '正文只展示前 N 条，完整记录在 structuredContent；0 条只表示该表本次无记录，不代表没有共线关系。',
  parameters: {
    type: 'object',
    properties: {
      region: {
        type: 'string',
        description: '基因组区间 chr:start-end（bp，0 ≤ start < end，跨度 ≤ 5 Mb），例如 chr1A:8000000-9000000；与 gene_id 二选一',
      },
      gene_id: {
        type: 'string',
        description: '单个小麦基因 ID（默认表按 01G 编号索引），例如 TraesCS1A01G018500LC；与 region 二选一',
      },
      limit: {
        type: 'integer',
        description: '正文最多展示多少条（1–50，默认 10）；完整记录在 structuredContent',
        default: 10,
        minimum: 1,
        maximum: 50,
      },
    },
    additionalProperties: false,
  },
  async run(args, ctx) {
    const present = ['region', 'gene_id'].filter((key) => args[key] !== undefined && args[key] !== null && args[key] !== '');
    if (present.length !== 1) {
      throw new InvalidArgumentError('region 与 gene_id 必须且只能给一个（尚未联网）');
    }
    const limit = optionalIntArg(args, 'limit', 10, 1, 50);
    const isRegion = present[0] === 'region';
    const queryValue = isRegion ? syntenyRegion(args.region) : syntenyGeneId(args.gene_id);
    const url = endpoint('/synteny/search', { ID: queryValue });
    const { res, result } = await query(ctx, url, { limit });

    const data = unwrap<Record<string, unknown>>(res.data, url);
    const declared = requireCount(data, 'count', url, '共线查询');
    const records = strictObjects(requireArrayField(data, 'records', url, '共线查询'), url, '共线查询 records');
    if (declared !== records.length) {
      throw new UpstreamShapeError(
        `上游自相矛盾：count=${declared} 但 records 实际 ${records.length} 条——不挑一个当真值`,
        { url },
      );
    }

    if (records.length === 0) {
      const generation = isRegion ? undefined : wheatGeneration(queryValue);
      const zero = diagnoseZero({
        endpoint: '/api/synteny/search',
        generation: generationLabel(generation),
        support: isRegion ? 'supported' : generationSupport(generation, ['01'], ['02', '03']),
        supportBasis: isRegion
          ? '默认表 CSsymaptbl 按区间可查（实测区间回 40 条）'
          : '默认表 CSsymaptbl 按 IWGSC RefSeq v1.1（01G）编号建键；实测 01G 单基因 count=1、02G 单基因 count=0',
        status: res.status,
        durationMs: res.durationMs,
        bytes: responseBytes(res),
        hasRegionMode: true,
      });
      const cause = isRegion
        ? '该区间在默认共线表 CSsymaptbl 中返回 0 条；0 条只表示本次该表无记录，不代表该区间没有共线关系。'
        : generation === '02'
          ? `「${queryValue}」是 02G 编号，而默认共线表 CSsymaptbl 的记录使用 IWGSC RefSeq v1.1（01G）编号`
            + '（实测同一区间返回的基因形如 TraesCS1A01G018500LC，01G 单基因可查到）。'
            + '因此 02G 编号在该表查不到——这是编号代次/表键问题，不是"必须用区间"，也不代表该基因没有共线关系。'
            + '可改用 region 查询该基因所在位置，或换成对应的 01G 编号。'
          : generation === '01'
            ? `「${queryValue}」是 01G 编号；默认共线表 CSsymaptbl 按该代次索引，但本次该 ID 仍无记录`
              + '（可能未被该表收录）。这不代表该基因没有共线关系。'
            : `「${queryValue}」在默认共线表 CSsymaptbl 中无记录；该表按 IWGSC RefSeq v1.1（01G）编号索引，`
              + '非中国春编号可能查不到。这不代表该基因没有共线关系。';
      const emptyStructured = {
        query: queryValue,
        mode: isRegion ? 'region' : 'gene',
        count: 0,
        anchors: 0,
        shown: 0,
        records: [],
        counterpart_coordinates: { status: 'unknown', unit: null, reason: SYNTENY_COUNTERPART_COORDINATE_NOTE },
        zero,
      };
      return result(
        `${isRegion ? `区间「${queryValue}」` : `基因「${queryValue}」`}返回 0 条共线记录（上游 count=0）。\n${cause}\n${renderZeroDiagnosis(zero)}`,
        res,
        emptyStructured,
        'count=0',
        emptyStructured,
      );
    }

    const counterparts = (record: Record<string, unknown>): string[] => [
      syntenyCounterpart(record.chinese_spring),
      syntenyCounterpart(record.durum_wheat),
      syntenyCounterpart(record.wild_emmer),
      syntenyCounterpart(record.triticum_urartu),
      syntenyCounterpart(record.aegilops_tauschii),
    ];
    const anchors = records.filter((record) => counterparts(record).some((value) => value !== '-')).length;
    const rows = records.map((record) => [
      record.gene,
      record.chromosome,
      `${num(record.start_mb, 6)}–${num(record.end_mb, 6)}`,
      record.strand,
      ...counterparts(record),
    ]);
    const { body, shown } = fitTable(
      (shownCount) => [
        `${isRegion ? '区间' : '基因'}「${queryValue}」命中 ${records.length} 条共线记录（有跨物种锚点 ${anchors} 条）｜正文展示 ${shownCount} 条`,
        '坐标为 Mb（上游 start_mb/end_mb）；「-」表示该物种无对应记录。'
        + '对照物种只有基因 ID，上游未给 bp 坐标（未知，不推算）。',
      ],
      ['小麦基因', '染色体', '位置(Mb)', '链', '中国春', '硬粒小麦', '野生二粒', '乌拉尔图', '节节麦'],
      rows.slice(0, limit),
      url,
      MAX_BODY_BYTES - 240,
      48,
    );
    const tail = shown < rows.length
      ? `\n（本次正文展示 ${shown} 条，另有 ${rows.length - shown} 条未展示；完整记录见 structuredContent）`
      : '';
    const structured = {
      query: queryValue,
      mode: isRegion ? 'region' : 'gene',
      table: 'CSsymaptbl',
      count: declared,
      anchors,
      shown,
      records: records.map((record) => ({
        gene: record.gene,
        chromosome: record.chromosome,
        start_mb: record.start_mb,
        end_mb: record.end_mb,
        strand: record.strand,
        // 上游原样字段（一列可能是逗号分隔的多个对照 ID）；下面是拆分后的机器可读形态。
        chinese_spring: record.chinese_spring,
        durum_wheat: record.durum_wheat,
        wild_emmer: record.wild_emmer,
        triticum_urartu: record.triticum_urartu,
        aegilops_tauschii: record.aegilops_tauschii,
        counterparts: Object.fromEntries(SYNTENY_COUNTERPART_KEYS.map(([key]) => [key, {
          genes: splitCounterparts(record[key]),
          // 上游不给对照坐标：保留字段并标 unknown，避免调用方把「没给」读成「0」。
          coordinates: { start_mb: null, end_mb: null, status: 'unknown' },
        }])),
      })),
      counterpart_coordinates: {
        status: 'unknown',
        unit: null,
        reason: SYNTENY_COUNTERPART_COORDINATE_NOTE,
      },
    };
    return result(
      `${body}${tail}`,
      res,
      structured,
      `count=${declared}；表=CSsymaptbl（01G 编号）；小麦坐标单位 Mb；对照物种坐标=上游未给（未知）`,
      structured,
    );
  },
};

const variantDatasets: ToolDefinition = {
  name: 'wheatomics_variant_datasets',
  description:
    '列出 WheatOmics VariantHub 收录的小麦变异数据集（参考基因组 + dataset key），共 29 个数据集、3 个参考基因组。'
    + '当用户想查某个区间的 SNP/InDel 时，**先用它拿到 dataset key**，再调 wheatomics_variant_query。'
    + '**注意 genome_concordant 字段**：它标示该数据集的坐标是否与所选参考基因组一致；实测 29 个数据集里 27 个为 true、'
    + '2 个为 false（`WEC_filtered_SNPs`、`WEC_filtered_INDELs`）。选非一致数据集时，0 条结果不能解读为该区间没有变异——'
    + '**但"为什么返回 0"本仓未查明，不做推断**。优先选 genome_concordant=true 的数据集。',
  parameters: {
    type: 'object',
    properties: {
      keyword: {
        type: 'string',
        description: '可选，**本地**按 dataset key / label / source 做不区分大小写的子串过滤（不发给上游），例如 exome、GBS、Kronos',
      },
    },
    additionalProperties: false,
  },
  async run(args, ctx) {
    const keyword = optionalStringArg(args, 'keyword', 100);
    const url = endpoint('/VariantHub/datasets');
    const { res, result } = await query(ctx, url, { keyword: keyword ?? null });
    const data = unwrap<Record<string, unknown>>(res.data, url);

    const references = strictObjects(requireArrayField(data, 'references', url, '变异数据集目录'), url, '变异数据集目录 references');
    if (references.length === 0) {
      // 空结果也走白名单（审查 WHT3-03），不带整包原始 data。
      return result('上游返回 0 个参考基因组（不是解析失败）。', res, { references: [] }, 'references=0');
    }

    interface Row {
      reference: string;
      key: string;
      label: string;
      source: string;
      concordant: boolean | undefined;
      hasSampleMeta: boolean | undefined;
    }

    const all: Row[] = [];
    for (const reference of references) {
      /**
       * 真实响应的字段名是 `name`（不是 `reference`）。
       *
       * 2026-10-29 用真实抓取比对时才发现：合成 fixture 里我写的是 `reference`，
       * 而实现优先读 `reference`、回退到 `display`，于是永远拿不到 `name`——
       * 显示成 "Chinese Spring (IWGSCv1.0)" 这类 display 而非稳定标识。
       * 三个键都试，都缺就是结构漂移（不许用占位符顶上去）。
       */
      const refId = str(reference.name) ?? str(reference.reference) ?? str(reference.display);
      if (!refId) {
        throw new UpstreamShapeError(
          '参考基因组条目缺少 name / reference / display 三个标识字段——上游契约可能已变，不猜归属',
          { url },
        );
      }
      const list = reference.datasets;
      if (!Array.isArray(list)) {
        throw new UpstreamShapeError(
          `参考基因组 ${refId} 的 datasets 不是数组（实际 ${typeof list}）——上游契约可能已变；`
          + '本仓只实测过"数组形式"，不猜其他嵌套形态',
          { url },
        );
      }
      for (const raw of list) {
        // 元素必须是对象：纯字符串 key 尽管可能出现，但本仓**未实测过**该形态，
        // 猜它等于 key 会把结构漂移当成正常数据（审查 WHT3-01 同类问题）。
        if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
          throw new UpstreamShapeError(
            `参考基因组 ${refId} 的 datasets 里有非对象元素（实际 ${raw === null ? 'null' : Array.isArray(raw) ? '数组' : typeof raw}）`
            + '——上游契约可能已变，本仓未实测该形态，不猜',
            { url },
          );
        }
        const item = raw as Record<string, unknown>;
        const key = str(item.key);
        if (!key) {
          throw new UpstreamShapeError(`参考基因组 ${refId} 下有数据集缺少 key 字段——上游契约可能已变`, { url });
        }
        all.push({
          reference: refId,
          key,
          label: str(item.label) ?? '-',
          source: str(item.source) ?? '-',
          concordant: typeof item.genome_concordant === 'boolean' ? item.genome_concordant : undefined,
          hasSampleMeta: typeof item.has_sample_meta === 'boolean' ? item.has_sample_meta : undefined,
        });
      }
    }

    // 同一 dataset key 出现在两个参考基因组下 = 上游归属矛盾，不猜谁对。
    const seenKeys = new Map<string, string>();
    for (const row of all) {
      const previous = seenKeys.get(row.key);
      if (previous !== undefined && previous !== row.reference) {
        throw new UpstreamShapeError(
          `数据集 key「${row.key}」同时出现在 ${previous} 与 ${row.reference} 两个参考基因组下——上游归属自相矛盾，不挑一个当真`,
          { url },
        );
      }
      seenKeys.set(row.key, row.reference);
    }

    const needle = keyword?.toLowerCase();
    const kept = needle
      ? all.filter((row) => [row.key, row.label, row.source, row.reference].some((field) => field.toLowerCase().includes(needle)))
      : all;

    const concordantCount = all.filter((row) => row.concordant === true).length;
    const unknownCount = all.filter((row) => row.concordant === undefined).length;
    const recommended = all.filter((row) => row.concordant === true).map((row) => row.key);
    const head = [
      `共 ${references.length} 个参考基因组、${all.length} 个变异数据集；`
      + `其中 genome_concordant=true 的 ${concordantCount} 个${unknownCount > 0 ? `，字段缺失 ${unknownCount} 个` : ''}。`,
      // 推荐 key 单独一行：29 个数据集放不进正文时表格会被截断，
      // 若把"该用哪个"只放在表格里，用户拿到的恰恰可能是被截掉的那几个。
      recommended.length > 0
        ? `建议优先使用（genome_concordant=true）：${recommended.slice(0, 10).join('、')}${recommended.length > 10 ? ` 等 ${recommended.length} 个` : ''}`
        : '本批响应里没有 genome_concordant=true 的数据集——查询前请谨慎解读 0 条结果。',
      keyword ? `本地关键词「${keyword}」命中 ${kept.length} 个（该过滤不发给上游）。` : '',
      '⚠️ genome_concordant=false 的数据集（本批 2 个）坐标与所选参考基因组不一致；查这类数据集时，0 条不能解读为该区间没有变异——为什么返回 0 本仓未查明，不做推断。',
    ].filter(Boolean);

    const rows = kept.map((row) => [
      row.reference,
      row.key,
      row.label,
      row.concordant === undefined ? '未知' : String(row.concordant),
      row.hasSampleMeta === undefined ? '未知' : row.hasSampleMeta ? '有' : '无',
    ]);

    if (rows.length === 0) {
      return result(
        `${head.join('\n')}\n\n本次没有匹配的数据集（本地过滤结果为空；可去掉 keyword 看全部）。`,
        res,
        { total: all.length },
        `datasets=${all.length}`,
      );
    }

    const { body, shown } = fitTable(
      () => head,
      ['参考基因组', 'dataset key', 'label', 'genome_concordant', '样本元数据'],
      rows,
      url,
      // 目录工具的省略句仍在 fitTable 之后后拼，必须留位（不用 variant_query 那个吃满预算的常量）
      VARIANT_CATALOG_BODY_BUDGET,
      48,
    );
    const tail = shown < rows.length ? `\n（表中仅列 ${shown} 个，共 ${rows.length} 个；用 keyword 缩小范围）` : '';
    const out = result(`${body}${tail}`, res, {
      references: references.length,
      total: all.length,
      concordant: concordantCount,
      datasets: all.map((row) => ({
        reference: row.reference,
        key: row.key,
        label: row.label,
        genome_concordant: row.concordant,
        has_sample_meta: row.hasSampleMeta,
      })),
    }, `datasets=${all.length}`);
    /**
     * 后拼省略句的**最终文本**守卫（2026-10-30，按审查意见加强）。
     *
     * 目录工具是"先排表、后拼 tail"的形态：正文顶满预算时，`tail` 会被 `finishResult` 裁掉。
     * 只检查 `body + tail` 不够——真正给用户看的是 `out.text`，所以这里断言的是**最终文本**：
     *   ① 省略句完整出现在 `out.text`（被裁即抛错）；
     *   ② 省略句里的数字与表格实际行数一致（不许"报的数"和"给的数"不同）；
     *   ③ 整包 ≤ 4096 B、出处仍完整。
     */
    if (tail) {
      const sentence = `（表中仅列 ${shown} 个，共 ${rows.length} 个；用 keyword 缩小范围）`;
      const renderedRows = out.text.split('\n').filter((line) => line.trim().startsWith('|')).length - 2;
      if (!out.text.includes(sentence) || renderedRows !== shown) {
        throw new UpstreamShapeError(
          `数据集目录的省略句未完整出现在最终正文（渲染 ${renderedRows} 行 / 报告 ${shown} 行）`
          + '——被预算裁掉就等于没告诉用户"还有更多"，拒绝输出',
          { url },
        );
      }
    }
    if (utf8Bytes(out.text) > 4096) {
      throw new UpstreamShapeError(`数据集目录整包 ${utf8Bytes(out.text)} B 超 4096 B 上限`, { url });
    }
    return out;
  },
};

/**
 * 区间参数：`chrom:start-end`。
 *
 * **语义（2026-10-29 五次边界实验证实）**：`start` 与 `end` 都包含，即闭区间 `start <= pos <= end`。
 * 半开解释被第④（`168830-168831` 命中 168831）与第⑤（`168829-168831` 命中 168831）两次证伪。
 *
 * **不写"1-based"或"0-based"**：实验能证明的只有端点包含性；从 `pos=168831` 反推基数命名没有依据，
 * 也不需要反推。此前描述里的"1-based"是产品口径而非实测结论，已删除。
 *
 * **单点输入**（`start === end`）：上游校验式写成 `length = end − start`，于是合法的 1 bp 区间被判
 * `Region length must be > 0` 并返回 **400**。这是上游对该形态的校验行为。
 *
 * 本仓的处理是**本地拒绝**（`InvalidArgumentError`，零请求），并提示改用 `pos-1..pos+1`。
 * 理由：扩窗会把相邻位点带回来，需要额外过滤、还要向用户解释"实际请求范围与你的输入不同"，
 * 失败模式更复杂；本地拒绝行为单一、可验证，也不会让用户把 400 误读成"该位点没有变异"。
 */
interface Region {
  /** 用户原始输入，用于回显 */
  text: string;
  chrom: string;
  /** 用户请求的闭区间两端（都包含） */
  start: number;
  end: number;
}

function regionArg(raw: unknown): Region {
  if (typeof raw !== 'string') {
    throw new InvalidArgumentError('参数 region 必须是字符串，格式为 chrom:start-end（例如 chr1A:1-200000）');
  }
  if (raw !== raw.trim()) {
    throw new InvalidArgumentError('参数 region 首尾含空白；本仓不改写输入，请去掉空白后重试（尚未联网）');
  }
  if (/[\u0000-\u001F\u007F]/.test(raw)) {
    throw new InvalidArgumentError('参数 region 含控制字符（换行/制表符等）；尚未联网');
  }
  if ([...raw].length > 100) {
    throw new InvalidArgumentError(`参数 region 过长（${[...raw].length} 字符，上限 100）`);
  }
  const match = /^([^:\s]{1,40}):(\d{1,12})-(\d{1,12})$/.exec(raw);
  if (!match) {
    throw new InvalidArgumentError('参数 region 格式必须为 chrom:start-end（单个字符串参数，不是 chrom/start/end 三个参数），例如 chr1A:1-200000');
  }
  const chrom = match[1]!;
  const start = Number(match[2]);
  const end = Number(match[3]);
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end)) {
    throw new InvalidArgumentError('参数 region 的坐标必须是安全整数');
  }
  if (start < 1) throw new InvalidArgumentError('参数 region 的起点必须 ≥ 1（0 或负数在本地拒绝）');
  if (start > end) throw new InvalidArgumentError(`参数 region 的起点 ${start} 大于终点 ${end}`);

  if (start === end) {
    // 单点：本地拒绝，零请求。上游对 `length = end − start` 的等端点会直接 400，
    // 放行只会把 400 透传给用户，还容易被误读成"该位点没有变异"。
    throw new InvalidArgumentError(
      `参数 region 的起点与终点相同（${start}）——上游会以 400 拒绝这种等端点区间，`
      + `这不是"该位点没有变异"；请改用区间查询，例如 ${chrom}:${Math.max(1, start - 1)}-${start + 1}`,
    );
  }
  return { text: raw, chrom, start, end };
}

/**
 * 400 分流（WHT-06）：区间非法 vs 数据集不支持，是**两种不同的用户动作**。
 *
 * 上游错误走另一套信封：成功是 `{success,message,timestamp,data}`，错误是 `{"detail":"…"}`。
 * 此前 400 一路冒到 `unwrap()`，最后只剩一句"上游返回 HTTP 400"，用户不知道该改区间还是改 dataset。
 *
 * 只做**固定模式匹配**，把上游文本翻成本仓自己的话术；**不把上游正文透出**给模型
 * （`payload.message` 不进可见文本的口径见 `src/core/http.ts` 的 2026-10-30 止血）。
 * 匹配不上就如实说"原因未识别"，不猜。
 */
function classifyVariant400(error: unknown, url: string): unknown {
  if (!(error instanceof UpstreamError) || error.meta.status !== 400) return error;
  const snippet = error.meta.bodySnippet ?? '';
  let detail = '';
  try {
    const parsed = JSON.parse(snippet) as Record<string, unknown>;
    if (typeof parsed.detail === 'string') detail = parsed.detail;
  } catch {
    // 截断/非 JSON：detail 保持空 → 走"原因未识别"，不猜
  }
  const message = /Region length must be > 0 and <= \d+ bp/.test(detail)
    ? '上游以 400 拒绝：区间长度非法（要求 0 < 长度 ≤ 5,000,000 bp）——**这不是"该区间没有变异"**；请缩小或调整 region 后重试'
    : /^Unsupported dataset:/.test(detail)
      ? '上游以 400 拒绝：数据集 key 不受支持——**这不是"没有变异"**；请先用 wheatomics_variant_datasets 核对 dataset key'
      : '上游以 400 拒绝本次请求，但原因未识别（不按上游原文透出）；请核对 region 与 dataset 后重试——**不要把 400 当成"没有变异"**';
  return new UpstreamError(message, {
    url, status: 400, attempts: error.meta.attempts, contentType: error.meta.contentType,
    bodySnippet: snippet,
  });
}

const variantQuery: ToolDefinition = {
  name: 'wheatomics_variant_query',
  description:
    '查 WheatOmics VariantHub 里某个数据集、某个染色体区间的变异记录（SNP/InDel），返回位点、ID、ref/alt、质量、过滤标记与 VEP 注释摘要。'
    + '当用户问「chr1A 上 1–200kb 有哪些变异」「这个区间有没有 SNP」时用。'
    + '**region 是单个字符串参数**，格式 chrom:start-end（如 chr1A:1-200000），不是三个参数。'
    + '区间为**闭区间，两端都含**（start 与 end 都包含）——这是**端点包含性的实测结论，不涉及 1-based / 0-based 的命名**。'
    + '**起点与终点不能相同**：上游会以 400 拒绝这种等端点区间，本仓在本地先拒（不是"该位点没有变异"）；查单位点请给 pos-1-pos+1。'
    + '**0 条不等于该区间没有变异**：数据集与坐标体系可能不匹配，请先用 wheatomics_variant_datasets 确认 genome_concordant=true。'
    + '**区间参数非法会被上游以 400 拒绝，那不是"没有变异"**，本仓在本地先做该校验。'
    + '**本仓不暴露按变异 ID 查询**：上游该路径是全表扫描（实测约 19 s，超出本仓上游超时预算），能力面差异归本仓、不是上游缺陷；本工具只按区间查。'
    /**
     * ⚠️ **破坏性变更（本仓策略变更，须升 minor）**：原句是
     * 「本仓不提供 offset……请缩小 region 后重查，不要指望翻页」。
     * 加了 `offset` 之后那句话**成了过时指引**——缩小区间不再是唯一出路，
     * 留着会让模型继续只推"缩区间"，而这正是密集命中时走不通的那条路。
     */
    + '**分页**：`has_more=true` 时用 `offset` 翻页——把 `offset` 设成本次已取回的条数，从那里继续；'
    + '命中密集、缩小区间也缩不下去时，**翻页比缩区间更有效**。'
    + '上游 `offset` 默认 0；`limit` 上游默认 200、上限 5000，本仓限 1–100——**这两个范围是本仓策略，不是上游限制**。',
    parameters: {
      type: 'object',
      properties: {
        dataset: {
          type: 'string',
          description: '数据集 key（来自 wheatomics_variant_datasets 的 dataset key 列），不是显示名，例如 whealbi_minocc10',
        },
        region: {
          type: 'string',
          description: '染色体区间，单个字符串 chrom:start-end，闭区间两端都含（start 与 end 都包含；这是端点包含性实测，不涉及 1-based/0-based 命名），例如 chr1A:1-200000。起点与终点不能相同（上游会返回 400）；查单位点请给 pos-1-pos+1。**本工具只支持按区间查**（不按变异 ID 查）',
        },
      limit: {
        type: 'integer',
        description: '本页最多取回多少条（1–100，默认 20）。**入参范围与已发布契约一致，本仓不收缩**；体积由**输出侧预算统一裁剪**（不在这里承诺具体字节数），被裁时正文分层报「命中 / 本次取回 / 正文展示 / 本页另有未展示 / 另有未取回」，并给出翻页或减小 limit 的重查指引',
        default: 20,
        minimum: 1,
        maximum: 100,
      },
      /**
       * 新增（破坏性变更）：`offset` 上游实测支持（默认 0、≥0），此前本仓未暴露，
       * 导致 `has_more=true` 时用户只能"缩小区间"——密集命中时缩不下去。
       * 上限取 499900（配合 limit 上限 100，可覆盖上游 limit 上限 5000 × 100 页）；
       * **这是本仓策略上的安全上限，不是上游硬限制**。
       */
      offset: {
        type: 'integer',
        description: '跳过前多少条（≥0，默认 0）。**翻页时填"本次已取回的条数"**：若上次 `has_more=true`、本次取回 N 条，下一次传 `offset=上次offset+N`。'
          + '上限 499900 是本仓策略（配合 limit 最多 100，覆盖 5000×100 页），不是上游硬限制',
        default: 0,
        minimum: 0,
        maximum: 499900,
      },
    },
    required: ['dataset', 'region'],
    additionalProperties: false,
  },
  async run(args, ctx) {
    const dataset = requireStringArg(args, 'dataset', 100);
    const region = regionArg(args.region);
    const limit = optionalIntArg(args, 'limit', 20, 1, 100);
    /**
     * 新增参数（破坏性变更）：`offset` 上游实测支持（默认 0、≥0）。
     * 上限 499900 是本仓策略：配合 limit 上限 100 可覆盖上游 5000×100 页。
     */
    const offset = optionalIntArg(args, 'offset', 0, 0, 499900);

    // 区间按用户输入原样发送；等端点已在解析阶段本地拒绝，不会走到这里
    const url = endpoint('/VariantHub/query', { dataset, region: region.text, limit, offset });
    let fetched: Awaited<ReturnType<typeof query>>;
    try {
      // offset 也必须进 presentation：出处尾注要能复现这次查询
      fetched = await query(ctx, url, { limit, offset });
    } catch (error) {
      // 400 分流：区间非法 / 数据集不支持，是两种不同的用户动作，不能都给一句"HTTP 400"
      throw classifyVariant400(error, url);
    }
    const { res, result } = fetched;
    const data = unwrap<Record<string, unknown>>(res.data, url);

    const records = strictObjects(requireArrayField(data, 'records', url, '变异区间查询'), url, '变异区间查询 records');

    /**
     * 数据集身份对账（审查 WHT3-02）。
     *
     * 原来只核对坐标。若上游返回了另一个数据集的记录（缓存混包/串号），
     * 坐标照样落在请求区间内，于是整包结果被当成 `dataset=whealbi_minocc10` 展示。
     * 上游确实给了 `data.dataset`，就必须拿它核对；判不了就报错，不猜别名。
     */
    const echoedDataset = data.dataset;
    if (typeof echoedDataset !== 'string' || echoedDataset.trim() === '') {
      throw new UpstreamShapeError(
        '变异响应缺少 dataset 字段，无法确认返回的是否为所请求的数据集——上游契约可能已变',
        { url },
      );
    }
    if (echoedDataset.trim() !== dataset) {
      throw new UpstreamShapeError(
        `返回的 dataset（${echoedDataset.trim()}）与请求的 dataset（${dataset}）不一致——身份不符，`
        + '拒绝把其他数据集的记录当成本次结果；请用 wheatomics_variant_datasets 核对 key',
        { url },
      );
    }

    // 区间回显：给了就核对，必须与用户请求的区间一致。
    const echoedRegion = data.region;
    if (echoedRegion !== undefined && echoedRegion !== null) {
      if (typeof echoedRegion !== 'string') {
        throw new UpstreamShapeError(`变异响应的 region 字段不是字符串（实际 ${typeof echoedRegion}）`, { url });
      }
      if (echoedRegion.trim() !== region.text) {
        throw new UpstreamShapeError(
          `返回的 region（${echoedRegion.trim()}）与请求的 region（${region.text}）不一致——身份不符`,
          { url },
        );
      }
    }

    // 计数必须真实存在（审查 WHT3-01）：缺 total 时不许把尾注写成 total=0。
    const total = requireCount(data, 'total', url, '变异区间查询');
    const totalShown = requireCount(data, 'total_shown', url, '变异区间查询');
    const hasMore = data.has_more;
    const nSamples = optNumber(data, 'n_samples', url, '变异区间查询');

    // 上游三个计数必须自洽；互相矛盾时抛错，不挑一个当真值。
    if (records.length > 0 && totalShown !== records.length) {
      throw new UpstreamShapeError(
        `上游自相矛盾：total_shown=${totalShown} 但 records 实际 ${records.length} 条——不挑一个当真值`,
        { url },
      );
    }
    if (totalShown > total) {
      throw new UpstreamShapeError(`上游自相矛盾：total_shown=${totalShown} 大于 total=${total}`, { url });
    }
    if (records.length === 0 && total > 0) {
      throw new UpstreamShapeError(
        `上游自相矛盾：total=${total} 但 records 为空——这可能不是"没有结果"，拒绝当成空结果返回`,
        { url },
      );
    }

    /**
     * 参考基因组名（WHT-06）：`data.reference` 实测存在（如 `Chinese_Spring1.0`），
     * 但此前没读、正文与 raw 都没有——**ID 与坐标的可比性取决于它**，用户看不到就无从判断
     * "这个区间是哪个组装上的"。按 §三 的顺序接：可选字段先接住、缺了就降级显示，不抛错。
     */
    const echoedReference = typeof data.reference === 'string' && data.reference.trim()
      ? data.reference.trim()
      : undefined;

    const summaryHead = (shownCount: number): string => (
      `dataset=${dataset}｜`
      + (echoedReference ? `reference=${echoedReference}｜` : 'reference=(上游未给)｜')
      + `区间 ${region.text}｜`
      + (offset > 0 ? `offset=${offset}｜` : '')
      + (nSamples !== undefined ? `n_samples=${nSamples}｜` : '')
      // 三个计数必须分开：命中（上游判定）/ 本次取回（本页）/ 正文展示（真正进了正文的行）
      + `命中 ${total} 条；本次取回 ${records.length} 条；正文展示 ${shownCount} 条`
      + (hasMore === true
        // 破坏性变更：原句只推"缩小区间"，加了 offset 后要给翻页这条更有效的路
        ? `｜上游标记还有更多（has_more=true）——**用 offset=${offset + records.length} 翻到下一页**`
        : '')
    );

    if (records.length === 0) {
      /**
       * 空结果也必须自洽（2026-10-30 审查复现）：`has_more=true` 却说"这次一条都没有"，
       * 是上游自己矛盾。此前只有非空分支查这一条，空分支直接当成功返回——
       * 那会让用户看到"0 条"，却不知道上游声称还有更多。
       */
      if (hasMore === true) {
        throw new UpstreamShapeError(
          `上游自相矛盾：records 为空（total=${total}、total_shown=${totalShown}）却标记 has_more=true`
          + '——不猜"还有多少"，也不当作空结果返回',
          { url },
        );
      }
      return result(
        `${summaryHead(0)}\n\n该数据集在该区间返回 0 条记录（上游 total=0、records 为空）。\n`
        + '⚠️ 0 条不等于该区间没有变异。若所用数据集 genome_concordant=false（坐标与参考基因组不一致），更不能据此判断无变异；'
        + '请先用 wheatomics_variant_datasets 确认数据集一致性，或换一个 genome_concordant=true 的数据集再查。',
        res,
        // 空结果也走白名单（审查 WHT3-03）：绝不把整包 data（含 samples/genotypes/info_raw）带进 raw。
        { dataset, reference: echoedReference, region: region.text, limit, offset, n_samples: nSamples, total, total_shown: totalShown, has_more: hasMore, records: [] },
        'total=0',
      );
    }

    /**
     * 身份对账：记录必须落在**用户请求的闭区间**内。
     *
     * 单点输入（`start === end`）已在解析阶段本地拒绝，实际请求区间恒等于用户输入，
     * 因此这里比对的就是用户给的那段区间，不存在"请求区间与用户输入不同"的情形。
     * 逐条核对染色体与坐标：区间外或染色体不符的记录属于身份不符，直接报错，不把无关位点当结果。
     *
     * 端点包含性已由五次实验证实为闭区间（`start <= pos <= end`）。
     */
    const wantedChrom = region.chrom.toLowerCase();
    const outside: string[] = [];
    const kept: Array<Record<string, unknown>> = [];
    for (const record of records) {
      const chrom = str(record.chrom);
      const pos = toNum(record.pos);
      if (chrom === undefined || !Number.isFinite(pos)) {
        throw new UpstreamShapeError('变异记录缺少 chrom 或 pos，无法核对是否属于本次请求区间——上游契约可能已变', { url });
      }
      if (chrom.toLowerCase() !== wantedChrom) {
        outside.push(`${chrom}（染色体不符）`);
        continue;
      }
      if (pos < region.start || pos > region.end) {
        outside.push(`${chrom}:${pos}`);
        continue;
      }
      kept.push(record);
    }
    if (outside.length > 0) {
      throw new UpstreamShapeError(
        `返回了请求区间之外的记录：${outside.slice(0, 3).join('、')}——身份不符，拒绝把无关记录当结果；`
        + '请检查染色体命名与区间端点',
        { url },
      );
    }

    /**
     * 从 VEP `info.ANN` 提取 consequence / impact / gene。
     *
     * ⚠️ 字段顺序（0-based，按 VEP 标准 ANN 规范，上游原文形如
     * `T|downstream_gene_variant|MODIFIER|TraesCS1A02G000700|TraesCS1A02G000700.1|protein_coding|4/5`）：
     *   0 Allele ｜ 1 Consequence ｜ 2 IMPACT ｜ 3 SYMBOL ｜ 4 Gene ｜ 5 Feature_type ｜ 6 Feature
     *
     * 原来写成取 `parts[0..2]`，实际拿到的是「等位基因|consequence|impact」——**基因 ID 被整个丢掉**，
     * 且因为等位基因位存在，错位看起来像是正常的 `effect|impact|gene` 三段。这是最危险的一类错：
     * 输出格式没坏、只是每一列都错了一格。已由调研者的字段核对暴露。
     */
    const annOf = (record: Record<string, unknown>): string => {
      const info = record.info;
      if (!info || typeof info !== 'object' || Array.isArray(info)) return '-';
      const ann = (info as Record<string, unknown>).ANN;
      if (typeof ann !== 'string' || !ann.trim()) return '-';
      const first = ann.split(',')[0] ?? '';
      const parts = first.split('|');
      // 少于 5 段时无法可靠定位 Gene 位；宁可显式报缺失，也不按错位的下标硬取。
      if (parts.length < 5) {
        throw new UpstreamShapeError(
          `info.ANN 的字段数只有 ${parts.length} 段，少于 VEP 标准的前 5 段（Allele|Consequence|IMPACT|SYMBOL|Gene）——`
          + '无法可靠提取基因，拒绝按错位下标硬取',
          { url },
        );
      }
      const consequence = parts[1] ?? '';
      const symbol = parts[3] ?? '';
      const gene = parts[4] ?? '';
      // SYMBOL 与 Gene 常常相同，相同时不重复打印。
      const geneLabel = gene && symbol && gene !== symbol ? `${gene}(${symbol})` : gene || symbol;
      // 契约要求「基因 ID 与 consequence」；impact 不进正文（单元格 46 字符预算放不下三段）。
      const picked = [consequence, geneLabel].filter(Boolean).join(' / ');
      return picked || '-';
    };

    /**
     * 点号占位不是空值。
     *
     * 上游实测 `qual="."`（`filter="PASS"`）。VCF 里 `.` 表示"未计算/无值"，不是 0、也不是缺失字段。
     * 直接打印成 `-` 会让人以为我们没取到，直接打印 `.` 又容易被忽略，所以显式标注。
     */
    const qualOf = (value: unknown): string => {
      if (value === null || value === undefined || value === '') return '(未给)';
      const text = String(value).trim();
      if (text === '.') return '.(未计算)';
      return text;
    };

    const filterOf = (value: unknown): string => {
      if (value === null || value === undefined || value === '') return '(未给)';
      const text = String(value).trim();
      return text === '.' ? '.(未给过滤标记)' : text;
    };

    const rows = kept.map((record) => [
      `${str(record.chrom) ?? '?'}:${record.pos ?? '?'}`,
      record.id,
      `${str(record.ref) ?? '?'}>${str(record.alt) ?? '?'}`,
      qualOf(record.qual),
      filterOf(record.filter),
      annOf(record),
    ]);

    /**
     * 计数有**两个不同的缺口**，禁止合并成一句「另有 N 条」（WHT-01，负责人 2026-10-30 定口径）：
     *
     *   缺口一「本页内未展示」= 本次取回 − 正文展示 → 动作：减小 limit 让本页放得下，或缩小区间；
     *   缺口二「未取回」      = 命中总数 − 本次取回 → 动作：调大 limit（≤100），仍不够只能缩小区间。
     *
     * 合并报的后果是真实的：`total=427 / 本页 50 / 展示 6` 时报「另有 44 条」，
     * 用户以为快看完了，实际还剩 421 条——**少报 377**。
     *
     * **缺口文案必须参与字节预算**（2026-10-30 审查复现）：原来它拼在 `fitTable` 之后，
     * 正文一顶到预算就被裁掉，用户看不到"还有 N 条没取回"这句——报数再准也没送到。
     * 所以它进 headLines，由 fitTable 逐行试排时算进去。
     */
    const pageRecords = rows.length;
    const notFetchedTotal = total - pageRecords;
    const limitAtCap = limit >= 100;

    const gapText = (shownCount: number): string => {
      const parts: string[] = [];
      const omittedHere = pageRecords - shownCount;
      if (omittedHere > 0) {
        parts.push(`本页另有 ${omittedHere} 条未展示——可减小 limit 让本页放得下，或缩小区间后重查`);
      }
      if (notFetchedTotal > 0) {
        parts.push(limitAtCap
          ? `另有 ${notFetchedTotal} 条未取回（limit 已到本仓上限 100，本仓不分页）——请缩小区间后重查`
          : `另有 ${notFetchedTotal} 条未取回（本仓不分页）——可调大 limit（本仓上限 100）或缩小区间后重查`);
      }
      return parts.length ? `（${parts.join('；')}）` : '';
    };

    const { body, shown } = fitTable(
      (shownCount) => {
        const gap = gapText(shownCount);
        return [
          summaryHead(shownCount),
          // 只写已证实的端点包含性，不写 1-based/0-based（基数命名无法从数据反推）
          '注：区间为闭区间，两端都含（端点包含性实测，不涉及 1-based/0-based 命名）；`0 条` 与「无变异」不是一回事。'
          + '每条只给位点与注释摘要，不含逐样本基因型。',
          ...(gap ? [gap] : []),
        ];
      },
      ['位点', '变异 ID', 'ref>alt', 'qual', 'filter', 'VEP 注释'],
      rows,
      url,
      // 只有这一个调用点用满 1408：缺口句已进 headLines 参与试排，表格让位即可
      VARIANT_QUERY_BODY_BUDGET,
      46,
    );

    const omittedInPage = pageRecords - shown;
    const notFetched = notFetchedTotal;

    // 恒等式一：正文展示 + 本页未展示 = 本次取回
    if (omittedInPage < 0 || shown + omittedInPage !== pageRecords) {
      throw new UpstreamShapeError(
        `计数不自洽（一）：展示 ${shown} + 本页未展示 ${omittedInPage} ≠ 本次取回 ${pageRecords}——拒绝输出不可信计数`,
        { url },
      );
    }
    // 恒等式二：本次取回 + 未取回 = 命中总数。不成立说明上游 total 与 records 互相矛盾。
    if (notFetched < 0 || pageRecords + notFetched !== total) {
      throw new UpstreamShapeError(
        `计数不自洽（二）：本次取回 ${pageRecords} + 未取回 ${notFetched} ≠ 命中 ${total}——上游 total 与 records 矛盾`,
        { url },
      );
    }
    // has_more 与两个缺口必须自洽：说"还有更多"却一条都没少，就是上游自己矛盾——
    // 不替它猜"还有多少"，也不留下一句没有动作的"还有更多"。
    if (hasMore === true && notFetched === 0) {
      throw new UpstreamShapeError(
        `上游自相矛盾：has_more=true，但本次取回 ${pageRecords} 条已等于命中 ${total} 条——不猜还有多少，拒绝输出`,
        { url },
      );
    }
    // 报出的缺口必须真的出现在正文里（预算兜不住时宁可少排几行，也不能把这句话裁掉）
    if (!body.includes(gapText(shown)) && gapText(shown) !== '') {
      throw new UpstreamShapeError(
        '缺口提示未进入正文（被字节预算裁掉）——拒绝输出"报数在 raw、正文看不到"的结果',
        { url },
      );
    }

    /**
     * raw 白名单投影。
     *
     * **实测体积来源（2026-10-29 更正）**：
     * 单条 9398 B 的响应里，`data.samples`（487 个样本名）占 46.6%、`records[0].genotypes`（487 个基因型）占 41.5%，
     * 两者合计 **88.1%**；`info` 与 `info_raw` 各只占 3.5%。
     *
     * 我原先按"去掉 info_raw 就够了"实现是错的——那样仍有约 9 KB，会被 `result()` 硬截断，可能切掉出处或留半条记录。
     * 现在的裁剪是三条一起做：不读 `samples`、不读 `genotypes`、`info_raw` 也不读，只留六列 + ANN 摘要。
     * **空结果与非空结果共用同一投影规则**（审查 WHT3-03）。
     */
    const projected = kept.map((record) => ({
      chrom: record.chrom,
      pos: record.pos,
      id: record.id,
      ref: record.ref,
      alt: record.alt,
      qual: record.qual,
      filter: record.filter,
      ann: annOf(record) === '-' ? undefined : annOf(record),
    }));

    return result(body, res, {
      dataset,
      reference: echoedReference,
      region: region.text,
      limit,
      offset,
      n_samples: nSamples,
      total,
      total_shown: totalShown,
      has_more: hasMore,
      // 翻页提示：next_offset 仅在 has_more 时给出，避免用户误以为还有下一页
      ...(hasMore === true ? { next_offset: offset + records.length } : {}),
      records: projected,
    }, `total=${total}`);
  },
};

// ── G6：蛋白互作 + 调控区（2026-11-10 实测 E10） ─────────────────────────────

/**
 * `PPI_poppin` 的边是"水稻 PoppIn 网络转移到小麦 A/B/D"的结果：
 * `wheat_id1`/`wheat_id2` 是数组（同源拷贝），`rice_pair` 是底层水稻互作，
 * `supporting_edges` 是支持该小麦对的稻边数，`identity1/2` 是水稻→小麦的最佳映射 identity。
 *
 * `PPI_result` 是 McWhite CF-MS 小麦复合物图（IWGSC RefSeq v1.1，输入需带 `.1` 后缀）。
 * 本仓 2026-11-10 只对 `PPI_poppin` 拿到正例（2 个基因 → 24,023 B / 87 条边）；
 * `PPI_result` 对同一批基因返回 0 条，因此只保留入口、不声称已实测正例。
 */
const PPI_TABLES = ['PPI_poppin', 'PPI_result'] as const;
type PpiTable = (typeof PPI_TABLES)[number];

function ppiIdList(value: unknown): string {
  if (Array.isArray(value)) {
    const parts = value.map((item) => String(item).trim()).filter(Boolean);
    return parts.length > 0 ? parts.join(',') : '-';
  }
  return str(value) ?? '-';
}

function optionalNumberArg(
  args: Record<string, unknown>,
  key: string,
  fallback: number,
  min: number,
  max: number,
): number {
  const raw = args[key];
  if (raw === undefined || raw === null || (typeof raw === 'string' && raw.trim() === '')) return fallback;
  const value = typeof raw === 'number' ? raw : typeof raw === 'string' ? Number(raw.trim()) : Number.NaN;
  if (!Number.isFinite(value) || value < min || value > max) {
    throw new InvalidArgumentError(`参数 ${key} 必须是 ${min}–${max} 之间的数字（收到 ${String(raw)}；尚未联网）`);
  }
  return value;
}

const wheatPpi: ToolDefinition = {
  name: 'wheatomics_ppi',
  description:
    '查小麦蛋白-蛋白互作（PPI）边。`table=PPI_poppin`（默认）是 PoppIn 水稻互作网络转移到小麦 A/B/D 同源拷贝的结果，'
    + '每条边带 `rice_pair`（底层水稻互作）、`supporting_edges`（支持边数）与 `identity1/2`（水稻→小麦映射 identity）；'
    + '`table=PPI_result` 是 McWhite CF-MS 小麦复合物图，输入需 IWGSC RefSeq v1.1 转录本 ID 且带 `.1` 后缀。'
    + '**上游 20 个基因/批实测 44.8 s（撞 45 s 单次上限），10 个/批 16.1 s；因此本工具按 `batch_size`（默认 10）分批查询，'
    + '再按边去重合并**；逐批耗时与失败批次进正文与 structuredContent，部分批次失败会显式标 partial。'
    + '**PPI_poppin 只认 02G 编号**（03G 直接查返回 0，不是"没有互作"）——03G 先用 wheatomics_convert_gene_ids 换算。'
    + '**正文只展示前 N 条，完整边在 structuredContent**；0 条不等于没有互作（两张表的收录范围不同）。'
    + '本工具只返回上游已有的边，不推断方向、不把同源关系当互作。',
  parameters: {
    type: 'object',
    properties: {
      gene_ids: {
        type: 'string',
        description: '小麦基因 ID，逗号/空白分隔，1–50 个；PPI_poppin 用 02G 编号（不带 .1），PPI_result 用带 .1 的转录本 ID',
      },
      table: {
        type: 'string',
        enum: [...PPI_TABLES],
        default: 'PPI_poppin',
        description: 'PPI_poppin（水稻网络转移，默认）或 PPI_result（CF-MS 复合物图）',
      },
      min_score: {
        type: 'number',
        description: '仅 PPI_result 使用：CF-MS 置信度阈值（0–1，默认 0.5；上游建议 0.5/0.2/0）',
        default: 0.5,
        minimum: 0,
        maximum: 1,
      },
      limit: {
        type: 'integer',
        description: '正文最多展示多少条边（1–50，默认 10）；完整边在 structuredContent',
        default: 10,
        minimum: 1,
        maximum: 50,
      },
      batch_size: {
        type: 'integer',
        description: '每次发给上游的基因数（1–20，默认 10）。20 个/批实测 44.8 s 会撞 45 s 上限；'
          + '缩小 batch_size 可让单批更快、超时只影响一小批',
        default: 10,
        minimum: 1,
        maximum: 20,
      },
    },
    required: ['gene_ids'],
    additionalProperties: false,
  },
  async run(args, ctx) {
    for (const key of Object.keys(args)) {
      if (!['gene_ids', 'table', 'min_score', 'limit', 'batch_size'].includes(key)) {
        throw new InvalidArgumentError(`未知参数：${key}（尚未联网）`);
      }
    }
    const rawIds = requireStringArg(args, 'gene_ids', 1_500);
    const geneIds = splitIds(rawIds, 50, 'gene_ids');
    const table = (optionalStringArg(args, 'table', 20) ?? 'PPI_poppin') as PpiTable;
    if (!PPI_TABLES.includes(table)) {
      throw new InvalidArgumentError(`table 只接受 ${PPI_TABLES.join(' / ')}（尚未联网）`);
    }
    const minScore = optionalNumberArg(args, 'min_score', 0.5, 0, 1);
    const limit = optionalIntArg(args, 'limit', 10, 1, 50);
    const batchSize = optionalIntArg(args, 'batch_size', 10, 1, 20);

    interface BatchRun {
      batch: number;
      gene_ids: string[];
      request: string;
      status: number;
      duration_ms: number;
      edges: number;
      error?: string;
    }

    const presentationBase = { table, limit, ...(table === 'PPI_result' ? { min_score: minScore } : {}) };
    const batches = chunk(geneIds, batchSize);
    const prepareds: PreparedRequest[] = [];
    const runs: BatchRun[] = [];
    const mergedEdges: Array<Record<string, unknown>> = [];
    const seenEdges = new Set<string>();
    let lastError: UpstreamError | undefined;
    let primary: { prepared: PreparedRequest; res: HttpResult } | undefined;

    for (let index = 0; index < batches.length; index += 1) {
      const batch = batches[index]!;
      const url = endpoint('/ppi/query', {
        gene_ids: batch.join(','),
        table,
        // PPI_poppin 是离散网络，上游明确忽略 min_score；不发，避免让人以为阈值生效。
        ...(table === 'PPI_result' ? { min_score: minScore } : {}),
      });
      const prepared = prepareRequest({
        url,
        sourceName: manifest.displayName,
        presentation: { ...presentationBase, batch: index + 1, batches: batches.length },
      });
      prepareds.push(prepared);
      const started = Date.now();
      /**
       * 单批超时按基因数线性放宽（10 个 ≈ 16.1 s，20 个 ≈ 44.8 s），但**都有上限**：
       * 不自动重试（重试会把一批 35 s 拖到 70 s，调用方早已超时）。
       */
      const perBatchTimeoutMs = Math.min(60_000, 15_000 + batch.length * 2_000);
      try {
        const res = await fetchPrepared(ctx, prepared, {
          timeoutMs: perBatchTimeoutMs,
          retries: 0,
          maxTotalMs: perBatchTimeoutMs + 5_000,
        });
        const data = unwrap<Record<string, unknown>>(res.data, prepared.url);
        const interactions = strictObjects(
          requireArrayField(data, 'interactions', prepared.url, 'PPI 查询'),
          prepared.url,
          'PPI 查询 interactions',
        );
        for (const edge of interactions) {
          const key = [
            ppiIdList(edge.wheat_id1), ppiIdList(edge.wheat_id2), str(edge.rice_pair) ?? '',
            str(edge.score) ?? '', str(edge.supporting_edges) ?? '',
          ].join('|');
          if (seenEdges.has(key)) continue;
          seenEdges.add(key);
          mergedEdges.push(edge);
        }
        runs.push({
          batch: index + 1,
          gene_ids: batch,
          request: prepared.request,
          status: res.status,
          duration_ms: Date.now() - started,
          edges: interactions.length,
        });
        primary = { prepared, res };
      } catch (error) {
        if (!(error instanceof UpstreamError)) throw error;
        lastError ??= error;
        runs.push({
          batch: index + 1,
          gene_ids: batch,
          request: prepared.request,
          status: error.meta.status ?? 0,
          duration_ms: Date.now() - started,
          edges: 0,
          error: error.message,
        });
      }
    }

    if (!primary) {
      throw lastError ?? new UpstreamError('PPI 分批查询全部失败（无可用批次）', {
        url: prepareds[0]?.url ?? endpoint('/ppi/query', { gene_ids: geneIds.join(','), table }),
      });
    }
    const failedRuns = runs.filter((run) => run.error);
    const batchLine = `分批：${batches.length} 批（batch_size=${batchSize}）`
      + (batches.length > 1 ? `；${runs.map((run) => `${run.gene_ids.length} 基因/${run.duration_ms} ms/${run.edges} 边${run.error ? '（失败）' : ''}`).join('、')}` : '');

    const ppiGeneration = sharedGeneration(geneIds);
    const zero = diagnoseZero({
      endpoint: `/api/ppi/query?table=${table}`,
      generation: generationLabel(ppiGeneration),
      support: table === 'PPI_poppin'
        ? generationSupport(ppiGeneration, ['02'], ['03'])
        : generationSupport(ppiGeneration, ['01'], ['03']),
      supportBasis: table === 'PPI_poppin'
        ? 'PPI_poppin 实测 02G 正例 87 条、03G 回 0；01G 未测'
        : 'PPI_result 实测需 01G 转录本 + .1；03G 不认；02G 未测',
      status: primary.res.status,
      durationMs: primary.res.durationMs,
      bytes: responseBytes(primary.res),
      endpointFailed: failedRuns.length > 0,
    });
    const emptyStructured = {
      table,
      gene_ids: geneIds,
      batch_size: batchSize,
      total: 0,
      shown: 0,
      interactions: [],
      batches: runs,
      failed_batches: failedRuns.map((run) => run.batch),
      partial: failedRuns.length > 0,
      zero,
    };
    if (mergedEdges.length === 0) {
      return finishResult({
        body: `表 ${table}｜输入 ${geneIds.length} 个基因｜上游返回 0 条互作边（interactions=[]）。\n`
          + `${batchLine}（逐批完整请求见 structuredContent.batches[].request）。\n`
          + '0 条不等于"没有互作"：PPI_poppin 只收能由水稻网络转移的小麦边；PPI_result 只收 CF-MS 复合物图，'
          + '且输入需 IWGSC RefSeq v1.1 转录本 ID（带 .1 后缀）。PPI_poppin 需要 02G 编号（03G 返回 0 是编号代次问题）。\n'
          + renderZeroDiagnosis(zero),
        res: primary.res,
        prepared: primary.prepared,
        sourceId: manifest.id,
        raw: emptyStructured,
        structured: emptyStructured,
        extra: [manifest.versionNote, `${batchLine}；total=0；table=${table}`].filter(Boolean).join('；'),
      });
    }

    const rows = mergedEdges.map((edge) => {
      const evidence = table === 'PPI_poppin'
        ? (str(edge.rice_pair) ?? '-')
        : (Number.isFinite(toNum(edge.score)) ? `score=${num(edge.score, 3)}` : '-');
      return [
        ppiIdList(edge.wheat_id1),
        ppiIdList(edge.wheat_id2),
        evidence,
        edge.supporting_edges,
        edge.identity1,
        edge.identity2,
      ];
    });
    const { body, shown } = fitTable(
      (shownCount) => [
        `表 ${table}｜输入 ${geneIds.length} 个基因｜共 ${mergedEdges.length} 条互作边（已按边去重）｜正文展示 ${shownCount} 条`,
        batchLine,
        table === 'PPI_poppin'
          ? '证据：rice_pair=底层水稻互作；supporting_edges=支持边数；identity1/2=水稻→小麦映射 identity（%）。'
          : '证据：score=CF-MS 置信度；supporting_edges/identity 在该表可能不提供（显示"未提供"）。',
      ],
      ['基因1', '基因2', table === 'PPI_poppin' ? '水稻互作' : 'CF-MS score', '支持边', 'identity1', 'identity2'],
      rows.slice(0, limit),
      primary.prepared.url,
      MAX_BODY_BYTES - 240,
      42,
    );
    const tail = shown < rows.length
      ? `\n（本次正文展示 ${shown} 条，另有 ${rows.length - shown} 条未展示；完整边见 structuredContent）`
      : '';
    const partialNote = failedRuns.length > 0
      ? `\n（partial：第 ${failedRuns.map((run) => run.batch).join('、')} 批失败（${failedRuns[0]?.error ?? '超时'}），结果不完整；可减小 batch_size 或缩小 gene_ids 重试）`
      : '';
    const structured = {
      table,
      gene_ids: geneIds,
      batch_size: batchSize,
      total: mergedEdges.length,
      shown,
      interactions: mergedEdges.map((edge) => ({
        wheat_id1: edge.wheat_id1,
        wheat_id2: edge.wheat_id2,
        rice_pair: edge.rice_pair,
        supporting_edges: edge.supporting_edges,
        identity1: edge.identity1,
        identity2: edge.identity2,
        subgenome1: edge.subgenome1,
        subgenome2: edge.subgenome2,
        score: edge.score,
      })),
      batches: runs,
      failed_batches: failedRuns.map((run) => run.batch),
      partial: failedRuns.length > 0,
    };

    /**
     * 分批的**完整请求证据**：尾部预算只有 2560 B，5 批的 URL 放不下。
     * 先尽量把其余批的完整请求塞进出处；塞不下的部分在正文与 structuredContent.batches[].request 里逐批可查，
     * 并由出处明确写出「另有 N 批见 structuredContent」——不静默丢证据。
     */
    const others = prepareds.filter((prepared) => prepared !== primary.prepared).map((prepared) => prepared.request);
    const buildExtra = (kept: string[]): string => {
      const parts = [batchLine, `total=${mergedEdges.length}；table=${table}`];
      if (kept.length > 0) parts.push(`其余批请求：${kept.join('；')}`);
      if (kept.length < others.length) {
        parts.push(`另有 ${others.length - kept.length} 批完整请求见 structuredContent.batches[].request`);
      }
      if (failedRuns.length > 0) parts.push(`失败批次=${failedRuns.map((run) => run.batch).join('、')}（结果不完整）`);
      return [manifest.versionNote, ...parts].filter(Boolean).join('；');
    };
    let keptOthers = others;
    let extra = buildExtra(keptOthers);
    const tailBytes = (text: string): number => utf8Bytes(provenance({
      sourceName: manifest.displayName,
      request: primary.prepared.request,
      status: primary.res.status,
      durationMs: primary.res.durationMs,
      at: '9999-12-31T23:59:59.999Z',
      extra: text,
    }));
    while (keptOthers.length > 0 && tailBytes(extra) > MAX_TAIL_BYTES) {
      keptOthers = keptOthers.slice(0, -1);
      extra = buildExtra(keptOthers);
    }
    if (tailBytes(extra) > MAX_TAIL_BYTES) {
      throw new InvalidArgumentError('分批出处的证据已超出 2560 字节上限；请减小 batch_size 或基因数（尚未联网）');
    }

    return finishResult({
      body: `${body}${tail}${partialNote}`,
      res: primary.res,
      prepared: primary.prepared,
      sourceId: manifest.id,
      raw: structured,
      structured,
      extra,
    });
  },
};

function scientific(value: unknown): string {
  const n = toNum(value);
  return Number.isFinite(n) ? n.toExponential(2) : '未提供';
}

const wheatRegulatory: ToolDefinition = {
  name: 'wheatomics_regulatory',
  description:
    '查小麦基因的调控区档案（上游 regulatory 模块）：基因/转录本坐标、调控区（upstream 等）区间、'
    + 'motif 命中数、motif 数、最小 p 值与组装版本。'
    + '坐标字段名是 start0/end0/tss0/tes0（0-based）。'
    + '**传 `hit_limit` 时再用 `/api/regulatory/gene/{id}/hits` 取 motif→target 明细**'
    + '（motif id / motif 名 / 来源通道 motif_source / 坐标 / 链 / p 值 / 匹配序列），汇总计数照旧保留；'
    + '上游该基因共 798 条命中，一次最多取 50 条，取的是上游按 p 值/命中顺序的首页。'
    + '当用户问"这个基因上游有哪些调控元件/motif 命中"时用；03G 直接查上游 404（只认 02G）。',
  parameters: {
    type: 'object',
    properties: {
      gene_id: {
        type: 'string',
        description: '小麦基因 ID（上游 regulatory 只认 02G），例如 TraesCS1A02G013100',
      },
      hit_limit: {
        type: 'integer',
        description: '要取多少条 motif→target 明细（0–50，默认 0=只要汇总）；明细在正文与 structuredContent.hits',
        default: 0,
        minimum: 0,
        maximum: 50,
      },
      max_pvalue: {
        type: 'number',
        description: '仅 hit_limit>0 时使用：只要 p 值 ≤ 该阈值的命中（0–1，不填=上游不过滤）',
        minimum: 0,
        maximum: 1,
      },
    },
    required: ['gene_id'],
    additionalProperties: false,
  },
  async run(args, ctx) {
    for (const key of Object.keys(args)) {
      if (!['gene_id', 'hit_limit', 'max_pvalue'].includes(key)) {
        throw new InvalidArgumentError(`未知参数：${key}（尚未联网）`);
      }
    }
    const geneId = requireStringArg(args, 'gene_id', 60);
    if (!/^[A-Za-z0-9._-]{1,60}$/.test(geneId)) {
      throw new InvalidArgumentError(`gene_id 形状非法：${geneId.slice(0, 40)}（尚未联网）`);
    }
    const hitLimit = optionalIntArg(args, 'hit_limit', 0, 0, 50);
    const maxPvalue = args.max_pvalue === undefined || args.max_pvalue === null
      ? undefined
      : optionalNumberArg(args, 'max_pvalue', 1, 0, 1);
    const url = endpoint(`/regulatory/gene/${encodeURIComponent(geneId)}`);
    const { res, result } = await query(ctx, url, { hit_limit: hitLimit, max_pvalue: maxPvalue ?? null });
    const rawData = res.data;
    if (!rawData || typeof rawData !== 'object' || Array.isArray(rawData)) {
      throw new UpstreamShapeError('调控响应不是对象——上游契约可能已变', { url });
    }
    const data = rawData as Record<string, unknown>;
    const gene = data.gene;
    const region = data.region;
    const summary = data.summary;
    if (!gene || typeof gene !== 'object' || Array.isArray(gene)) {
      throw new UpstreamShapeError('调控响应缺少 gene 对象——上游契约可能已变', { url });
    }
    if (!region || typeof region !== 'object' || Array.isArray(region)) {
      throw new UpstreamShapeError('调控响应缺少 region 对象——上游契约可能已变', { url });
    }
    if (!summary || typeof summary !== 'object' || Array.isArray(summary)) {
      throw new UpstreamShapeError('调控响应缺少 summary 对象——上游契约可能已变', { url });
    }
    const g = gene as Record<string, unknown>;
    const r = region as Record<string, unknown>;
    const s = summary as Record<string, unknown>;
    const echoed = str(g.gene_id);
    if (echoed !== geneId) {
      throw new UpstreamShapeError(
        `返回的 gene_id（${echoed ?? '(缺)'}）与请求的 ${geneId} 不一致——身份不符，拒绝展示`,
        { url },
      );
    }
    const hitCount = requireCount(s, 'hit_count', url, '调控汇总');
    const motifCount = requireCount(s, 'motif_count', url, '调控汇总');
    const summaryBody = [
      `${geneId}｜调控区 ${str(r.kind) ?? '(未给 kind)'}（组装 ${str(data.assembly) ?? '未提供'}）`,
      renderFields([
        ['染色体', str(g.chrom)],
        ['基因区间（0-based）', `${num(g.start0, 0)}–${num(g.end0, 0)}`],
        ['链方向', g.strand === '+' ? '+' : g.strand === '-' ? '-' : undefined],
        ['转录本', str(g.transcript_id)],
        ['TSS / TES（0-based）', `${num(g.tss0, 0)} / ${num(g.tes0, 0)}`],
        ['调控区区间（0-based）', `${str(r.chrom) ?? '-'}:${num(r.start0, 0)}–${num(r.end0, 0)}`],
        ['motif 命中数', hitCount],
        ['motif 数', motifCount],
        ['最小 p 值', scientific(s.min_pvalue)],
      ]),
      '注：坐标字段是上游的 0-based 命名。',
    ].join('\n');
    if (utf8Bytes(summaryBody) > MAX_BODY_BYTES) {
      throw new InvalidArgumentError('调控正文超过 1408 UTF-8 字节，拒绝交给统一截断');
    }

    interface RegulatoryHit {
      hit_id: unknown;
      motif_id: string | null;
      motif_name: string | null;
      motif_source: string | null;
      chrom: string | null;
      start0: unknown;
      end0: unknown;
      strand: unknown;
      score: unknown;
      pvalue: unknown;
      qvalue: unknown;
      matched_sequence: string | null;
    }

    let body = summaryBody;
    let hitsTotal: number | null = null;
    let hitsShown = 0;
    let hitItems: RegulatoryHit[] = [];
    let hitsPrepared: PreparedRequest | undefined;
    let hitsRes: HttpResult | undefined;

    if (hitLimit > 0) {
      const hitsUrl = endpoint(`/regulatory/gene/${encodeURIComponent(geneId)}/hits`, {
        page_size: hitLimit,
        ...(maxPvalue === undefined ? {} : { max_pvalue: maxPvalue }),
      });
      const prepared = prepareRequest({
        url: hitsUrl,
        sourceName: manifest.displayName,
        presentation: { hit_limit: hitLimit, max_pvalue: maxPvalue ?? null },
      });
      hitsPrepared = prepared;
      // 命中明细端点实测 0.2 s；显式给上限，不重试。
      const hitsResponse = await fetchPrepared(ctx, prepared, { timeoutMs: 20_000, retries: 0, maxTotalMs: 25_000 });
      hitsRes = hitsResponse;
      const hitsPayload = hitsResponse.data;
      if (!hitsPayload || typeof hitsPayload !== 'object' || Array.isArray(hitsPayload)) {
        throw new UpstreamShapeError('motif 命中响应不是对象——上游契约可能已变', { url: prepared.url });
      }
      const hitData = hitsPayload as Record<string, unknown>;
      const echoedGene = str(hitData.gene_id);
      if (echoedGene !== geneId) {
        throw new UpstreamShapeError(
          `motif 命中响应的 gene_id（${echoedGene ?? '(缺)'}）与请求的 ${geneId} 不一致——身份不符，拒绝展示`,
          { url: prepared.url },
        );
      }
      hitsTotal = requireCount(hitData, 'total', prepared.url, 'motif 命中');
      const items = strictObjects(requireArrayField(hitData, 'items', prepared.url, 'motif 命中'), prepared.url, 'motif 命中 items');
      hitItems = items.map((item) => ({
        hit_id: item.hit_id,
        motif_id: str(item.motif_id) ?? null,
        motif_name: str(item.motif_name) ?? null,
        motif_source: str(item.motif_source) ?? null,
        chrom: str(item.chrom) ?? null,
        start0: item.start0,
        end0: item.end0,
        strand: item.strand,
        score: item.score,
        pvalue: item.pvalue,
        qvalue: item.qvalue,
        matched_sequence: str(item.matched_sequence) ?? null,
      }));

      const budget = MAX_BODY_BYTES - utf8Bytes(summaryBody) - 120;
      const fitted = fitTable(
        (shownCount) => [
          `motif→target 明细：上游共 ${hitsTotal} 条命中，本次取 ${items.length} 条，正文展示 ${shownCount} 条`
          + `（来源通道=${str(manifest.displayName) ?? 'WheatOmics'} /api/regulatory/gene/{id}/hits；motif 来源见 motif_source 列）`,
          '注：p 值/min_pvalue 为上游原值，本工具不改阈值、不重算。',
        ],
        ['motif_id', '名称', '来源', '位置（0-based）', '链', 'score', 'p', '匹配序列'],
        hitItems.map((hit) => [
          hit.motif_id, hit.motif_name, hit.motif_source,
          `${hit.chrom ?? '-'}:${num(hit.start0, 0)}-${num(hit.end0, 0)}`,
          hit.strand, num(hit.score, 3), scientific(hit.pvalue), hit.matched_sequence,
        ]),
        prepared.url,
        Math.max(180, budget),
        30,
      );
      hitsShown = fitted.shown;
      const omitted = items.length > fitted.shown
        ? `\n（本次正文展示 ${fitted.shown} 条，另有 ${items.length - fitted.shown} 条已取回未展示；完整明细致 structuredContent.hits）`
        : '';
      body = `${summaryBody}\n${fitted.body}${omitted}`;
    }

    const structured = {
      gene_id: geneId,
      gene: { chrom: g.chrom, start0: g.start0, end0: g.end0, strand: g.strand,
        transcript_id: g.transcript_id, tss0: g.tss0, tes0: g.tes0 },
      region: { region_id: r.region_id, kind: r.kind, chrom: r.chrom, start0: r.start0, end0: r.end0 },
      summary: { hit_count: hitCount, motif_count: motifCount, min_pvalue: s.min_pvalue },
      region_kind: data.region_kind,
      assembly: data.assembly,
      hits: {
        requested: hitLimit > 0,
        endpoint: '/api/regulatory/gene/{gene_id}/hits',
        total: hitsTotal,
        shown: hitsShown,
        items: hitItems.map((hit) => ({ ...hit, target_gene: geneId })),
        note: 'motif_source=上游 motif 来源通道；坐标为 0-based；p 值为上游原值',
      },
    };

    // 两次请求（汇总 + 命中明细）的出处都列出：明细请求是这次的「主请求」。
    if (hitsPrepared && hitsRes) {
      return finishResult({
        body, res: hitsRes, prepared: hitsPrepared, sourceId: manifest.id,
        raw: structured, structured,
        extra: [manifest.versionNote, `hit_count=${hitCount}；motif_count=${motifCount}`, `汇总请求=${url}`]
          .filter(Boolean).join('；'),
      });
    }
    return result(body, res, structured, `hit_count=${hitCount}；motif_count=${motifCount}`, structured);
  },
};

// ── G7：GO / KEGG 富集（POST；2026-11-10 实测 E11） ─────────────────────────

const ENRICHMENT_MODES = ['go', 'kegg'] as const;
type EnrichmentMode = (typeof ENRICHMENT_MODES)[number];

const wheatEnrichment: ToolDefinition = {
  name: 'wheatomics_enrichment',
  description:
    '对一组小麦基因做 GO 或 KEGG 通路富集（超几何检验 + Benjamini-Hochberg FDR）。'
    + '`mode=go` 用 wheat_function.gene_go 背景；`mode=kegg` 走 gene_id→KO→pathway。'
    + '输入是 IWGSC RefSeq v1.1（02G）基因 ID，例如 TraesCS1A02G045300.1。'
    + '**这是 POST 端点**：GO 4 基因实测 32.5 s、20 基因 33–39 s（50 基因会超），KEGG 约 0.5 s；'
    + '本工具默认 45 s 单次超时、**不自动重试**，可用 `timeout_ms`（5–45 s）下调做快速失败。'
    + 'P/BH **全部是上游原值**，本工具不重算、不合并、不拼 padj。'
    + '**`include_gene_hits=true` 时逐条目回查「哪些送检基因命中了该 GO/KEGG 条目」**'
    + '（上游 /api/go/genes 或 /api/kegg/genes），明细进正文与 structuredContent.gene_hits。'
    + '正文只展示 padj 最小的前 N 条，完整结果在 structuredContent；0 条显著不等于没有功能富集。',
  parameters: {
    type: 'object',
    properties: {
      mode: {
        type: 'string',
        enum: [...ENRICHMENT_MODES],
        default: 'go',
        description: 'go（GO 本体富集）或 kegg（KEGG 通路富集）',
      },
      genes: {
        type: 'array',
        items: { type: 'string' },
        minItems: 1,
        maxItems: 50,
        description: '小麦基因 ID 列表（1–50 个；IWGSC RefSeq v1.1，通常带 .1 后缀；批量查询建议 ≤20 个以避开超时）',
      },
      padj_threshold: {
        type: 'number',
        description: 'BH 校正后 p 值阈值（0–1，默认 0.05）',
        default: 0.05,
        minimum: 0,
        maximum: 1,
      },
      limit: {
        type: 'integer',
        description: '正文最多展示多少条（1–50，默认 10）；完整结果在 structuredContent',
        default: 10,
        minimum: 1,
        maximum: 50,
      },
      timeout_ms: {
        type: 'integer',
        description: '单次上游请求超时（毫秒，5000–45000，默认 45000）。GO 20 基因已需 33–39 s；'
          + '更小的值用于快速失败，不会自动重试',
        default: 45000,
        minimum: 5000,
        maximum: 45000,
      },
      include_gene_hits: {
        type: 'boolean',
        description: '是否逐条目回查「哪些送检基因命中了该条目」（默认 false）；只回查 padj 最小的前 gene_hit_terms 条',
        default: false,
      },
      gene_hit_terms: {
        type: 'integer',
        description: 'include_gene_hits=true 时回查前多少条显著条目（1–10，默认 3）',
        default: 3,
        minimum: 1,
        maximum: 10,
      },
    },
    required: ['genes'],
    additionalProperties: false,
  },
  async run(args, ctx) {
    for (const key of Object.keys(args)) {
      if (!['mode', 'genes', 'padj_threshold', 'limit', 'timeout_ms', 'include_gene_hits', 'gene_hit_terms'].includes(key)) {
        throw new InvalidArgumentError(`未知参数：${key}（尚未联网）`);
      }
    }
    const mode = (optionalStringArg(args, 'mode', 10) ?? 'go') as EnrichmentMode;
    if (!ENRICHMENT_MODES.includes(mode)) {
      throw new InvalidArgumentError(`mode 只接受 ${ENRICHMENT_MODES.join(' / ')}（尚未联网）`);
    }
    const rawGenes = args.genes;
    if (!Array.isArray(rawGenes)) {
      throw new InvalidArgumentError('genes 必须是字符串数组（尚未联网）');
    }
    const genes = rawGenes.map((item, index) => {
      if (typeof item !== 'string' || !item.trim()) {
        throw new InvalidArgumentError(`genes[${index}] 必须是非空字符串（尚未联网）`);
      }
      const id = item.trim();
      if (!/^[A-Za-z0-9._-]{1,60}$/.test(id)) {
        throw new InvalidArgumentError(`genes[${index}] 形状非法：${id.slice(0, 40)}（尚未联网）`);
      }
      return id;
    });
    if (genes.length === 0 || genes.length > 50) {
      throw new InvalidArgumentError(`genes 一次需要 1–50 个，收到 ${genes.length} 个（尚未联网）`);
    }
    const threshold = optionalNumberArg(args, 'padj_threshold', 0.05, 0, 1);
    if (threshold <= 0) throw new InvalidArgumentError('padj_threshold 必须大于 0（尚未联网）');
    const limit = optionalIntArg(args, 'limit', 10, 1, 50);
    const timeoutMs = optionalIntArg(args, 'timeout_ms', 45_000, 5_000, 45_000);
    const includeGeneHits = args.include_gene_hits === true;
    if (args.include_gene_hits !== undefined && typeof args.include_gene_hits !== 'boolean') {
      throw new InvalidArgumentError('include_gene_hits 必须是布尔值（尚未联网）');
    }
    const geneHitTerms = optionalIntArg(args, 'gene_hit_terms', 3, 1, 10);

    const url = `${manifest.apiBase}/${mode}`;
    const prepared = prepareRequest({
      url,
      sourceName: manifest.displayName,
      presentation: { mode, limit, timeout_ms: timeoutMs },
      method: 'POST',
      jsonBody: { genes, padj_threshold: threshold },
    });
    /**
     * 超时策略（封装层补齐第 5 条）：**显式上限 + 不重试**，默认 45 s（GO 4 基因实测 32.5 s，
     * 20 基因 33–39 s，50 基因会超）。timeout_ms 可下调到 5 s 做快速失败；
     * 超限时把上游/时限原文交给调用方，不静默降级成空结果。
     */
    const res = await fetchPrepared(ctx, prepared, { timeoutMs, retries: 0, maxTotalMs: timeoutMs + 5_000 });

    const data = res.data;
    if (!data || typeof data !== 'object' || Array.isArray(data)) {
      throw new UpstreamShapeError('富集响应不是对象——上游契约可能已变', { url });
    }
    const payload = data as Record<string, unknown>;
    const background = requireCount(payload, 'N', url, '富集');
    const n = requireCount(payload, 'n', url, '富集');
    const geneCount = requireCount(payload, 'gene_count', url, '富集');
    const results = strictObjects(requireArrayField(payload, 'results', url, '富集'), url, '富集 results');
    const validated = results.map((entry, index) => {
      const id = str(entry.id);
      if (!id) throw new UpstreamShapeError(`富集 results 第 ${index + 1} 条缺 id——上游契约可能已变`, { url });
      const padj = toNum(entry.padj);
      const pvalue = toNum(entry.pvalue);
      if (!Number.isFinite(padj) || !Number.isFinite(pvalue)) {
        throw new UpstreamShapeError(`富集 results 第 ${index + 1} 条 padj/pvalue 不是有限数字——上游契约可能已变`, { url });
      }
      return {
        id,
        term: (str(entry.term) ?? '').replace(/\r$/, ''),
        name: (str(entry.name) ?? '').replace(/\r$/, ''),
        ontology: (str(entry.ontology) ?? '').replace(/\r$/, ''),
        k: entry.k,
        K: entry.K,
        ratio: entry.ratio,
        pvalue,
        padj,
      };
    });
    const significant = validated
      .filter((entry) => entry.padj < threshold)
      .sort((a, b) => a.padj - b.padj || a.pvalue - b.pvalue || a.id.localeCompare(b.id));

    /**
     * gene→GO / gene→KEGG 明细（封装层补齐第 5 条）。
     *
     * 上游富集响应只有 k/K，没有「谁命中了哪个条目」；明细要另调
     * `/api/go/genes`（或 `/api/kegg/genes`）逐条目回查送检基因。
     * **只做「哪些送检基因命中该条目」，不动 p 值/BH 口径，也不引入跨批拼 padj 的捷径。**
     */
    interface GeneHit {
      term_id: string;
      term: string;
      genes: string[];
      ko_details: unknown[];
      request: string | null;
      error?: string;
    }
    const geneHits: GeneHit[] = [];
    const geneHitRequests: string[] = [];
    if (includeGeneHits && significant.length > 0) {
      for (const entry of significant.slice(0, geneHitTerms)) {
        const hitsUrl = mode === 'go'
          ? endpoint('/go/genes', { go_id: entry.id, genes: genes.join(',') })
          : endpoint('/kegg/genes', { pathway: entry.id, genes: genes.join(',') });
        try {
          const hitPrepared = prepareRequest({
            url: hitsUrl,
            sourceName: manifest.displayName,
            presentation: { mode, term: entry.id },
          });
          geneHitRequests.push(hitPrepared.request);
          const hitRes = await fetchPrepared(ctx, hitPrepared, { timeoutMs: 20_000, retries: 0, maxTotalMs: 25_000 });
          const hitPayload = hitRes.data;
          if (!hitPayload || typeof hitPayload !== 'object' || Array.isArray(hitPayload)) {
            throw new UpstreamShapeError('gene→条目明细响应不是对象——上游契约可能已变', { url: hitPrepared.url });
          }
          const record = hitPayload as Record<string, unknown>;
          const matched = requireArrayField(record, 'genes', hitPrepared.url, 'gene→条目明细')
            .map((item) => str(item))
            .filter((item): item is string => Boolean(item));
          const koDetails = Array.isArray(record.ko_details) ? record.ko_details : [];
          geneHits.push({
            term_id: entry.id,
            term: entry.term || entry.name,
            genes: matched,
            ko_details: koDetails,
            request: hitPrepared.request,
          });
        } catch (error) {
          if (error instanceof UpstreamError || error instanceof InvalidArgumentError || error instanceof UpstreamShapeError) {
            geneHits.push({
              term_id: entry.id,
              term: entry.term || entry.name,
              genes: [],
              ko_details: [],
              request: null,
              error: error.message,
            });
          } else {
            throw error;
          }
        }
      }
    }

    const geneHitLines = geneHits.length > 0
      ? [
        '',
        `gene→${mode === 'go' ? 'GO' : 'KEGG'} 明细（上游 /api/${mode}/genes 逐条目回查送检基因；不改 p/BH 口径）：`,
        ...geneHits.map((hit) => {
          if (hit.error) return `- ${hit.term_id}（${hit.term || '-'}）：明细查询失败（${hit.error}）`;
          const headGenes = hit.genes.slice(0, 5).join(', ');
          const more = hit.genes.length > 5 ? ` 等 ${hit.genes.length} 个` : '';
          const ko = mode === 'kegg' && hit.ko_details.length > 0
            ? `；KO=${hit.ko_details.slice(0, 3).map((item) => {
              const record = item as Record<string, unknown>;
              return `${str(record.ko) ?? '?'}(${str(record.gene_id) ?? '?'})`;
            }).join('、')}`
            : '';
          return `- ${hit.term_id}（${hit.term || '-'}）：${hit.genes.length}/${genes.length} 个送检基因命中${headGenes ? `（${headGenes}${more}）` : ''}${ko}`;
        }),
      ]
      : [];

    const label = mode === 'go' ? 'GO 富集' : 'KEGG 通路富集';
    const head = (shown: number): string[] => [
      `${label}｜背景 N=${background}｜输入 ${genes.length} 个基因（上游 gene_count=${geneCount}，n=${n}）`,
      `显著条目（padj < ${threshold}）共 ${significant.length} 条（上游返回 ${results.length} 条）｜正文展示 ${shown} 条`,
      ...(genes.length > 20
        ? ['注：本次基因数 >20；上游实测 20 个/批 33–39 s（单次上限 45 s）。需要更大基因集时请拆成 ≤20 个/次分别调用，'
          + '跨批合并必须合并 k/n 后重算超几何 p 再 BH——**不许把各批 padj 拼起来**。']
        : []),
    ];
    const rows = significant.map((entry) => [
      entry.id,
      entry.term || entry.name || '-',
      entry.ontology || '-',
      `${num(entry.k, 0)}/${num(entry.K, 0)}`,
      num(entry.ratio, 2),
      scientific(entry.pvalue),
      scientific(entry.padj),
    ]);
    const geneHitBlock = geneHitLines.join('\n');
    const tableBudget = MAX_BODY_BYTES - 260 - Math.min(utf8Bytes(geneHitBlock), 700);
    const { body: table, shown } = fitTable(
      head,
      ['ID', '条目', 'ontology', 'k/K', 'ratio', 'pvalue', 'padj'],
      rows.slice(0, limit),
      url,
      Math.max(240, tableBudget),
      44,
    );
    const tail = shown < rows.length
      ? `\n（本次正文展示 ${shown} 条，另有 ${rows.length - shown} 条未展示；完整结果见 structuredContent）`
      : '';
    const enrichmentGeneration = sharedGeneration(genes);
    const zero = results.length === 0
      ? diagnoseZero({
        endpoint: `/api/${mode}`,
        generation: generationLabel(enrichmentGeneration),
        support: generationSupport(enrichmentGeneration, ['02'], ['03']),
        supportBasis: 'GO/KEGG 实测 02G（通常带 .1）有结果、03G 静默 0（#75 302/302）；01G 未测',
        status: res.status,
        durationMs: res.durationMs,
        bytes: responseBytes(res),
      })
      : undefined;
    const structured = {
      mode,
      N: background,
      n,
      gene_count: geneCount,
      threshold,
      timeout_ms: timeoutMs,
      total_results: results.length,
      significant: significant.length,
      shown,
      results: validated,
      gene_hits: geneHits,
      gene_hits_note: includeGeneHits
        ? 'gene_hits=逐条目回查送检基因的命中明细；上游富集表没有该字段，明细来自 /api/go/genes 或 /api/kegg/genes；p 值/BH 全部为上游原值'
        : '未请求；传 include_gene_hits=true 可回查「谁命中了哪个条目」',
      ...(zero ? { zero } : {}),
    };

    /**
     * 明细请求也是真请求：完整 URL 放得下就进出处，放不下就指向 structuredContent.gene_hits[].request。
     * 出处预算 2560 B 是硬上限，不静默丢证据。
     */
    const buildExtra = (kept: string[]): string => {
      const parts = [`total_results=${results.length}；significant=${significant.length}`];
      if (kept.length > 0) parts.push(`明细请求：${kept.join('；')}`);
      if (kept.length < geneHitRequests.length) {
        parts.push(`另有 ${geneHitRequests.length - kept.length} 个明细请求见 structuredContent.gene_hits[].request`);
      }
      return [manifest.versionNote, ...parts].filter(Boolean).join('；');
    };
    let keptRequests = geneHitRequests;
    let extra = buildExtra(keptRequests);
    const tailBytes = (text: string): number => utf8Bytes(provenance({
      sourceName: manifest.displayName,
      request: prepared.request,
      status: res.status,
      durationMs: res.durationMs,
      at: '9999-12-31T23:59:59.999Z',
      extra: text,
    }));
    while (keptRequests.length > 0 && tailBytes(extra) > MAX_TAIL_BYTES) {
      keptRequests = keptRequests.slice(0, -1);
      extra = buildExtra(keptRequests);
    }
    if (tailBytes(extra) > MAX_TAIL_BYTES) throw new InvalidArgumentError('富集出处证据超出 2560 字节上限（尚未联网）');

    if (zero) {
      return finishResult({
        body: `${label}｜背景 N=${background}｜输入 ${genes.length} 个基因（上游 gene_count=${geneCount}，n=${n}）\n`
          + `${renderZeroDiagnosis(zero)}\n`
          + '0 条结果不能解读为这些基因没有功能或通路注释；先按上面的「下一步」换代次复测。'
          + (includeGeneHits ? '\n（上游返回 0 条结果，故未做 gene→GO 明细回查）' : ''),
        res, prepared, sourceId: manifest.id, raw: res.data, structured, extra,
      });
    }

    if (significant.length === 0) {
      return finishResult({
        body: `${label}｜背景 N=${background}｜输入 ${genes.length} 个基因（上游 gene_count=${geneCount}，n=${n}）\n`
          + `本次没有 padj < ${threshold} 的显著条目（上游返回 ${results.length} 条）。`
          + '0 条显著只表示该阈值下无显著富集，不代表这些基因没有功能或通路注释。'
          + (includeGeneHits ? '\n（没有显著条目，故未做 gene→GO 明细回查）' : ''),
        res, prepared, sourceId: manifest.id, raw: res.data, structured, extra,
      });
    }
    return finishResult({
      body: `${table}${tail}${geneHitBlock}`,
      res, prepared, sourceId: manifest.id, raw: res.data, structured, extra,
    });
  },
};

export const tools: ToolDefinition[] = [
  searchKnownGenes,
  geneDetail,
  expressionProjects,
  expressionQuery,
  searchPapers,
  convertGeneIds,
  crossSpeciesHomologs,
  variantDatasets,
  variantQuery,
  syntenySearch,
  wheatPpi,
  wheatRegulatory,
  wheatEnrichment,
  geneAnnotation,
  geneSequence,
];