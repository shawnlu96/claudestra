/**
 * dispatch-recovery-SPECG1 (the gate side; the writer's hook is spec-material-preflight.ts): when a card's spec or its own dispatch material is written (createTask / setTask, so `task-new`,
 * `task-set` and every system path that sets spec / specRev / extra.fileGlobs), build the write order a lend offer would build
 * (writeOrderWire, the same forPeer SHA cut) and run it through the same peer gate (redactOrderForPeer on the whole and the
 * chunked form, renderOrderWire, parseOrderWire). Nothing here matches text on its own and nothing is rewritten or cut.
 * Mode is the one RecoveryPolicyPort, key "materials": off = old path, nothing runs; observe (default) = a would-block is recorded
 * once (recordObserved), the write goes on; on = a refusal throws inside the writer's transaction, so the card, its rev and its
 * specRev stay as they were. A diagnostic carries only a fixed category, the material's index, the rule version, the content
 * digest and a fixed advice, never the refused text or the gate's message. A pass receipt holds for exactly that rule version,
 * content, specRev and target; it is never a pass for the offer, which runs the full gate again. A preflight that cannot run
 * (no spec file, an unexpected error) is "unavailable": no receipt, no block. tests/spec-material-preflight*.test.ts.
 */
import type { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import type { WriteCtx } from "./ledger-checks.js";
import { restateFacts } from "./ledger-lend-relay.js";
import { writeOrderWire } from "./ledger-lend-lease.js";
import type { LedgerTask } from "./ledger-stages.js";
import { getMeta, LedgerError, listEvents } from "./ledger-store.js";
import { redactForPeer } from "./dispatch-redact.js";
import { lendBranch } from "./lend-git.js";
import { aliasFindings, cardHeads, shortenShas } from "./order-gate-heads.js";
import { parseOrderWire, type OrderWire } from "./order-wire.js";
import { chunkInputs, wholeInputs, type InputSplit } from "./order-wire-chunks.js";
import { orderFileScope } from "./order-wire-file-scope.js";
import { fold, OrderRenderError, peerTextRefusal, redactOrderForPeer, renderOrderWire } from "./order-wire-render.js";
import { peerSecretHit } from "./peer-secret-gate.js";
import { decideRecovery, recordObserved, recoveryPolicy, type RecoveryPolicyPort } from "./recovery-policy.js";
import { readTextSoft, specPathFor } from "./task-spec.js";
import {
  registerSpecPreflight, type MaterialKind, type PreflightCategory, type PreflightReceipt, type PreflightResult,
} from "./spec-material-preflight.js";

/** Bump when this module changes what it hands the gate; the gate's own code is fingerprinted in ruleVersion(). */
const PREFLIGHT_FORMAT = 1;
const MECHANISM = "materials";
/** Placeholders only for the parts an offer learns at offer time (base head, peer fingerprint); both are code-made, never foreign. */
const HEAD = "0".repeat(40);
const FP = "0000-0000-0000-0000";

const PREFLIGHT_ADVICE = "外发闸规则不变、不放宽：由 PM 另建中性表述的新材料（原版本与来源保留），或留本机执行；改写不是豁免，挂单时仍完整过闸。";

let policyPort: RecoveryPolicyPort = recoveryPolicy;
/** Wiring / tests hand in the one policy port; returns the restore function. */
export function useSpecPreflightPolicy(port: RecoveryPolicyPort): () => void {
  const prev = policyPort;
  policyPort = port;
  return () => { policyPort = prev; };
}

/** Synthetic, code-built probes (no real values): the gate's constants show up in the fingerprint through their verdicts. */
const PROBES = ["sk-" + "a".repeat(20), "gh" + "p_" + "b".repeat(24), "Bear" + "er " + "c".repeat(12), "-----BEGIN " + "PRIVATE KEY-----",
  "x".repeat(8) + "Ab3".repeat(12), "10.0.0." + "7", "user@" + "example.com", "inputs 1／2​3"];
const GATE_CODE = [fold, redactOrderForPeer, renderOrderWire, peerTextRefusal, peerSecretHit, redactForPeer, parseOrderWire,
  writeOrderWire, orderFileScope, shortenShas, aliasFindings, cardHeads, chunkInputs, wholeInputs, restateFacts];
let ruleMemo: string | null = null;
/** The gate this process runs: its code plus its verdicts on fixed probes. An offer built from other code gets another version. */
export function ruleVersion(): string {
  if (ruleMemo) return ruleMemo;
  const h = createHash("sha256").update(`spec-preflight:v${PREFLIGHT_FORMAT}\n`);
  for (const f of GATE_CODE) h.update(`${f.name}\n${f.toString()}\n`);
  for (const p of PROBES) h.update(`${peerSecretHit(fold(p), null) ?? "-"}|${redactForPeer(fold(p)).text}|${peerTextRefusal(p) ?? "-"}\n`);
  return (ruleMemo = h.digest("hex"));
}

/** What a material write changed: only spec / specRev / the registered file scope make the dispatch material different. */
function touchesMaterial(before: LedgerTask | null, after: LedgerTask): boolean {
  if (!before) return true;
  return before.spec !== after.spec || before.specRev !== after.specRev
    || JSON.stringify(before.extra?.fileGlobs) !== JSON.stringify(after.extra?.fileGlobs);
}

/** The write order an offer of this card would carry, as writeOrderWire builds it, with forPeer's pure rewrites applied. */
function orderOf(db: Database, task: LedgerTask, spec: string, split: InputSplit): OrderWire {
  const facts = restateFacts(listEvents(db, { project: task.project, target: task.id }), task.specRev);
  const repo = typeof task.extra?.repo === "string" ? task.extra.repo : "preflight/repo";
  const w = writeOrderWire(task, { orderId: `lend:${task.id}:s${task.specRev}:r${task.round}:a0`, step: "write", head: HEAD,
    branch: lendBranch(task.id, FP) ?? `lend/${task.id}`, base: "main", spec, report: null, findings: [], repo, pr: null,
    restate: facts.answered ? null : facts.text }, split);
  const heads = cardHeads(db, task);
  return { ...w, inputs: w.inputs.map((s) => shortenShas(s, heads, w.head).text), findings: aliasFindings(w.findings).findings };
}

const digestOf = (o: OrderWire): string => createHash("sha256").update(JSON.stringify(o)).digest("hex");

function categoryOf(message: string): PreflightCategory {
  if (message.includes("文件范围")) return "file_scope";
  if (message.includes("疑似含密钥")) return "secret";
  if (message.includes("含疑似敏感内容")) return "sensitive_id";
  if (/超过 \d+ 字节/.test(message)) return "oversize";
  if (/超过 \d+ 项/.test(message)) return "too_many";
  if (message.includes("head")) return "head";
  return "other";
}

const KINDS: [string, MaterialKind][] = [["规格原文", "spec"], ["本单文件范围", "file_scope"], ["本机复述原文", "restate"]];
/** Index (1-based) and kind of the whole-form input the gate named; labels are code-written, so the prefix is safe to read. */
function materialOf(message: string, whole: OrderWire | null): { material: number | null; kind: MaterialKind } {
  const i = /^inputs\[(\d+)\]/.exec(message)?.[1];
  const text = i !== undefined && whole ? whole.inputs[Number(i)] : undefined;
  const kind = text === undefined ? "order_text" : KINDS.find(([label]) => text.startsWith(label))?.[1] ?? "order_text";
  return { material: text === undefined ? null : Number(i) + 1, kind };
}

/** Same gate sequence as offerLendCore: whole scan, chunked gate + render, wire check. Returns the refusal or null. */
function gate(whole: OrderWire, wire: OrderWire): { message: string; format?: true } | null {
  try {
    redactOrderForPeer(whole, whole.head);
    const out = redactOrderForPeer(wire, wire.head).order;
    renderOrderWire(out, { audience: "peer", ledgerHead: wire.head });
    return parseOrderWire(JSON.parse(JSON.stringify(out))).ok ? null : { message: "", format: true };
  } catch (e) {
    if (e instanceof OrderRenderError) return { message: e.message };
    throw e;
  }
}

/** Pure check of one card as stored now (no policy, no writes). */
export function preflightSpecMaterial(db: Database, task: LedgerTask, readSpec = defaultSpec(db)): PreflightResult {
  const rv = ruleVersion();
  try {
    const spec = readSpec(task);
    if (spec === null) return { status: "unavailable", reason: "no_spec", ruleVersion: rv };
    let whole: OrderWire;
    let wire: OrderWire;
    try {
      whole = orderOf(db, task, spec, wholeInputs);
      wire = orderOf(db, task, spec, chunkInputs);
    } catch (e) {
      if (!(e instanceof LedgerError) || !e.message.includes("文件范围")) throw e;
      const raw = JSON.stringify([task.id, task.specRev, spec, task.extra?.fileGlobs ?? null]);
      return blocked("file_scope", { material: null, kind: "file_scope" }, rv, createHash("sha256").update(raw).digest("hex"));
    }
    const digest = digestOf(whole);
    const refused = gate(whole, wire);
    if (!refused) return { status: "pass", receipt: { project: task.project, taskId: task.id, specRev: task.specRev, ruleVersion: rv, digest } };
    if (refused.format) return blocked("format", { material: null, kind: "order_text" }, rv, digest);
    return blocked(categoryOf(refused.message), materialOf(refused.message, whole), rv, digest);
  } catch {
    return { status: "unavailable", reason: "error", ruleVersion: rv };
  }
}

const blocked = (category: PreflightCategory, at: { material: number | null; kind: MaterialKind }, ruleVersion: string, digest: string): PreflightResult =>
  ({ status: "blocked", category, ...at, ruleVersion, digest, advice: PREFLIGHT_ADVICE });

const defaultSpec = (db: Database) => (t: LedgerTask): string | null => readTextSoft(specPathFor(t, getMeta(db, t.project).docsDir));

/** A receipt counts only for the same target, specRev, rule version and exact content as a fresh preflight of the card now. */
export function receiptHolds(receipt: PreflightReceipt, now: PreflightResult): boolean {
  if (now.status !== "pass") return false;
  const r = now.receipt;
  return r.project === receipt.project && r.taskId === receipt.taskId && r.specRev === receipt.specRev
    && r.ruleVersion === receipt.ruleVersion && r.digest === receipt.digest;
}

/** One line, no foreign text: what a refusal or a would-block says. */
function preflightLine(r: Extract<PreflightResult, { status: "blocked" }>): string {
  const at = r.material === null ? r.kind : `#${r.material}（${r.kind}）`;
  return `规格写入预检：派单材料过不了外发闸（类别 ${r.category}，材料 ${at}，规则版本 ${r.ruleVersion.slice(0, 16)}，内容摘要 ${r.digest.slice(0, 16)}）`;
}

/**
 * The writer's hook, called inside createTask / setTask's transaction after the row is written. off → nothing runs; observe →
 * a would-block note (once per card + content + rules); on → a refusal throws so the transaction rolls back.
 */
function preflightTaskWrite(db: Database, ctx: WriteCtx, before: LedgerTask | null, after: LedgerTask): PreflightResult {
  if (!touchesMaterial(before, after)) return { status: "skipped", reason: "材料没变" };
  let decision: ReturnType<typeof decideRecovery>;
  try { decision = decideRecovery(policyPort(after.project, MECHANISM)); }
  catch (e) { decision = { kind: "skip", reason: `恢复策略读取失败，按 off：${(e as Error).message}`.slice(0, 200) }; }
  if (decision.kind === "skip") return { status: "skipped", reason: decision.reason };
  const r = preflightSpecMaterial(db, after);
  if (r.status === "unavailable" && r.reason === "error") console.error(`[spec-preflight] ${after.id} 预检不可用（无收据、不放行任何外发）`);
  if (r.status !== "blocked") return r;
  if (decision.kind === "act") throw new LedgerError("invalid", `${preflightLine(r)}；没写，规格与版本不变。${r.advice}`);
  recordObserved(db, { project: after.project, mechanism: MECHANISM, target: after.id, actionKey: `spec-preflight:${r.digest.slice(0, 24)}:${r.ruleVersion.slice(0, 12)}`,
    action: `拒绝这次规格写入：${preflightLine(r)}`, data: { preflight: { ...r, actor: ctx.actor } } }, ctx.now ?? Date.now());
  return r;
}

/** Arms the writer's hook in this process (idempotent). Importing this module arms it too, so a `ledger` CLI process always is. */
export function armSpecPreflight(): void {
  registerSpecPreflight(preflightTaskWrite);
}
armSpecPreflight();
