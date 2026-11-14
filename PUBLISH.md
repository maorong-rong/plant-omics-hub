# 发布快照说明

本仓由**私有开发仓导出**，不是手工维护的第二份源码。每次发布是把本地白名单树整体写成一次快照提交，
因此历史是连续快进的一条线，不做逐提交移植。

| 项 | 值 |
|---|---|
| 对应本地提交 | `bc3639af21ab28d17a2fb2327ef5414eecfe44c8` — chore(publish): 再排除 docs/capability 与 docs/species 过程盘点 |
| 导出时间 | 2026-11-14 09:27:00 UTC |
| 文件数 | 383 |
| 快照基线 | `78ea8b09a632d4c44c319221e73eeebabacf203b`（首个快照之后的提交都在此之上快进） |

## 导出范围

- 包含：源码（`src/`）、测试（`test/`）、脚本（`scripts/`）、文档（`README.md`、`CHANGELOG.md`、`CITATION.cff`、
  `docs/` 的公开部分）、评测判分器与说明（`eval-public/`，只含判分逻辑与示例，不含题面与期望值）、
  两个出口配置、市场素材（`market/`）、站点与 Web 应用（`site/`、`web/`）。
- 不含：团队内部分工（`docs/协作分工.md`）、内部任务看板（`docs/任务看板.md`，含内部卡点与 Bot 分工）、
  过程记录（`记录/`）、论文与评测私有产物（`论文/`、`eval/` 的题面与期望值）、
  `.archify/`、内部规则文件与工作区总览、运维物料（`deploy/`：内网拓扑、主机地址与部署手册）。
- 2026-11-14 起另不含：未发表研究与论文物料（`analysis/`、`explore/`、`docs/paper/`、`docs/figures/`、
  `docs/competitive/`、`docs/architecture/`、`docs/capability/`、`docs/species/`）、内部截图（`web/screenshots/`、`site/screenshots/`）
  与过程规划文档；公开仓是插件分发，不是研究记录镜像。

## 本次导出对内部链接的降级

公开仓不含私有仓的 `记录/`。本次导出把 40 处指向它的相对链接降级为纯文本
「（私有仓记录，未公开）」，因此下列段落的措辞与私有仓不同（其余内容一致）：

| 文件 | 行 | 原链接 |
|---|---|---|
| `CHANGELOG.md` | 25 | `[`docs/architecture/按需展开-2026-11-13/`](docs/architecture/按需展开-2026-11-13/)` |
| `PUBLISH.md` | 29 | `[实测记录](../记录/20261030-调研-WheatOmics-VariantHub实测.md)` |
| `PUBLISH.md` | 30 | `[实测记录](../记录/20261030-调研-EnsemblPlants拟南芥实测.md)` |
| `PUBLISH.md` | 31 | `[str 自检记录](../记录/20261101-自检-STR-01三条契约阻塞.md)` |
| `PUBLISH.md` | 32 | `[实测记录](../记录/20261031-调研-EBIExpressionAtlas契约前置.md)` |
| `PUBLISH.md` | 33 | `[实测记录](../记录/20261030-调研-EnsemblPlants拟南芥实测.md)` |
| `PUBLISH.md` | 34 | `[实测记录](../记录/20261030-调研-WheatOmics-VariantHub实测.md)` |
| `PUBLISH.md` | 35 | `[VariantHub 两工具契约](../记录/20261030-契约-WheatOmics-VariantHub两工具.md)` |
| `PUBLISH.md` | 36 | `[更正记录](../../../../记录/20261030-更正-Ensembl序列两次抓取内容不一致.md)` |
| `PUBLISH.md` | 37 | `[T2定级](../../../../记录/20261029-调研-SCOD甘蔗源T2定级证据.md)` |
| `PUBLISH.md` | 38 | `[分页上限](../../../../记录/20261029-调研-SCOD区间上限与匹配规则实测.md)` |
| `PUBLISH.md` | 39 | `[区间语义终局](../../../../记录/20261029-调研-SCOD区间语义终局-完全包含.md)` |
| `PUBLISH.md` | 40 | `[原始响应交接](../../../../记录/20261029-调研-SCOD原始响应交接清单.md)` |
| `README.md` | 321 | `[`docs/architecture/按需展开-2026-11-13/`](docs/architecture/按需展开-2026-11-13/)` |
| `docs/源登记表.md` | 90 | `[缺陷报告:70-84](../analysis/gene-family/缺陷报告-2026-11-10.md#L70-L84)` |
| `docs/源登记表.md` | 91 | `[缺陷报告:78-80](../analysis/gene-family/缺陷报告-2026-11-10.md#L78-L80)` |
| `docs/源登记表.md` | 91 | `[缺陷报告:180-181](../analysis/gene-family/缺陷报告-2026-11-10.md#L180-L181)` |
| `docs/源登记表.md` | 94 | `[缺陷报告:101](../analysis/gene-family/缺陷报告-2026-11-10.md#L101)` |
| `docs/源登记表.md` | 96 | `[PANELS-6-11:179-180](../analysis/wheat-mads/PANELS-6-11.md#L179-L180)` |
| `docs/源登记表.md` | 97 | `[wheat-mads README:346-360](../analysis/wheat-mads/README.md#L346-L360)` |
| `docs/源登记表.md` | 98 | `[synteny.generation_check.json](../analysis/wheat-mads/results/synteny.generation_check.json)` |
| `docs/源登记表.md` | 101 | `[PANELS-6-11:168-180](../analysis/wheat-mads/PANELS-6-11.md#L168-L180)` |
| `docs/源登记表.md` | 101 | `[ppi.summary.json](../analysis/wheat-mads/results/ppi.summary.json)` |
| `docs/源登记表.md` | 102 | `[PANELS-6-11:193-206](../analysis/wheat-mads/PANELS-6-11.md#L193-L206)` |
| `docs/源登记表.md` | 102 | `[PANELS-6-11:206](../analysis/wheat-mads/PANELS-6-11.md#L206)` |
| `docs/源登记表.md` | 102 | `[wheat-mads README:436](../analysis/wheat-mads/README.md#L436)` |
| `docs/源登记表.md` | 103 | `[PANELS-6-11:218-231](../analysis/wheat-mads/PANELS-6-11.md#L218-L231)` |
| `docs/源登记表.md` | 103 | `[go.generation_check.json](../analysis/wheat-mads/results/go.generation_check.json)` |
| `docs/源登记表.md` | 106 | `[PANELS-6-11:172-180](../analysis/wheat-mads/PANELS-6-11.md#L172-L180)` |
| `docs/源登记表.md` | 120 | `[synteny.generation_check.json](../analysis/wheat-mads/results/synteny.generation_check.json)` |
| `docs/源登记表.md` | 126 | `[PANELS-6-11:218-231](../analysis/wheat-mads/PANELS-6-11.md#L218-L231)` |
| `docs/源登记表.md` | 130 | `[wheat-mads README:356-357](../analysis/wheat-mads/README.md#L356-L357)` |
| `docs/源登记表.md` | 138 | `[wheat-mads README:318-320](../analysis/wheat-mads/README.md#L318-L320)` |
| `docs/源登记表.md` | 138 | `[structure.coverage.tsv](../analysis/wheat-mads/results/structure.coverage.tsv)` |
| `docs/源登记表.md` | 138 | `[family.members.tsv](../analysis/wheat-mads/results/family.members.tsv)` |
| `docs/源登记表.md` | 139 | `[缺陷报告:70-84](../analysis/gene-family/缺陷报告-2026-11-10.md#L70-L84)` |
| `docs/源登记表.md` | 140 | `[wheat-mads README:81](../analysis/wheat-mads/README.md#L81)` |
| `docs/源登记表.md` | 140 | `[:198](../analysis/wheat-mads/README.md#L198)` |
| `docs/源登记表.md` | 140 | `[:211](../analysis/wheat-mads/README.md#L211)` |
| `docs/源登记表.md` | 141 | `[缺陷报告:45](../analysis/gene-family/缺陷报告-2026-11-10.md#L45)` |

## 注意

- 本仓的提交历史与私有仓**没有共同祖先**；比对内容请以时间点对应的快照提交为准，不要指望 `git log` 互通。
- 发布前会跑敏感审查（私钥、token、个人路径、内部主机、失效内部链接）；命中即不导出。
