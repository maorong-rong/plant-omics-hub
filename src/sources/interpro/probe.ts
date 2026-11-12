/**
 * InterPro 源级探活断言（`npm run probe` 调用）。
 *
 * 绑定 `manifest.probe.path`：`GET /api/entry/pfam/PF00319` 必须返回该条目的元数据，
 * 且 `metadata.accession` 与请求的 PF00319 逐字一致。只核验身份与基本结构，
 * 不断言条目描述、计数或版本（那些会随 InterPro 发布变化）。
 */
const REQUESTED_ACCESSION = 'PF00319';

export function validateProbe(payload: unknown): void {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new Error('InterPro probe: 期望顶层为对象（条目元数据是 {metadata: {...}}）');
  }
  const metadata = (payload as Record<string, unknown>).metadata;
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) {
    throw new Error('InterPro probe: 缺少 metadata 对象');
  }
  const entry = metadata as Record<string, unknown>;
  if (String(entry.accession) !== REQUESTED_ACCESSION) {
    throw new Error(`InterPro probe: 响应 accession=${String(entry.accession)} 与请求 ${REQUESTED_ACCESSION} 不一致`);
  }
  if (entry.source_database !== 'pfam') {
    throw new Error(`InterPro probe: source_database=${String(entry.source_database)}，期望 pfam`);
  }
  if (typeof entry.type !== 'string' || !entry.type.trim()) {
    throw new Error('InterPro probe: 条目 type 必须是非空字符串');
  }
}
