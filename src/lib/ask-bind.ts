/**
 * 显式 ask（docs 13 §4.3 四期）：reply 的 `ask` 字段的校验，授权绑定的参数哈希，以及 `ledger ask-check` 的判定。纯函数，tests/ask-bind.test.ts。
 * agent 给的东西形状不可信：不合格的字段整条拒掉（reply 报错给 agent），不猜、不静默丢。
 * 授权绑定是产品约束，不是安全边界：bypass 模式下 agent 本来就能直接执行（docs 13 §4.7）。
 */
import { createHash } from "node:crypto";
import { canonicalJson } from "./canonical-json.js";
import type { Ask, AskBind, AskKind } from "./ledger-asks.js";

/** 实现在 canonical-json.ts（不经 ledger-asks 类型图）；这里保留旧导出路径 */
export { canonicalJson };

/** reply 里能声明的类型；inform = 知会，不建 ask、这条回复也不推送；assigned 只能由 createAsk 开 */
type ReplyAskKind = Exclude<AskKind, "assigned"> | "inform";
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

/**
 * 授权绑定的哈希：action、version、发起 agent、params 一起算——换了动作 / 版本、换个 agent 拿去核对，哈希都对不上。
 * 存在 bind.paramsHash（列名沿用），reply 结果里的 askHash 就是它
 */
export const bindHash = (b: Pick<AskBind, "action" | "params" | "version">, fromAgent: string): string =>
  createHash("sha256").update(canonicalJson({ action: b.action, agent: fromAgent, params: b.params, version: b.version ?? null })).digest("hex");

/** 超过 2^53 的整数（把 Discord snowflake 写成了数字）进了 JS 就不精确了，不同的值会算出同一个哈希：要求写成字符串 */
function unsafeNumber(v: unknown): boolean {
  if (typeof v === "number") return !Number.isFinite(v) || (Number.isInteger(v) && !Number.isSafeInteger(v));
  if (Array.isArray(v)) return v.some(unsafeNumber);
  return !!v && typeof v === "object" && Object.values(v).some(unsafeNumber);
}

/** 键按解析后的值比（"a" 与 "\u0061" 是同一个键） */
function keyText(quoted: string): string {
  try {
    return JSON.parse(quoted) as string;
  } catch {
    return quoted; // 坏的转义：外面的 JSON.parse 会报错，这里怎么比都行
  }
}

/** 原始 JSON 里同一个对象有没有重复的键（JSON.parse 会静默留后一个，两种写法算出同一个哈希）。只在 ask-check --params 用：reply 的参数到这里时已经解析过了 */
export function hasDuplicateKeys(raw: string): boolean {
  const stack: (Set<string> | null)[] = [];
  for (let i = 0; i < raw.length; i++) {
    const c = raw[i];
    if (c === "{") stack.push(new Set());
    else if (c === "[") stack.push(null);
    else if (c === "}" || c === "]") stack.pop();
    else if (c === '"') {
      let j = i + 1;
      while (j < raw.length && raw[j] !== '"') j += raw[j] === "\\" ? 2 : 1;
      const keys = stack.at(-1);
      if (keys && /^\s*:/.test(raw.slice(j + 1, j + 20))) {
        const k = keyText(raw.slice(i, j + 1));
        if (keys.has(k)) return true;
        keys.add(k);
      }
      i = j;
    }
  }
  return false;
}

const str = (v: unknown, max: number): string | undefined => (typeof v === "string" && v.trim() ? v.trim().slice(0, max) : undefined);

/** 参数本身合不合格（大小、超大整数）；ask-check --params 另查重复键 */
export function paramsProblem(params: unknown): string | null {
  if (canonicalJson(params).length > PARAMS_MAX) return `ask.bind.params too large (> ${PARAMS_MAX} chars)`;
  return unsafeNumber(params) ? "ask.bind.params has an integer beyond 2^53 (or a non-finite number) — pass it as a string" : null;
}

function parseBind(raw: unknown): Omit<AskBind, "paramsHash"> | string {
  const b = raw as Record<string, unknown> | null;
  if (!b || typeof b !== "object") return "ask.bind is required for authorize";
  if (typeof b.action !== "string" || !ID_RE.test(b.action)) return "ask.bind.action must match ^[\\w:.-]{1,64}$";
  if (b.params === undefined) return "ask.bind.params is required (the exact parameters being authorized)";
  const bad = paramsProblem(b.params);
  if (bad) return bad;
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
 * 没被取代、核对的就是发起它的 agent，才算批准。其余一律拒绝，reason 是给 agent 看的一句话。
 */
export function checkAsk(a: Ask | null, hash: string, caller: string, now = Date.now()): AskCheckResult {
  if (!a) return { ok: false, reason: "ask not found" };
  if (!a.bind) return { ok: false, reason: `${a.id} has no authorization binding (not an authorize ask)` };
  if (a.fromAgent !== caller) return { ok: false, reason: `${a.id} was asked by ${a.fromAgent ?? "a person"}, not ${caller} — ask for your own approval` };
  if (a.state === "superseded") return { ok: false, reason: `${a.id} was superseded by a newer ask — use the new one` };
  if (a.state === "open") return { ok: false, reason: `${a.id} is not answered yet` };
  if (a.state !== "answered") return { ok: false, reason: `${a.id} is ${a.state} — treat as not approved` };
  if (a.expiresAt <= now) return { ok: false, reason: `${a.id} approval window ended at ${new Date(a.expiresAt).toISOString()} — ask again` };
  const picked = new Set((a.answer?.choices ?? []).map((w) => /^\[button:(.+)\]$/.exec(w)?.[1]).filter(Boolean));
  if (!a.bind.approve.some((id) => picked.has(id))) return { ok: false, reason: `${a.id} was answered without approving (${(a.answer?.labels ?? []).join(", ") || "no choice"})` };
  if (hash.toLowerCase() !== a.bind.paramsHash) return { ok: false, reason: `${a.id} hash mismatch — the action, version or parameters changed since approval; ask again` };
  return { ok: true };
}
