/** JSON-only schemas; inferred types and runtime validation share the same field table. */
export type Schema<T> = (value: unknown) => T;
export type Infer<S> = S extends Schema<infer T> ? T : never;
export const V2_ERROR_STATUS = {
  invalid_field: 400, payload_too_large: 413, unauthenticated: 401, bad_signature: 401, replayed: 409,
  forbidden: 403, not_member: 403, not_found: 404, conflict: 409, dedup_mismatch: 409,
  execution_not_shared: 403, pending_proposal: 409, stale_generation: 409, stale_epoch: 409,
  lease_expired: 409, wrong_home: 403, dependency_blocked: 409, resource_busy: 409,
  authorization_expired: 403, authorization_mismatch: 403, unknown_operation: 409,
  stale_order: 409, stale_lease_gen: 409, migration_blocked: 409, sequence_regressed: 409,
  transaction_required: 500, transaction_closed: 500, transaction_control: 500, unavailable: 503,
} as const;
export type V2ErrorCode = keyof typeof V2_ERROR_STATUS;
export class V2ContractError extends Error {
  readonly status: number;
  constructor(readonly code: V2ErrorCode) { super(code); this.name = "V2ContractError"; this.status = V2_ERROR_STATUS[code]; }
}
export function fail(code: V2ErrorCode = "invalid_field"): never { throw new V2ContractError(code); }
export function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return fail();
  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) return fail();
  if (Reflect.ownKeys(value).some(k => typeof k !== "string" || !Object.getOwnPropertyDescriptor(value, k)?.enumerable
    || !Object.hasOwn(Object.getOwnPropertyDescriptor(value, k)!, "value"))) return fail();
  return value as Record<string, unknown>;
}
export function text(max: number, min = 0): Schema<string> {
  return v => typeof v === "string" && v.length >= min && v.length <= max && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(v) ? v : fail();
}
function pattern(re: RegExp, max: number): Schema<string> {
  return v => { const s = text(max, 1)(v); return re.test(s) ? s : fail(); };
}
export const id = pattern(/^[A-Za-z0-9][A-Za-z0-9_.:-]*$/, 128);
export const digest = pattern(/^[a-f0-9]{64}$/, 64);
export const head = pattern(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/, 64);
export const repository = pattern(/^[A-Za-z0-9][A-Za-z0-9_-]*\/[A-Za-z0-9][A-Za-z0-9_.-]*$/, 180);
export function whole(min = 0, max = Number.MAX_SAFE_INTEGER): Schema<number> {
  return v => typeof v === "number" && Number.isSafeInteger(v) && v >= min && v <= max ? v : fail();
}
export const integer = whole(), positive = whole(1), timestamp = whole(0, 8.64e15);
export const boolean: Schema<boolean> = v => typeof v === "boolean" ? v : fail();
export function literal<const T extends string | number | boolean>(x: T): Schema<T> { return v => v === x ? x : fail(); }
export function choice<const T extends string>(xs: readonly T[]): Schema<T> { return v => xs.includes(v as T) ? v as T : fail(); }
export function nullable<T>(schema: Schema<T>): Schema<T | null> { return v => v === null ? null : schema(v); }
export function optional<T>(schema: Schema<T>): Schema<T | undefined> { return v => v === undefined ? undefined : schema(v); }
export function array<T>(schema: Schema<T>, max = 1000): Schema<T[]> {
  return v => {
    if (!Array.isArray(v) || v.length > max || Object.keys(v).length !== v.length) return fail();
    if (Reflect.ownKeys(v).length !== v.length + 1 || Object.keys(v).some(k =>
      !Object.hasOwn(Object.getOwnPropertyDescriptor(v, k)!, "value"))) return fail();
    return Array.from(v, schema);
  };
}
type Shape = Record<string, Schema<unknown>>;
type OptionalKeys<S extends Shape> = { [K in keyof S]: undefined extends Infer<S[K]> ? K : never }[keyof S];
export type Fields<S extends Shape> = { [K in Exclude<keyof S, OptionalKeys<S>>]: Infer<S[K]> }
  & { [K in OptionalKeys<S>]?: Exclude<Infer<S[K]>, undefined> };
export function object<const S extends Shape>(shape: S): Schema<Fields<S>> {
  return v => {
    const r = record(v), out: Record<string, unknown> = {};
    if (Object.keys(r).some(k => !Object.hasOwn(shape, k))) return fail();
    for (const [k, parse] of Object.entries(shape)) {
      const value = parse(Object.hasOwn(r, k) ? r[k] : undefined);
      if (value !== undefined) out[k] = value;
    }
    return out as Fields<S>;
  };
}
export function refine<T>(schema: Schema<T>, valid: (value: T) => boolean): Schema<T> {
  return v => { const parsed = schema(v); return valid(parsed) ? parsed : fail(); };
}
export function union<const S extends readonly Schema<unknown>[]>(...schemas: S): Schema<Infer<S[number]>> {
  return v => {
    for (const schema of schemas) {
      try { return schema(v) as Infer<S[number]>; }
      catch (e) { if (!(e instanceof V2ContractError) || e.code !== "invalid_field") throw e; }
    }
    return fail();
  };
}
export function distinct<T>(xs: readonly T[], key: (x: T) => string = x => String(x)): boolean {
  return new Set(xs.map(key)).size === xs.length;
}
/** Reject alternate encodings too: resources must have one canonical repository-relative spelling. */
export const relativePath: Schema<string> = refine(text(500, 1), s =>
  !/^(?:[\\/~]|[A-Za-z]:)/.test(s) && !/[\\%:#?\s]/.test(s)
  && s.split("/").every(part => !!part && part !== "." && part !== ".."));
export const branch = refine(relativePath, s => !/[~^\[\]*]/.test(s) && !s.includes("..") && !s.includes("@{") && !s.endsWith(".lock"));
export const scope = { teamId: id, projectId: id };
export const revisions = { rev: positive, createdAt: timestamp, updatedAt: timestamp };
export const fenceFields = { serviceGeneration: positive, epoch: positive, bootId: id };
export const parseFence = object(fenceFields);
export type V2Fence = Infer<typeof parseFence>;
/** Transport checks bytes before JSON.parse; object entry points apply the same upper bound. */
export function bounded<T>(schema: Schema<T>, maxBytes = 1_048_576): Schema<T> {
  return v => {
    let encoded: string | undefined;
    try { encoded = JSON.stringify(v); } catch { return fail(); /* Cyclic/non-JSON bodies are invalid wire input. */ }
    if (!encoded) return fail();
    if (new TextEncoder().encode(encoded).length > maxBytes) return fail("payload_too_large");
    return schema(v);
  };
}
