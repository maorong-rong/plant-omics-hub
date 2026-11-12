import type { SourceManifest } from '../../core/types.js';

/**
 * InterPro / Pfam（EMBL-EBI）—— **参考数据集源（第 11 源）**。
 *
 * 定位：这个源提供的是「尺子」而不是「研究对象」——Pfam/InterPro 的 HMM 域模型用来
 * 在本地 HMMER 里鉴定基因家族成员，本身不描述任何一个物种的组学数据。所以
 * `species` 故意留空：它不按物种覆盖，也不能被 `hub_find_sources` 当成物种源召回。
 *
 * 为什么必须新增源（参考数据集出口）：A 套的 4 个输入里，Pfam HMM 只能绕过
 * 中间层直连 `https://www.ebi.ac.uk/interpro/wwwapi/entry/pfam/...`。把这条也接进
 * 同一层，「所有输入都走中间层」这句话才成立。
 *
 * 版本口径：`interpro-version` 响应头（2026-11-10 实测 `111.0`）。版本号不硬编码进
 * manifest，每次调用从响应头读取；读不到就写未知并标注，不按 Pfam 编号外观猜。
 */
export const manifest: SourceManifest = {
  id: 'interpro',
  displayName: '蛋白域模型库（InterPro/Pfam）',
  homepage: 'https://www.ebi.ac.uk/interpro/',
  apiBase: 'https://www.ebi.ac.uk/interpro',
  // 参考数据集：只提供域模型，不提供物种组学数据。`domain` 是 2026-11-10 为本源新增的
  // 服务字典 key（见 src/core/catalog-services.ts 与 docs/catalog契约.md §三.1）。
  services: ['domain'],
  tier: 'T1',
  docs: 'https://www.ebi.ac.uk/interpro/api/',
  auth: 'none',
  // 参考数据集不按物种覆盖；留空是事实，不是漏填。
  species: [],
  network: 'direct',
  probe: {
    // 探活用条目元数据端点（JSON、体积小），不用 HMM 本身（application/gzip 二进制）。
    path: '/api/entry/pfam/PF00319',
    expectStatus: 200,
    expect: 'json',
  },
  lastProbe: {
    date: '2026-11-10',
    ok: true,
    status: 200,
    ms: 1261,
    note:
      '2026-11-10 本机实测（probe --attempts 1）：`/api/entry/pfam/PF00319` 200 / 852 B JSON / 1,261 ms（metadata.accession=PF00319）；'
      + 'HMM 出口 `/wwwapi/entry/pfam/PF00319/?annotation=hmm` 200 / 5,562 B gzip'
      + '（解压 23,553 B，md5 19621ce1a6c9222d748f60b6e8ff5e37）；版本号取自 `HEAD /api/` 响应头 `interpro-version: 111.0`'
      + '（HMM 端点本身不带该头，2026-11-10 实测）',
  },
  versionNote:
    'InterPro 版本取 `HEAD /api/` 的响应头 `interpro-version`（2026-11-10 实测 111.0，另有 `interpro-version-minor`；'
    + 'HMM 端点不带该头，所以下载成功后单独读一次版本）；'
    + 'Pfam 条目版本取 HMM 正文的 `ACC PF00319.25`。本仓不把版本写死在代码里，读不到就写未知',
  caveats: [
    '**参考数据集，不是物种源**：只提供 Pfam/InterPro HMM 域模型，不返回任何物种的基因、表达或变异数据；'
      + '不按物种查询，也不计入「植物组学数据库」的物种覆盖',
    '**一个工具只取一条 HMM**：上游 `wwwapi` 没有批量 HMM 打包出口（要逐 accession 取）；'
      + '做基因家族鉴定时按家族涉及的每个 Pfam 编号各调一次',
    '**上游返回的是 gzip 二进制**（`content-type: application/gzip`），不是文本；本工具解压后返回'
      + '正文 md5，正文本身放 `structuredContent.hmm`（几十 KB 进不了 1,408 B 正文预算）',
    '**版本请求只能命中当前版本**：`wwwapi` 不提供历史版本归档，请求 `PF00319.25` 时若上游当前已是'
      + '更高版本会明确报错，不会把新版本冒充成旧版本',
    '**md5 基线只对 PF00319 有历史实测值**（A 套 #70：`19621ce1a6c9222d748f60b6e8ff5e37`）；'
      + '其他 accession 只做传输与 HMM 结构校验，不声称与某次历史运行逐字节相同',
  ],
};
