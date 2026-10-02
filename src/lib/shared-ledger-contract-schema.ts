/** Small JSON-only schema vocabulary shared by the V1 request and response validators. */
import { SharedLedgerError } from "./shared-ledger-contract.js";

export type Schema<T> = (value: unknown) => T;
export function invalid(): never { throw new SharedLedgerError("invalid_field"); }
export function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return invalid();
  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) return invalid();
  return value as Record<string, unknown>;
}

export function text(max: number, min = 0): Schema<string> {
  return (v) => typeof v === "string" && v.length >= min && v.length <= max && !v.includes("\0") ? v : invalid();
}
export const id: Schema<string> = (v) => typeof v === "string" && /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(v) ? v : invalid();
export const digest: Schema<string> = (v) => typeof v === "string" && /^[a-f0-9]{64}$/.test(v) ? v : invalid();
export const nonce: Schema<string> = (v) => typeof v === "string" && /^[a-f0-9]{32,64}$/.test(v) ? v : invalid();
export const integer: Schema<number> = (v) => typeof v === "number" && Number.isSafeInteger(v) && v >= 0 ? v : invalid();
export const positive: Schema<number> = (v) => integer(v) > 0 ? v as number : invalid();
export const boolean: Schema<boolean> = (v) => typeof v === "boolean" ? v : invalid();
export function literal<const T extends string | number | boolean>(value: T): Schema<T> {
  return (v) => v === value ? value : invalid();
}
export function choice<const T extends string>(values: readonly T[]): Schema<T> {
  return (v) => values.includes(v as T) ? v as T : invalid();
}
export function nullable<T>(schema: Schema<T>): Schema<T | null> { return (v) => v === null ? null : schema(v); }
export function optional<T>(schema: Schema<T>): Schema<T | undefined> { return (v) => v === undefined ? undefined : schema(v); }
export function array<T>(schema: Schema<T>, max = 1000): Schema<T[]> {
  return (v) => {
    if (!Array.isArray(v) || v.length > max) return invalid();
    return Array.from(v, schema);
  };
}
type Shape = Record<string, Schema<unknown>>;
type Parsed<S extends Shape> = { [K in keyof S]: ReturnType<S[K]> };
export function object<S extends Shape>(shape: S): Schema<Parsed<S>> {
  return (value) => {
    const row = record(value);
    if (Reflect.ownKeys(row).some((k) => typeof k !== "string" || !Object.hasOwn(shape, k))) return invalid();
    const out: Record<string, unknown> = {};
    for (const [key, parse] of Object.entries(shape)) {
      const value = parse(Object.hasOwn(row, key) ? row[key] : undefined);
      if (value !== undefined) out[key] = value;
    }
    return out as Parsed<S>;
  };
}
export function unique(values: readonly string[]): void {
  if (new Set(values).size !== values.length) invalid();
}
export const relativeGlob: Schema<string> = (v) => {
  const s = text(500, 1)(v);
  if (/^(?:[\\/~]|[A-Za-z]:)/.test(s) || s.includes("\\") || s.split("/").includes("..")) return invalid();
  return s;
};
