/**
 * E2E 的字节编码（docs/relay/e2e-design.md §4.1.1）：`‖` 拼接的每一项都编成「u16 大端长度 + 字节」，标签字符串也一样；
 * 定长字段（nonce、AAD 里的 sid / dir / rid / i / final）不走这条。本目录只用 Uint8Array 与 WebCrypto，
 * 因为 P2 要把它原样搬到 web/lib/e2e 登记成 twin——这里引 node:crypto / Buffer 就搬不过去了。
 * 测试向量在 tests/fixtures/e2e-vectors.json。
 */
export type Bytes = Uint8Array<ArrayBuffer>;

export const utf8 = (s: string): Bytes => new TextEncoder().encode(s);

/** 单字节字段可以直接写成 [dir]、[final ? 1 : 0] */
export function concat(...parts: (Uint8Array | readonly number[])[]): Bytes {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

/** 长度前缀拼接：每项「u16 大端长度 + 字节」；单项超过 65535 字节是调用方的错，直接抛 */
export function lp(...items: (Uint8Array | string)[]): Bytes {
  const parts: Uint8Array[] = [];
  for (const it of items) {
    const b = typeof it === "string" ? utf8(it) : it;
    if (b.length > 0xffff) throw new RangeError(`lp item too long: ${b.length}`);
    parts.push(new Uint8Array([b.length >> 8, b.length & 0xff]), b);
  }
  return concat(...parts);
}

/** 无符号大端定长整数；放不下就抛——rid < 2^56、i < 2^32 这些上限靠它兜住，不会悄悄截断成重复的 nonce */
export function uintBE(v: bigint | number, n: number): Bytes {
  let x = BigInt(v);
  if (x < 0n || x >= 1n << BigInt(8 * n)) throw new RangeError(`${v} does not fit in ${n} bytes`);
  const out = new Uint8Array(n);
  for (let k = n - 1; k >= 0; k--) {
    out[k] = Number(x & 0xffn);
    x >>= 8n;
  }
  return out;
}

export function readU32BE(b: Uint8Array, at: number): number {
  return ((b[at] << 24) >>> 0) + (b[at + 1] << 16) + (b[at + 2] << 8) + b[at + 3];
}

export function toB64url(b: Uint8Array): string {
  let s = "";
  for (const x of b) s += String.fromCharCode(x);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** 只认规范的 base64url（无填充、没有多余的位）：同一段字节只有一种写法，签名和去重都靠这个 */
export function fromB64url(s: string): Bytes | null {
  if (!/^[A-Za-z0-9_-]*$/.test(s) || s.length % 4 === 1) return null;
  const bin = atob(s.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (s.length % 4)) % 4));
  const out = Uint8Array.from(bin, (c) => c.charCodeAt(0));
  return toB64url(out) === s ? out : null;
}
