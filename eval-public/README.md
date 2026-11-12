# eval-public —— 公开的判分器与判据说明

> **本目录是"评测怎么判"的公开部分；题面与期望值不在公开仓。**

## 公开的范围

本目录只包含判分器与合成示例，不包含任何真实题面或期望值。
公开判分器是为了让人能复核：**判定是怎么算的**（哪些检查、什么算失败、边界怎么取）。

## 文件

| 文件 | 说明 |
|---|---|
| `scorer.mjs` | 公开判分器：判定逻辑与检查项可直接阅读 |
| `example/expect.json` | 示例期望：**不含任何真实题面或期望值** |
| `example/artifact.json` | 示例产物：合成数据（`demo_*`），不是真实源 |

`scorer.mjs` 是独立可运行的脚本，不依赖本仓其他模块。

## 怎么跑

```bash
# 用自己的产物与期望跑（期望由你提供，本仓不提供真实题面）
node eval-public/scorer.mjs <产物.json> --expect <期望.json> \
  [--expect-sha <sha256>] [--tasks-sha <sha256>] [--runner-sha <sha256>]

# 跑本目录自带的合成示例（不涉及任何真实题目）
node eval-public/scorer.mjs eval-public/example/artifact.json \
  --expect eval-public/example/expect.json \
  --tasks-sha EXAMPLE-TASKS-SHA-NOT-REAL \
  --runner-sha EXAMPLE-RUNNER-SHA-NOT-REAL
```

退出码：逐题有 FAIL → `1`；缺 `--expect` 或期望文件不存在 → `2`；instrument 身份不符 → `4`；全通过 → `0`。

## 三条边界（务必读）

1. **公开判分器不是官方成绩单**。它只用于复核判据逻辑。
2. **期望值由调用方提供**，所以 `--expect-sha` 不传时**不会校验期望哈希**（程序会明确打印这句提示）；
   要可复现，就传哈希。
3. **示例是合成数据**：`demo_seed_lookup` 等名字是编的，不对应任何真实源，也不代表任何真实评测结果。

## 与仓库的关系

`eval-public/` 是源码的一部分，会随本仓一起分发。
