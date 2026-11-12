#!/usr/bin/env node
/**
 * 工具级上游实测（probe-tools）。
 *
 * 与 `scripts/probe.mjs` 的分工（别混）：
 *   - `probe.mjs` 是**源级**探活：一个源打 1 个探活请求，回答"这个源还活着吗"。
 *   - 本脚本是**工具级**：把某个源的**每一个**工具都真打一次上游，回答"模型真能调用它吗"。
 *     源级 200 不能顶替工具级——端点、参数、响应形态各自会变，源活着而某个工具挂了是常态。
 *
 * 为什么要有：`npm test` 全离线（fixture 回放），只证明"我们按抓下来的形状能解析"。
 * 上游今天是否还接受这组参数、返回是否仍被解析器接住，只有真打才知道（AGENTS §四）。
 *
 * 口径（每个工具一行证据）：
 *   完整请求（含参数） / HTTP 状态 / 耗时 / 解析器是否接住 / 结论（OK / FAIL(原因)）。
 *   **失败如实记失败**：不重试到绿、不改 fixture、不降断言。工具抛错就是失败。
 *   `meta` 取自 `ToolResult.meta`（工具自己写的出处四要素），不是脚本另算的。
 *   `upstreamCalls` 记录**每次 HTTP 调用**（一个工具可能发多次，如 ensemblplants 的 sequence/xrefs），
 *   含 `attempts`（共享层重试后的真实尝试次数），用来算"首次尝试成功率"——
 *   失败过的请求即使最终成功，也不能算成首次成功。
 *
 * 用法：
 *   npm run build
 *   node scripts/probe-tools.mjs --source wheatomics
 *   node scripts/probe-tools.mjs --all --json <目录>/tool-coverage.json
 *   node scripts/probe-tools.mjs --all --delay 1500     # 每次工具调用之间更保守
 *
 * 退出码：任一工具失败 → 1（AGENTS §五：断言失败必须非零退出）。
 * 产物：默认只打印；`--json` 才落盘，且默认目录是系统临时目录（本机实测件不入库）。
 */

import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const distBase = pathToFileURL(join(resolve(here, '..'), 'dist') + '/').href;

const argv = process.argv.slice(2);
const getArg = (name) => {
  const i = argv.indexOf(name);
  return i > -1 ? argv[i + 1] : undefined;
};
const hasFlag = (name) => argv.includes(name);
const runAll = hasFlag('--all');
const source = getArg('--source');
if (!runAll && !source) {
  console.error('缺少 --source（如 --source wheatomics）或 --all（10 源全部工具）。本脚本默认只测一个源，避免一次打太多上游。');
  process.exit(2);
}
if (runAll && source) {
  console.error('--source 与 --all 只能二选一。');
  process.exit(2);
}
const delayMs = Math.max(0, Number(getArg('--delay') ?? 1_000) || 0);

/**
 * 每个工具一组**真实**参数。
 *
 * 哈希里缺一个工具就报错退出，不静默跳过：新加工具必须同时在这里给参数，
 * 否则"逐个实测"会悄悄退化成"实测了一部分"。参数来源写在该条的注释里。
 */
const CALLS = {
  wheatomics: {
    // 登记表：searchid VRN1 为文档示例
    wheatomics_search_known_genes: { searchid: 'VRN1', limit: 5 },
    // 工具描述里的示例 ID（IWGSC RefSeq v2.1 命名）
    wheatomics_gene_detail: { gene_id: 'TraesCS5A02G391700' },
    // 无必填；不传 keyword，取全量目录（上游约 6.7 KB）
    wheatomics_expression_projects: {},
    // project 取自 expression_projects 的 project 列（登记表记录 PRJEB5314_paired_tbl）
    wheatomics_expression_query: { gene_ids: 'TraesCS5A02G391700', project: 'PRJEB5314_paired_tbl', top: 3 },
    // 登记表：papers 关键词 vernalization 有命中
    wheatomics_search_papers: { q: 'vernalization', limit: 3 },
    // 登记表：转换需 .1 后缀 + gene_version 表名
    wheatomics_convert_gene_ids: { ids: 'TraesCS6B01G342500.1', gene_version: 'MIPS_result' },
    // 工具描述：不做格式猜测，只接受单个 ID
    wheatomics_cross_species_homologs: { gene_id: 'TraesCS5A02G391700', max_targets: 2 },
    // 目录工具：不传 keyword 取全量（上游 6,675 B / 29 数据集）
    wheatomics_variant_datasets: {},
    // 登记表实测：dataset=whealbi_minocc10 + chr1A:1-200000 可用；limit 取小值少拉体积
    wheatomics_variant_query: { dataset: 'whealbi_minocc10', region: 'chr1A:1-200000', limit: 5 },
    // 登记表：functions/pfam 正例 PF00319（SBP 结构域）
    wheatomics_gene_annotation: { pfam_id: 'PF00319', limit: 3 },
    // 按基因取序列：默认 gene（碱基），本地裁 200 碱基
    wheatomics_sequence: { gene_id: 'TraesCS5A02G391700', sequence_type: 'gene', offset: 1, length: 200 },
    // G4：E07 实测区间 chr1A:8000000-9000000 回 count=40
    wheatomics_synteny: { region: 'chr1A:8000000-9000000', limit: 5 },
    // G6：E10 实测 2 个基因 + PPI_poppin 回 87 条边 / 24,023 B
    wheatomics_ppi: { gene_ids: 'TraesCS1A02G013100,TraesCS5A02G391700', table: 'PPI_poppin', limit: 5 },
    // G6：E10 实测 regulatory/gene 回 798 motif hits / 355 motifs
    wheatomics_regulatory: { gene_id: 'TraesCS1A02G013100' },
    // G7：E11 实测 4 个 02G 基因 POST /api/go 回 63 条（23.5 s）
    wheatomics_enrichment: { mode: 'go', genes: ['TraesCS1A02G045300.1', 'TraesCS1A02G104700.1', 'TraesCS1A02G118400.1', 'TraesCS1A02G013100.1'], limit: 5 },
  },
  strawberry: {
    // 无必填：目录全量（上游约 98 KB，工具侧按预算裁剪）
    strawberry_catalog: {},
    // fixtures/README：/genes/search?geneId=BCIN_01g00010（Botrytis cinerea 实测正例）
    strawberry_gene_lookup: { geneId: 'BCIN_01g00010' },
    // fixtures/README：/transcriptome/search?geneId=FvesChr1G00279070.1
    strawberry_expression: { geneId: 'FvesChr1G00279070.1', top: 3 },
    // fixtures/README：sourceAssembly=fxa_benihoppe & geneId=Fxa1Ag00001 & targetAssembly=fxa_camarosa
    strawberry_synteny: { geneId: 'Fxa1Ag00001', sourceAssembly: 'fxa_benihoppe', targetAssembly: 'fxa_camarosa', maxBlocks: 2 },
    // fixtures/README：/tf/search?family=ERF&page=1&pageSize=2（工具要求至少一个筛选）
    strawberry_tf_members: { family: 'ERF', page: 1, pageSize: 2 },
  },
  gwh: {
    // fixtures/README：/assembly/GWHAAAA00000000（真实正例，含项目/样本 accession）
    gwh_assembly_lookup: { entity: 'assembly', id: 'GWHAAAA00000000' },
    // fixtures/README：/bioProject/PRJCA000437（真实正例）
    gwh_project_sample_lookup: { entity: 'project', id: 'PRJCA000437' },
  },
  icg: {
    // fixtures/README：/api/json/species/ICG00115（玉米，真实正例）
    icg_lookup: { entity: 'species', id: 'ICG00115' },
    // fixtures/README：/rest/species/category/?draw=1&start=0&length=3（上游 recordsTotal=540）
    icg_species_list: { offset: 0, limit: 5 },
  },
  ic4r: {
    // fixtures/README：/gene/IC4R-OSJ01G000600
    ic4r_gene: { locus: 'IC4R-OSJ01G000600' },
    // fixtures/README：/annotation/IC4R-OSJ01G000600（数组）
    ic4r_annotation: { locus: 'IC4R-OSJ01G000600' },
    // fixtures/README：/circRNA/IC4R-OSJ01Circ057100
    ic4r_circrna: { accession: 'IC4R-OSJ01Circ057100' },
    // fixtures/README：/lncRNA/IC4R-OSJ01Lnc000600.1
    ic4r_lncrna: { accession: 'IC4R-OSJ01Lnc000600.1' },
    // fixtures/README：/idConversion/IC4R-OSJ01G000600
    ic4r_id_convert: { locus: 'IC4R-OSJ01G000600' },
    // fixtures/README：/genes/view?chromosome=1&draw=1&start=0&length=2
    ic4r_gene_list: { chromosome: '1', start: 0, length: 2 },
    // 官方整文件（GFF 9.8 MB）：正文应含 56,221 gene / 444,847 exon / 80,038 mRNA；首次下载，第二次走缓存
    ic4r_bulk_download: { dataset: 'gff' },
  },
  gramene: {
    // fixtures/README：/search?q=Oryza&rows=2（numFound=87462）
    gramene_search: { q: 'Oryza', rows: 2 },
    // fixtures/README：/genes?idList=BGIOSGA001967
    gramene_gene: { ids: 'BGIOSGA001967' },
    // fixtures/README：/expression?idList=BGIOSGA001967
    gramene_expression: { ids: 'BGIOSGA001967' },
    // fixtures/README：/taxonomy?idList=4530（单值数字由工具重复一次发送）
    gramene_taxonomy: { ids: '4530' },
  },
  scod: {
    // fixtures/README：/genome/list?term=（裸数组 14 条）
    scod_genome_list: {},
    // fixtures/README：/gene/gene_list?genomeId=1&chrom=Chr1A&posStart=100000&posEnd=200000
    scod_gene_region: { genome_id: 1, chrom: 'Chr1A', pos_start: 100000, pos_end: 200000, start: 0, length: 2 },
  },
  ensemblplants: {
    // 登记表/fixtures：拟南芥 AT1G65480（FT）lookup 正例
    ensemblplants_lookup_gene: { species: 'arabidopsis_thaliana', id: 'AT1G65480' },
    // fixtures：sequence/id 蛋白序列（先 lookup 再取序列，两次请求）
    ensemblplants_sequence: { species: 'arabidopsis_thaliana', id: 'AT1G65480', type: 'protein' },
    // fixtures：xrefs（先 lookup 再取 xrefs，两次请求；9 条映射）
    ensemblplants_xrefs: { species: 'arabidopsis_thaliana', id: 'AT1G65480' },
    // G5：E17 实测水稻 Os01g0100100 → 拟南芥 2 条（上游 643,943 B / 27.6 s）
    ensemblplants_homology: { species: 'oryza_sativa', id: 'Os01g0100100' },
  },
  string: {
    // 登记表/工具描述：3702 + AT1G65480 → 3702.Q9SXZ2
    string_resolve_ids: { species: 3702, identifier: 'AT1G65480' },
    // fixtures：partners-pos.json；stringId 用 resolve 的实测回显
    string_interaction_partners: { species: 3702, string_id: '3702.Q9SXZ2', limit: 5, required_score: 400 },
  },
  uniprot: {
    // 登记表：probe 用 accession:P46290；这里用拟南芥 FT（reviewed_only 收窄命中）
    uniprot_search_proteins: { organism_id: 3702, gene: 'FT', size: 3, reviewed_only: true },
    // fixtures：entry-pos.json（Q9SXZ2）
    uniprot_get_entry: { accession: 'Q9SXZ2' },
  },
};

const requested = runAll ? Object.keys(CALLS) : [source];
for (const id of requested) {
  if (!CALLS[id]) {
    console.error(`--source ${id} 没有登记参数。在 scripts/probe-tools.mjs 的 CALLS 里补，不许瞎猜参数。`);
    process.exit(2);
  }
}

const { registry } = await import(distBase + 'sources/index.js');
const { invokeTool } = await import(distBase + 'core/invoke.js');
const { fetchJson } = await import(distBase + 'core/http.js');

let gitHead = null;
try {
  gitHead = execFileSync('git', ['-C', resolve(here, '..'), 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
} catch {
  /* 非 git 环境不阻断实测 */
}

const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

/** 失败分类：只用本仓自己的错误类型与文案，不把上游可控正文写进结论。 */
function verdictOf(error) {
  const message = error instanceof Error ? error.message : String(error);
  if (error?.name === 'InvalidArgumentError') return `FAIL(本地参数被拒：${message})`;
  if (error?.name === 'UpstreamShapeError') return `FAIL(业务信封/结构失败：${message})`;
  if (error?.name === 'UpstreamError') return `FAIL(上游失败：${message})`;
  return `FAIL(${message})`;
}

/**
 * 包一层 fetcher 只做**观测**：不改请求、不改响应、不改重试语义。
 * `attempts` 是共享层重试后的真实尝试次数；首次尝试成功 = attempts===1 且没有抛错。
 */
function observingFetch(calls) {
  return async (url, opts) => {
    try {
      const res = await fetchJson(url, opts);
      calls.push({ url, status: res.status, attempts: res.attempts, durationMs: res.durationMs });
      return res;
    } catch (error) {
      calls.push({
        url,
        status: error?.meta?.status ?? null,
        attempts: error?.meta?.attempts ?? null,
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  };
}

async function probeSource(id) {
  const plan = CALLS[id];
  const tools = registry.listTools().filter((tool) => tool.name.startsWith(`${id}_`));
  if (tools.length === 0) {
    console.error(`注册表里没有 ${id}_* 工具（源未启用？检查 PLANTOMICS_SOURCES）`);
    process.exit(2);
  }

  const missing = tools.map((tool) => tool.name).filter((name) => !plan[name]);
  const extra = Object.keys(plan).filter((name) => !tools.some((tool) => tool.name === name));
  if (missing.length > 0 || extra.length > 0) {
    if (missing.length > 0) console.error(`未给参数的工具：${missing.join(', ')}`);
    if (extra.length > 0) console.error(`参数表里多出注册表没有的工具：${extra.join(', ')}`);
    process.exit(2);
  }

  const rows = [];
  for (const tool of tools) {
    if (rows.length > 0 && delayMs > 0) await sleep(delayMs);
    const args = plan[tool.name];
    const calls = [];
    const startedAt = Date.now();
    try {
      const result = await invokeTool(tool, args, { http: observingFetch(calls) });
      rows.push({
        source: id,
        tool: tool.name,
        args,
        ok: true,
        verdict: 'OK',
        request: result.meta.request,
        status: result.meta.status,
        durationMs: result.meta.durationMs,
        wallMs: Date.now() - startedAt,
        textBytes: Buffer.byteLength(result.text, 'utf8'),
        at: result.meta.at,
        textHead: (result.text.split('\n')[0] ?? '').slice(0, 200),
        upstreamCalls: calls,
      });
      console.log(`✅ ${tool.name}  HTTP ${result.meta.status}  ${result.meta.durationMs} ms  ${Buffer.byteLength(result.text, 'utf8')} B`);
      console.log(`   ${result.meta.request}`);
    } catch (error) {
      const verdict = verdictOf(error);
      rows.push({
        source: id,
        tool: tool.name,
        args,
        ok: false,
        verdict,
        request: error?.meta?.request ?? null,
        status: error?.meta?.status ?? null,
        durationMs: error?.meta?.durationMs ?? null,
        wallMs: Date.now() - startedAt,
        error: {
          name: error?.name ?? 'Error',
          message: error instanceof Error ? error.message : String(error),
          attempts: error?.meta?.attempts ?? null,
          retryAfter: error?.meta?.retryAfter ?? null,
        },
        upstreamCalls: calls,
      });
      console.log(`❌ ${tool.name}  ${Date.now() - startedAt} ms  ${verdict}`);
    }
  }

  const failed = rows.filter((row) => !row.ok);
  const observed = rows.flatMap((row) => row.upstreamCalls);
  const firstAttemptOk = observed.filter((call) => call.attempts === 1 && !call.error).length;
  return {
    source: id,
    total: rows.length,
    ok: rows.length - failed.length,
    failed: failed.map((row) => row.tool),
    firstAttempt: { httpCalls: observed.length, firstAttemptOk, rate: observed.length ? firstAttemptOk / observed.length : null },
    rows,
  };
}

const summaries = [];
for (const [index, id] of requested.entries()) {
  if (index > 0 && delayMs > 0) await sleep(delayMs * 2);
  console.log(`\n=== ${id} ===`);
  summaries.push(await probeSource(id));
}

const allRows = summaries.flatMap((item) => item.rows);
const failed = allRows.filter((row) => !row.ok);
const observed = allRows.flatMap((row) => row.upstreamCalls);
const firstAttemptOk = observed.filter((call) => call.attempts === 1 && !call.error).length;
const summary = {
  script: 'probe-tools',
  measured: true,
  notUnitTest: true,
  mode: runAll ? 'all' : 'source',
  sources: summaries,
  gitHead,
  at: new Date().toISOString(),
  node: process.version,
  total: allRows.length,
  ok: allRows.length - failed.length,
  failed: failed.map((row) => row.tool),
  firstAttempt: { httpCalls: observed.length, firstAttemptOk, rate: observed.length ? firstAttemptOk / observed.length : null },
};

for (const item of summaries) {
  console.log(`\n${item.source}：${item.ok}/${item.total} 个工具真打上游成功${item.failed.length ? `，失败：${item.failed.join(', ')}` : ''}`);
}
console.log(`\n总计：${summary.ok}/${summary.total} 个工具真打上游成功；HTTP 调用 ${observed.length} 次，其中首次尝试即成功 ${firstAttemptOk} 次。`);

const outJson = getArg('--json');
if (outJson) {
  const name = runAll ? 'probe-tools-all' : `probe-tools-${requested[0]}`;
  const outPath = outJson === 'true' ? join(tmpdir(), `${name}-${Date.now()}.json`) : outJson;
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, `${JSON.stringify(summary, null, 2)}\n`, 'utf8');
  console.log(`\nJSON: ${outPath}`);
}

process.exit(failed.length === 0 ? 0 : 1);
