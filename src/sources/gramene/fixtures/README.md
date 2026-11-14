# Gramene fixtures（真实快照 + 400 错误证据）

采集：2026-10-28（UTC 时刻见各文件 `capture.at`；本机 Windows 直连，未开代理），`curl.exe` 串行、间隔约 400 ms，未鉴权、未重试。
API base：`https://data.gramene.org/v69`；文档 `https://data.gramene.org/v69/swagger`（Swagger 2.0，basePath `/v69`）。

结构快照 `genes-structure*.json` 于 2026-11-10 补采（同一 API base、直连、未鉴权），用于 `gramene_gene` 的 `include_structure`。

零值诊断的两份件（`genes-msu-zero.json` / `genes-rapdb-osmads1.json`）于 2026-11-11 补采（同一 API base、直连、未鉴权、未重试），用于 issue #94 / RC-04：前者是 3 个 MSU `LOC_Os…` 的真实空数组，后者是同一基因在 RAP-DB 空间的阳性对照。

只有 `genes.json`、两个 `genes-structure*.json` 与 `genes-rapdb-osmads1.json` 做了裁剪，其余正例与负例都是原样保存。

| 文件 | 请求 | 观测 |
|---|---|---|
| [genes.json](genes.json) | `GET /genes?idList=BGIOSGA001967` | 200 / 8,520 B；**数组**，单条基因文档。裁剪：删除 `xrefs`（外部交叉引用，占响应主体）与 `gene_idx`；`_id/name/description/biotype/taxon_id/system_name/db_type/location` 原样保留 |
| [genes-structure.json](genes-structure.json) | `GET /genes?idList=Os01g0100100&idList=Os01g0100100` | 200 / 6,975 B；水稻：`gene_structure.exons` **12 条**（`1–286` … `7522–7833`），`translation.features.domain` 3 条（含 `PF00566` **389–535**），另有 `homologous_superfamily` 2 条。裁剪：只保留 `_id/name/description/biotype/taxon_id/system_name/db_type/location/gene_structure` |
| [genes-structure-wheat.json](genes-structure-wheat.json) | `GET /genes?idList=TraesCS1A03G0032400&idList=TraesCS1A03G0032400` | 200 / 2,603 B；小麦：`gene_structure.exons` **1 条**（`1–570`，570 bp），`translation.features.domain` 6 条（含 `PF00319` **21–68**），另有 `homologous_superfamily` 2 条。裁剪同水稻 |
| [genes-empty.json](genes-empty.json) | `GET /genes?idList=NOT_A_REAL_ID` | 200 / 5 B；正文 `[\n\n]`，**空数组**就是查无形态，不是 404 |
| [genes-msu-zero.json](genes-msu-zero.json) | `GET /genes?idList=LOC_Os03g11614&idList=LOC_Os01g66030&idList=LOC_Os01g10504` | 200 / 5 B；3 个 MSU `LOC_Os…` 一次查询仍是空数组。只证明「本次未返回」，不证明这些 ID 在别的空间没有记录 |
| [genes-rapdb-osmads1.json](genes-rapdb-osmads1.json) | `GET /genes?idList=Os03g0215400&idList=Os03g0215400` | 200 / 23,316 B；阳性对照：OsMADS1/LHS1 的 RAP-DB ID，返回 1 条记录（8 个外显子）。裁剪：删除 `xrefs` 与 `gene_idx`，其余字段原样保留。同一基因的 MSU `LOC_Os03g11614` 在 `genes-msu-zero.json` 回 0 条，证明「回 0」是 ID 空间不认，不是物种里没这个基因 |
| [expression.json](expression.json) | `GET /expression?idList=BGIOSGA001967` | 200 / 1,405 B；数组，单条记录按 `E-*` 实验给出 `[{group,p_value,l2fc}]`。原样保留 |
| [expression-empty.json](expression-empty.json) | `GET /expression?idList=NOT_A_REAL_ID` | 200 / 5 B；空数组 |
| [taxonomy.json](taxonomy.json) | `GET /taxonomy?idList=39946001&idList=4530` | 200 / 790 B；两条分类单元文档（`_id`、`name`、`rank`、`num_genes`、`ancestors` 为 taxid 链） |
| [taxonomy-dup-single.json](taxonomy-dup-single.json) | `GET /taxonomy?idList=4530&idList=4530` | 200 / 375 B；**只有 1 条文档**。这说明"数值型单 ID 重复一次发送"的规避写法输出正确，不是伪造数据 |
| [taxonomy-single-numeric-error.json](taxonomy-single-numeric-error.json) | `GET /taxonomy?idList=4530` | **400** / 420 B；`Expected type array but found type integer`。这是上游校验器行为，本仓据此对单值数字重复一次发送 |
| [search.json](search.json) | `GET /search?q=Oryza&rows=2` | 200 / 1,759 B；**content-type 是 `text/plain`，正文才是 JSON**。Solr 风格 `responseHeader/response{numFound:87462,docs[]}` |
| [search-empty.json](search-empty.json) | `GET /search?q=NOT_A_REAL_THING_XYZ&rows=2` | 200 / 432 B；`numFound:0`、`docs:[]`，仍是 text/plain |

## 这些 fixture 不能证明什么

- **覆盖**：只实测 `Oryza sativa`（taxid 4530）与 `Oryza sativa Indica Group`（39946001），**未逐物种采样**，不能推广成“覆盖禾本科”。
- `numFound=87462` 是那一次 `q=Oryza` 的上游命中数，不是工具展示数。
- `expression` 的 `p_value`/`l2fc` 是上游原值；fixture 不含实验条件名称与样本量，工具也不做显著性判定。
- `taxonomy` 的 `ancestors` 只是 taxid 链，没有名称。
- **外显子 `start/end` 是相对基因模型起点的坐标（第一条 exon 从 1 开始），不是染色体坐标**；染色体区间见同一文档的 `location`。功能域的 `start/end` 是翻译（aa）坐标，不是核苷酸坐标。
- 400 那条只证明“数值型单值会被拒绝”，不证明其他错误形态。

## 隐私

Gramene 响应未见个人字段（基因描述里可能出现数据库 accession，不是联系方式）。工具仍统一做“整行邮箱扫描 + raw 投影扫描”。

**复查（2026-10-28）**：对本目录全部非 `simulated` 真实件递归扫描邮箱模式 → **0 命中**；测试内有自动断言。
