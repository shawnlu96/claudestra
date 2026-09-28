/**
 * 显式 ask（docs 13 §4.3 四期）：reply 的 `ask` 字段的校验，授权绑定的参数哈希，以及 `ledger ask-check` 的判定。纯函数，tests/ask-bind.test.ts。
 * agent 给的东西形状不可信：不合格的字段整条拒掉（reply 报错给 agent），不猜、不静默丢。
 * 授权绑定是产品约束，不是安全边界：bypass 模式下 agent 本来就能直接执行（docs 13 §4.7）。
 */
import { createHash } from "node:crypto";
import type { Ask, AskBind, AskKind } from "./ledger-asks.js";

/** reply 里能声明的类型；inform = 知会，不建 ask、这条回复也不推送；assigned 只能由 createAsk 开 */
export type ReplyAskKind = Exclude<AskKind, "assigned"> | "inform";
const REPLY_KINDS: readonly ReplyAskKind[] = ["decide", "authorize", "owner_action", "accept", "inform"];

export interface ReplyAsk {
  kind: ReplyAskKind;
  /** 取代键：同一个 agent 同一个 key 再问，旧的作废；authorize 不写时用 bind.action */
  key?: string;
  blocking?: boolean;
  why?: string;
  ifIgnored?: string;
  /** 有效期（秒），不给按 kind 的默认 */
  expiresIn?: number;
  bind?: Omit<AskBind, "paramsHash">;
}

const ID_RE = /^[\w:.-]{1,64}$/;
const TEXT_MAX = 300;
const PARAMS_MAX = 4096;
const EXPIRES_MIN_S = 60;
const EXPIRES_MAX_S = 7 * 24 * 3600;

/** 键排好序的 JSON：同样的参数不管 agent 按什么顺序写，哈希都一样 */
export function canonicalJson(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(",")}]`;
  if (v && typeof v === "object") {
    const o = v as Record<string, unknown>;
    return `{${Object.keys(o).sort().filter((k) => o[k] !== undefined).map((k) => `${JSON.stringify(k)}:${canonicalJson(o[k])}`).join(",")}}`;
  }
  return JSON.stringify(v ?? null);
}

export const paramsHash = (params: unknown): string => createHash("sha256").update(canonicalJson(params)).digest("hex");

const str = (v: unknown, max: number): string | undefined => (typeof v === "string" && v.trim() ? v.trim().slice(0, max) : undefined);

function parseBind(raw: unknown): Omit<AskBind, "paramsHash"> | string {
  const b = raw as Record<string, unknown> | null;
  if (!b || typeof b !== "object") return "ask.bind is required for authorize";
  if (typeof b.action !== "string" || !ID_RE.test(b.action)) return "ask.bind.action must match ^[\\w:.-]{1,64}$";
  if (b.params === undefined) return "ask.bind.params is required (the exact parameters being authorized)";
  if (canonicalJson(b.params).length > PARAMS_MAX) return `ask.bind.params too large (> ${PARAMS_MAX} chars)`;
  const approve = Array.isArray(b.approve) ? b.approve.filter((x): x is string => typeof x === "string" && ID_RE.test(x)) : [];
  if (!approve.length) return "ask.bind.approve must list the button id(s) that mean \"approved\"";
  const version = str(b.version, 80);
  return { action: b.action, params: b.params, approve, ...(version ? { version } : {}) };
}

/** reply 的 ask 字段 → 校验后的形状；不合格返回错误句（英文，原样回给 agent） */
export function parseReplyAsk(raw: unknown): { ask: ReplyAsk } | { error: string } {
  const r = raw as Record<string, unknown> | null;
  if (!r || typeof r !== "object" || Array.isArray(r)) return { error: "ask must be an object" };
  const kind = r.kind as ReplyAskKind;
  if (!REPLY_KINDS.includes(kind)) return { error: `ask.kind must be one of ${REPLY_KINDS.join(" | ")}` };
  if (r.key !== undefined && (typeof r.key !== "string" || !ID_RE.test(r.key))) return { error: "ask.key must match ^[\\w:.-]{1,64}$" };
  if (r.blocking !== undefined && typeof r.blocking !== "boolean") return { error: "ask.blocking must be a boolean" };
  const exp = r.expiresIn;
  if (exp !== undefined && (typeof exp !== "number" || !Number.isFinite(exp) || exp < EXPIRES_MIN_S || exp > EXPIRES_MAX_S)) {
    return { error: `ask.expiresIn is seconds, ${EXPIRES_MIN_S}..${EXPIRES_MAX_S}` };
  }
  const out: ReplyAsk = { kind };
  if (typeof r.key === "string") out.key = r.key;
  if (typeof r.blocking === "boolean") out.blocking = r.blocking;
  if (typeof exp === "number") out.expiresIn = Math.round(exp);
  const why = str(r.why, TEXT_MAX);
  const ifIgnored = str(r.ifIgnored, TEXT_MAX);
  if (why) out.why = why;
  if (ifIgnored) out.ifIgnored = ifIgnored;
  if (kind === "authorize" || r.bind !== undefined) {
    const b = parseBind(r.bind);
    if (typeof b === "string") return { error: b };
    out.bind = b;
  }
  return { ask: out };
}

/** 授权类的按钮必须真在选项里：approve 里写了一个不存在的按钮，这条授权永远批不下来 */
export function missingApprove(bind: Pick<AskBind, "approve">, optionIds: Set<string>): string[] {
  return bind.approve.filter((id) => !optionIds.has(id));
}

export type AskCheckResult = { ok: true } | { ok: false; reason: string };

/**
 * `ledger ask-check <askId> --hash <h>`：授权类、已作答、选的是 approve 里的按钮、参数哈希一致、没过期（有效期从开出算，答了也不延长）、
 * 没被取代，才算批准。其余一律拒绝，reason 是给 agent 看的一句话。
 */
export function checkAsk(a: Ask | null, hash: string, now = Date.now()): AskCheckResult {
  if (!a) return { ok: false, reason: "ask not found" };
  if (!a.bind) return { ok: false, reason: `${a.id} has no authorization binding (not an authorize ask)` };
  if (a.state === "superseded") return { ok: false, reason: `${a.id} was superseded by a newer ask — use the new one` };
  if (a.state === "open") return { ok: false, reason: `${a.id} is not answered yet` };
  if (a.state !== "answered") return { ok: false, reason: `${a.id} is ${a.state} — treat as not approved` };
  if (a.expiresAt <= now) return { ok: false, reason: `${a.id} approval window ended at ${new Date(a.expiresAt).toISOString()} — ask again` };
  const picked = new Set((a.answer?.choices ?? []).map((w) => /^\[button:(.+)\]$/.exec(w)?.[1]).filter(Boolean));
  if (!a.bind.approve.some((id) => picked.has(id))) return { ok: false, reason: `${a.id} was answered without approving (${(a.answer?.labels ?? []).join(", ") || "no choice"})` };
  if (hash.toLowerCase() !== a.bind.paramsHash) return { ok: false, reason: `${a.id} parameter hash mismatch — the parameters changed since approval; ask again` };
  return { ok: true };
}
