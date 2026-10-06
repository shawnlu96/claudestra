/**
 * Provider model-config failure (dispatch-recovery-LCFG1), shared part and the lender (B) side. A normal worker start that
 * fails with an explicit model-not-enabled configuration error is a family fault of this lender, not of the order: B keeps
 * the evidence per peer + family and tells its own owner once that the family's configuration is unusable (no commands,
 * no buttons — whether to change the model is the owner's call). The borrower (A) side lives in lend-config-failure-pool.ts.
 * - Only that one class counts: quota, capacity, rate limit, network, login and safety / cyber refusals are never a
 *   configuration fault, so this path can never route around a safety decision.
 * - One mode for the whole mechanism (on / observe / off) from the one recovery policy (key lendConfigFailure, project lend),
 *   default observe: observe only logs the would-be pause / refusal, off does nothing; neither writes a pause, refuses a start
 *   nor notifies. A throwing port or an illegal mode answers off.
 * - Recovery is explicit (recoverProviderConfigFailure, CAS on the record's generation); never by elapsed time. A late
 *   notify result or an old generation can never touch a newer fault. Live orders are never stopped from here.
 * tests/lend-config-failure*.test.ts.
 */
import type { Database } from "bun:sqlite";
import { isCyberPolicy } from "./agent-supervisor-policy.js";
import { LEND_FAMILIES } from "./lend-config.js";
import { getMeta, getOrder, setMeta, type LendRow } from "./lend-journal.js";
import type { LendNoticeParams } from "./lend-notice.js";
import type { HelloConfigRecovered } from "./lend-wire-v2.js";
import { ORDER_ID } from "./lend-wire-v2-schema.js";
import { recoveryPolicy, type RecoveryKey, type RecoveryPolicyPort } from "./recovery-policy.js";

export const CONFIG_FAILURE_CATEGORY = "model_not_enabled";
export type ConfigFailureCategory = typeof CONFIG_FAILURE_CATEGORY;
export type ConfigFailureMode = "on" | "observe" | "off";
const MODES: readonly unknown[] = ["on", "observe", "off"];

const MODEL_NOT_ENABLED = /model[_ -]not[_ -]enabled|\bmodel\b[^\n]{0,120}\b(?:is not|was not|isn't|has not been) enabled|\bmodel\b[^\n]{0,120}\bnot enabled for (?:this|your)\b/i;
/** Classes that are never configuration faults, checked first so an ambiguous text never lands here. */
const NOT_CONFIG = new RegExp([
  "usage limit", "quota", "rate[ _-]?limit", "too many requests", "\\b429\\b", "overloaded", "\\b529\\b", "capacity", "insufficient", "credit",
  "authenticat", "login", "unauthori[sz]ed", "\\b401\\b", "econn", "etimedout", "enotfound", "eai_again", "network", "timed? ?out", "fetch failed",
  "socket", "safety", "refus", "flagged", "policy",
].join("|"), "i");

/** The configuration class of a worker start error, or null for anything else (including safety refusals). */
export function classifyConfigFailure(error: string): ConfigFailureCategory | null {
  if (!error || isCyberPolicy(error) || NOT_CONFIG.test(error)) return null;
  return MODEL_NOT_ENABLED.test(error) ? CONFIG_FAILURE_CATEGORY : null;
}

/** The mechanism's key in the one recovery policy (recovery-policy.json), read for the lend project: one mode for B and A. */
const CONFIG_FAILURE_KEY = "lendConfigFailure" satisfies RecoveryKey;
const CONFIG_FAILURE_PROJECT = "lend";
let policyPort: RecoveryPolicyPort = recoveryPolicy;
/** Tests inject a RecoveryPolicyPort; null restores the file-backed recoveryPolicy. Read afresh on every call. */
export function setConfigFailurePolicy(port: RecoveryPolicyPort | null): void {
  policyPort = port ?? recoveryPolicy;
}
export function configFailureMode(): ConfigFailureMode {
  try {
    const m = policyPort(CONFIG_FAILURE_PROJECT, CONFIG_FAILURE_KEY)?.mode;
    return MODES.includes(m) ? (m as ConfigFailureMode) : "off";
  } catch {
    return "off";
  }
}

const oneLine = (s: string, max: number): string => s.replace(/[\p{Cc}\s\u2028\u2029]+/gu, " ").trim().slice(0, max);

interface Evidence { orderId: string; at: number; category: ConfigFailureCategory; excerpt: string }
/** One fault generation of this lender's family for one peer; notice = the one owner notice (sending is claimed, at most once). */
export interface ProviderConfigFailure {
  gen: number; peer: string; family: string; category: ConfigFailureCategory; firstAt: number; lastAt: number;
  evidence: Evidence[]; notice: { state: "sending" | "sent"; at: number } | null; recoveredAt: number | null;
}
const EVIDENCE_MAX = 20;
const keyOf = (peer: string, family: string): string => `config-failure:${JSON.stringify([peer, family])}`;

export function providerConfigFailure(db: Database, peer: string, family: string): ProviderConfigFailure | null {
  const raw = getMeta(db, keyOf(peer, family));
  if (!raw) return null;
  try { return JSON.parse(raw) as ProviderConfigFailure; } catch { return null; }
}
/** Is this peer + family registered unavailable on this lender now (a fault not yet explicitly recovered)? */
export const providerFamilyUnavailable = (db: Database, peer: string, family: string): boolean => {
  const f = providerConfigFailure(db, peer, family);
  return !!f && f.recoveredAt === null;
};

const put = (db: Database, f: ProviderConfigFailure): void => setMeta(db, keyOf(f.peer, f.family), JSON.stringify(f));

/** Apply `fn` to the record only if it is still generation `gen`; one journal transaction. */
function casGen(db: Database, peer: string, family: string, gen: number, fn: (f: ProviderConfigFailure) => ProviderConfigFailure | null): boolean {
  return db.transaction(() => {
    const cur = providerConfigFailure(db, peer, family);
    if (!cur || cur.gen !== gen) return false;
    const next = fn(cur);
    if (!next) return false;
    put(db, next);
    return true;
  }).immediate();
}

/** Register the fault (or add evidence to the open one); returns the generation whose notice this call must send, or null. */
function register(db: Database, row: LendRow, ev: Evidence, now: number): number | null {
  return db.transaction(() => {
    const cur = providerConfigFailure(db, row.peer, row.family);
    if (cur && cur.recoveredAt === null) {
      const claim = cur.notice === null;
      put(db, { ...cur, lastAt: now, evidence: [...cur.evidence, ev].slice(-EVIDENCE_MAX), notice: claim ? { state: "sending", at: now } : cur.notice });
      return claim ? cur.gen : null;
    }
    const gen = (cur?.gen ?? 0) + 1;
    put(db, { gen, peer: row.peer, family: row.family, category: ev.category, firstAt: now, lastAt: now, evidence: [ev],
      notice: { state: "sending", at: now }, recoveredAt: null });
    return gen;
  }).immediate();
}

export interface ConfigFailureDeps {
  db: Database;
  now(): number;
  notify(p: LendNoticeParams): Promise<{ ok: true } | { ok: false; error: string }>;
  log(msg: string): void;
}

const str = (v: unknown): string => (typeof v === "string" ? v : "");

/** The notice is about the newest evidence order (the order row when the journal still has it, else just its id). */
function noticeOf(db: Database, f: ProviderConfigFailure): LendNoticeParams {
  const last = f.evidence[f.evidence.length - 1];
  const row = last ? getOrder(db, last.orderId) : null;
  const o = { ...row?.preview, ...(row?.wire?.order ?? {}) };
  const text = `配置不可用：本机 ${f.family} 模型未启用（${f.category}），${f.peer} 借的 ${f.family} 位起不来；是否修改模型由你决定。原文：${last?.excerpt ?? ""}`;
  const why = oneLine(text, 300);
  return { orderId: last?.orderId ?? "", peer: f.peer, fp: row?.fp ?? null, family: f.family, repo: str(o.repo), pr: typeof o.pr === "number" ? o.pr : null,
    head: str(o.head), taskId: str(o.taskId), step: str(o.step), quota: `${f.family} 配置故障（第 ${f.gen} 代）`, kind: "stopped", why };
}

/** A notice claim older than this is taken as lost (the process died mid-send) and may be claimed again. */
export const NOTICE_STALE_MS = 15 * 60_000;
const claimable = (f: ProviderConfigFailure, now: number): boolean =>
  f.recoveredAt === null && (f.notice === null || (f.notice.state === "sending" && now - f.notice.at >= NOTICE_STALE_MS));

/** Send the claimed notice of generation `gen`, then settle it by CAS: sent, or freed (null) for the next retry; a stale result is dropped. */
async function sendNotice(d: ConfigFailureDeps, peer: string, family: string, gen: number, claimedAt: number): Promise<void> {
  const f = providerConfigFailure(d.db, peer, family);
  if (!f || f.gen !== gen) return;
  let sent: { ok: true } | { ok: false; error: string };
  try { sent = await d.notify(noticeOf(d.db, f)); } catch (e) { sent = { ok: false, error: String(e) }; }
  const settled = casGen(d.db, peer, family, gen, (cur) => cur.notice?.state !== "sending" || cur.notice.at !== claimedAt ? null
    : { ...cur, notice: sent.ok ? { state: "sent", at: d.now() } : null });
  if (!sent.ok) d.log(`配置故障通知没交出去（${sent.error}），${peer} 的 ${family} 由下一轮补发`);
  else if (!settled) d.log(`配置故障通知结果已过期（第 ${gen} 代已不是当前），不改新故障`);
}

/**
 * Called beside pauseForStartFailure with the real create error. Not the configuration class / off: nothing. observe: log the
 * would-be pause only. on: register per peer + family with the evidence and send the owner notice at most once per generation
 * (concurrent failures see the claimed notice; a failed send frees it for retryConfigNotices, a stale result is dropped by CAS).
 */
export async function noteStartConfigFailure(d: ConfigFailureDeps, row: LendRow, error: string): Promise<void> {
  const category = classifyConfigFailure(error);
  if (!category) return;
  const mode = configFailureMode();
  if (mode === "off") return;
  const now = d.now();
  const ev: Evidence = { orderId: row.orderId, at: now, category, excerpt: oneLine(error, 300) };
  if (mode === "observe") {
    return d.log(`配置故障观察（observe）：本会把 ${row.peer} 的 ${row.family} 登记为不可接（${category}，单 ${row.orderId}），不写暂停、不通知`);
  }
  const gen = register(d.db, row, ev, now);
  if (gen !== null) await sendNotice(d, row.peer, row.family, gen, now);
}

/**
 * The notice's own retry path, independent of new start failures (startConfigRefusal keeps those from happening): under on,
 * every unrecovered fault of this peer whose notice is unsent (a failed send freed it, or a claim went stale) is claimed by
 * CAS and sent once more. Called from the hello round (lend-hello.ts) and beside each refusal; observe / off: nothing.
 */
export async function retryConfigNotices(d: ConfigFailureDeps, peer: string): Promise<void> {
  if (configFailureMode() !== "on") return;
  for (const family of LEND_FAMILIES) {
    const f = providerConfigFailure(d.db, peer, family);
    const now = d.now();
    if (!f || !claimable(f, now)) continue;
    const claimed = casGen(d.db, peer, family, f.gen, (cur) => (claimable(cur, now) ? { ...cur, notice: { state: "sending", at: now } } : null));
    if (claimed) await sendNotice(d, peer, family, f.gen, now);
  }
}

/**
 * startWorker, before worker.create (a new order only: started / leased orders never get here): under on, a peer + family this
 * lender registered unavailable is not started again; the refused order joins the fault's evidence, and the answer is the
 * not_started detail carrying the original category and evidence so the borrower's classifier sees the same fault. An unsent
 * notice is retried alongside (when the caller has notify). observe logs the would-be refusal; off / available: null.
 */
export function startConfigRefusal(d: Pick<ConfigFailureDeps, "db" | "log"> & Partial<Pick<ConfigFailureDeps, "now" | "notify">>, row: LendRow): string | null {
  const mode = configFailureMode();
  if (mode === "off") return null;
  const f = providerConfigFailure(d.db, row.peer, row.family);
  if (!f || f.recoveredAt !== null) return null;
  const last = f.evidence[f.evidence.length - 1];
  if (mode === "observe") return d.log(`配置故障观察（observe）：本会因 ${row.peer} 的 ${row.family} 配置故障（第 ${f.gen} 代）不起 ${row.orderId}`), null;
  const now = d.now?.() ?? Date.now();
  casGen(d.db, row.peer, row.family, f.gen, (cur) => cur.recoveredAt !== null || cur.evidence.some((e) => e.orderId === row.orderId) ? null
    : { ...cur, lastAt: now, evidence: [...cur.evidence, { orderId: row.orderId, at: now, category: cur.category, excerpt: last?.excerpt ?? cur.category }].slice(-EVIDENCE_MAX) });
  if (d.notify && d.now) void retryConfigNotices(d as ConfigFailureDeps, row.peer).catch((e) => d.log(`配置故障通知补发出错：${String(e)}`));
  return `起 worker 失败：配置故障未恢复，没有再启动（第 ${f.gen} 代，单 ${last?.orderId ?? "?"}）：${last?.excerpt ?? f.category}`.slice(0, 400);
}

/** helloBody's slots for one peer: under on, a family registered unavailable reports total 0 (busy kept: live orders go on). */
export function configFailureSlots<S extends Record<string, { total: number; busy: number }>>(db: Database, peer: string | undefined, slots: S): S {
  if (!peer || configFailureMode() !== "on") return slots;
  const down = Object.keys(slots).filter((f) => slots[f].total > 0 && providerFamilyUnavailable(db, peer, f));
  return down.length ? { ...slots, ...Object.fromEntries(down.map((f) => [f, { ...slots[f], total: 0 }])) } : slots;
}

/**
 * helloBody's configRecovered for one peer: each family whose fault generation the owner explicitly recovered
 * (recoverProviderConfigFailure succeeded), with that generation's evidence orders. The borrower clears its fault only when its
 * newest fault order is in the list (lend-config-failure-pool.ts), so a restart, a mode switch or a capacity change never
 * declares anything and an old declaration never covers a newer fault. off: nothing; undefined when there is nothing to say.
 */
export function configRecoveredDecl(db: Database, peer: string | undefined): HelloConfigRecovered | undefined {
  if (!peer || configFailureMode() === "off") return undefined;
  const out: HelloConfigRecovered = {};
  for (const family of LEND_FAMILIES) {
    const f = providerConfigFailure(db, peer, family);
    const orders = [...new Set(f?.evidence.map((e) => e.orderId).filter((id) => ORDER_ID.test(id)))].slice(-EVIDENCE_MAX);
    if (f && f.recoveredAt !== null && Number.isSafeInteger(f.gen) && f.gen >= 1 && orders.length) out[family] = { gen: f.gen, orders };
  }
  return Object.keys(out).length ? out : undefined;
}

/** The owner's explicit recovery of one fault generation (CAS): an old generation never clears a newer fault. */
export function recoverProviderConfigFailure(db: Database, peer: string, family: string, gen: number, now: number): boolean {
  return casGen(db, peer, family, gen, (cur) => (cur.recoveredAt === null ? { ...cur, recoveredAt: now } : null));
}
