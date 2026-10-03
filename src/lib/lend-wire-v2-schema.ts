/**
 * Lend protocol v2 的共享严格解析 helper 与协议常量（cloud-PP2，从 lib/lend-wire-v2.ts 原样搬出）：lend-wire-v2 的 hello / beat / ask
 * 与 lend-offer-protocol 的 offer 共用这一份实现。LEND_PROTO / OFFER_MAX / BODY_V 只在这里定义；不 import 任何模块（纯函数、无状态）。
 */

/** The protocol generation this build speaks; hello carries it both ways. A peer with no hello on file is proto 1 (poll only). */
export const LEND_PROTO = 3;
export const BODY_V = 1;
export const OFFER_MAX = 20;
export const MAX_TS = 8.64e15;

export const ORDER_ID = /^[\w.:-]{1,200}$/;
export const TASK_ID = /^[\w.-]{1,64}$/;
export const REPO = /^[A-Za-z0-9][A-Za-z0-9-]{0,38}\/(?!\.\.?$)[A-Za-z0-9_.-]{1,100}$/;
export const SHA40 = /^[0-9a-f]{40}$/;

class V2Error extends Error {}
export const no = (path: string, why: string): never => { throw new V2Error(`${path}: ${why}`); };

/** Exactly these keys (optional ones may be absent); anything else is refused. */
export function fields(v: unknown, path: string, keys: readonly string[], optional: readonly string[] = []): Record<string, unknown> {
  if (!v || typeof v !== "object" || Array.isArray(v)) return no(path, "要是对象");
  const r = v as Record<string, unknown>;
  const unknownKey = Object.keys(r).find((k) => !keys.includes(k) && !optional.includes(k));
  if (unknownKey !== undefined) no(path, `不认识的字段 ${unknownKey}`);
  const absent = keys.filter((k) => !(k in r));
  if (absent.length) no(path, `缺字段 ${absent.join(", ")}`);
  return r;
}
export const whole = (v: unknown, path: string, lo: number, hi: number): number =>
  Number.isSafeInteger(v) && (v as number) >= lo && (v as number) <= hi ? v as number : no(path, `要是 ${lo}–${hi} 的整数`);
export const pattern = (v: unknown, path: string, re: RegExp): string => (typeof v === "string" && re.test(v) ? v : no(path, "格式不对"));
export const pick = <T extends string>(v: unknown, path: string, all: readonly T[]): T => (all.includes(v as T) ? v as T : no(path, `只认 ${all.join(" / ")}`));
export function arrayOf<T>(v: unknown, path: string, max: number, each: (x: unknown, p: string) => T): T[] {
  if (!Array.isArray(v) || v.length > max) return no(path, `要是不超过 ${max} 项的数组`);
  return v.map((x, i) => each(x, `${path}[${i}]`));
}
export const version = (r: Record<string, unknown>): 1 => (r.v === BODY_V ? BODY_V : no("v", `只认版本 ${BODY_V}`));

export type Parsed<T> = { ok: true; value: T } | { ok: false; error: string };
export function guard<T>(fn: () => T): Parsed<T> {
  try {
    return { ok: true, value: fn() };
  } catch (e) {
    if (e instanceof V2Error) return { ok: false, error: e.message };
    throw e;
  }
}
