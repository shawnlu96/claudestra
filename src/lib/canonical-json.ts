/** 协议共用的规范 JSON（授权绑定哈希、共享台账摘要与签名原文都用它）。纯函数、只依赖语言本身，tests/cloud-protocol-core-*.test.ts。 */

/** 键排好序的 JSON：同样的参数不管 agent 按什么顺序写，哈希都一样 */
export function canonicalJson(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(",")}]`;
  if (v && typeof v === "object") {
    const o = v as Record<string, unknown>;
    return `{${Object.keys(o).sort().filter((k) => o[k] !== undefined).map((k) => `${JSON.stringify(k)}:${canonicalJson(o[k])}`).join(",")}}`;
  }
  return JSON.stringify(v ?? null);
}
