import type { SourceManifest } from '../../core/types.js';

/**
 * WheatOmics（山东农业大学，小麦多组学平台）
 *
 * 选择它做**样板源**的理由（2026-10-27 本机实测）：
 *   - 有完整的 OpenAPI 3.1（`/api/openapi.json`，93 个端点，全中文文档）→ 标准 T1；
 *   - 无鉴权、本机直连 200，不经代理 → 适合当第一个能跑通的例子；
 *   - 覆盖基因 / 表达 / 文献 / ID 转换，正好是聚合类工具最常被问到的四件事。
 */
export const manifest: SourceManifest = {
  id: 'wheatomics',
  displayName: '小麦多组学平台（WheatOmics）',
  homepage: 'https://wheatomics.sdau.edu.cn/',
  apiBase: 'https://wheatomics.sdau.edu.cn/api',
  // 显式声明能提供的研究服务（字典 key，不推断；宁可少列）
  services: ['gene', 'expression', 'variant', 'homology', 'sequence', 'id-convert'],
  tier: 'T1',
  docs: 'https://wheatomics.sdau.edu.cn/api/docs',
  auth: 'none',
  species: ['Triticum aestivum', 'Triticum turgidum', 'Aegilops tauschii'],
  network: 'direct',
  probe: { path: '/expression/projects', expectStatus: 200, expect: 'json' },
  lastProbe: {
    date: '2026-10-27',
    ok: true,
    status: 200,
    ms: 450,
    note:
      '当日 22:00 六个端点全部 200 并抓到 fixture；22:12 起 /api/* 全部 503'
      + '（静态首页仍 200，503 由 Apache 反向代理返回）；22:18 复查已恢复 200',
  },
  /**
   * 版本口径**如实标未知**。
   *
   * 对抗性审查 R06 指出：本仓内部对同一批 ID 的说法不一致——
   * 一处写"表达量基于 IWGSC v2.1（02G）"，另一处写"统一转 IWGSC v1.1（02G）"，
   * 而 fixture 里 `genome` 字段是 `Chinese_Spring1.0`、JBrowse 轨道写 `IWGSCv1.1_HC_LC`。
   * 组装版本、注释版本、站点内部映射表是三件事，**不能按 ID 外观互相推断**。
   * 本仓没有独立核验能力，所以只陈述上游返回了什么。
   */
  versionNote:
    '上游 genome 字段返回 Chinese_Spring1.0；02G/01G/03G 前缀映射由上游端点自行解释，'
    + '本仓未独立核验其对应的组装/注释版本号，引用前请回上游确认',
  caveats: [
    '平台自带 MCP server（GET /api/mcp/sse）—— 本插件不是它的替代品，价值在于把小麦和别的国内库并成同一套工具',
    '上游各端点对 01G/02G/03G 的"v1/v2/v3"叫法不一致；本仓按前缀识别，不替你判定注释版本',
    '表达值单位随项目而定且上游未逐点标注，跨项目不可直接比较大小',
    '已接入的信封类端点使用 {success, message, timestamp, data}；success=false 时 data 不可用，不外推其他端点',
    'Pfam/区间注释仅默认 Genefunc_CS_IWGSC03G_table，坐标为 Mb；offset/limit 是本地分页，不是上游分页；区间单次≤30 Mb（上游硬上限）',
    '序列可按 gene_id 单条分块、按 ≤50 个 gene_ids 批量（逐条容错，失败 ID 单列），或用 list_ids 列具体物种 BLAST 库的 ID；批量/列库的完整记录只在 include_records=true 时进 structuredContent；offset 不是基因组坐标',
    '批量序列上游是「整批一个 ID 缺失就全部 failed」；本仓会二分到单条隔离失败，但一次调用最多 200 次上游请求，且失败 ID 不会静默丢弃',
    '基因组目录的 gene_count 与注释表行数不一定相等（curated 统计 vs 表级 rows），本仓两个都原样给出，不替上游对齐',
    '共线 `/api/synteny/search` 的默认表 CSsymaptbl 按 IWGSC RefSeq v1.1（01G）编号索引：实测 02G 单基因（TraesCS1A02G013100）回 count=0，同区间返回的 01G（TraesCS1A01G018500LC）可查到；这是编号代次/表键问题，不是"必须用区间"',
    'PPI 两张表收录范围不同：PPI_poppin 是水稻网络转移（有 rice_pair/supporting_edges/identity），PPI_result 是 McWhite CF-MS 复合物图（输入需 .1 后缀）；本仓只对 PPI_poppin 拿到正例，0 条不等于没有互作',
    '调控 `/api/regulatory/gene/{id}` 只给汇总（motif 命中数/最小 p 值），不展开数百条命中；坐标字段是上游 0-based 命名',
    'GO/KEGG 富集是 POST 端点：GO 实测约 23.5–26.0 s / 12.6 KB，KEGG 约 0.5 s；本仓 GO 单次超时 45 s、不自动重试，正文只展示前 N 条',
  ],
};
