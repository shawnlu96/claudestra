/**
 * CINOOP1 · 「核实无需改码」交付的格式与纯判定：写 / 修复单交付可带一份 noChange，交的 head 就是订单起点（不推空提交）。
 * - out_of_scope_ci：修复单，原失败 run 的链接 + 失败文件 + 理由；接收端核原审查、run 日志、PR 改动与同 head 最新 CI 后才同轮恢复；
 * - main_already_resolved：MAINRED1 生成的修 main 卡，原故障 run + 当前 main head 与它的绿 run；接收端核实后取消卡。
 * 解析严格：未知字段 / 未知 kind / 空理由 / 畸形链接一律拒，不丢不截（同 order-wire.ts 的口径）。旧调用不带 noChange 行为不变。
 * 判定与事务在 ci-no-change-recovery.ts，外部证据在 ci-no-change-evidence.ts。tests/order-no-change.test.ts。
 */
import type { Database } from "bun:sqlite";
import { readFileSync } from "node:fs";
import { specPathFor } from "./task-spec.js";
import { createHash } from "node:crypto";
import { getEventByDedup } from "./ledger-store.js";
import type { LedgerTask, LedgerEvent } from "./ledger-stages.js";

const NO_CHANGE_KINDS = ["out_of_scope_ci", "main_already_resolved"] as const;
export interface OutOfScopeCi { kind: "out_of_scope_ci"; reason: string; run: string; files: string[] }
export interface MainAlreadyResolved { kind: "main_already_resolved"; reason: string; sourceRun: string; mainHead: string; mainRun: string }
export type NoChange = OutOfScopeCi | MainAlreadyResolved;

const REASON_MAX = 1000;
const FILES_MAX = 50;
const FILE_MAX = 300;
/** Actions run 页面（可带 /attempts/N）；仓库坐标取自链接本身，接收端再与卡的仓库比 */
const RUN_URL = /^https:\/\/github\.com\/([A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9_.-]{1,100})\/actions\/runs\/(\d{1,20})(?:\/attempts\/(\d{1,4}))?$/;
const SHA40 = /^[0-9a-f]{40}$/;
const REPO_PATH = /^[\w@+-][\w./@+-]*$/;
const BAD_SINGLE = /[\p{Cc}\p{Cf}\u2028\u2029]/u;

class NoChangeError extends Error {}
const bad = (path: string, why: string): never => { throw new NoChangeError(`noChange${path ? `.${path}` : ""}：${why}`); };

export interface RunRef { repo: string; runId: number; attempt: number | null }
/** run 链接 → 仓库 / run id / attempt（链接没带 attempt = null）；不是 run 链接 = null */
export function runRef(url: string): RunRef | null {
  const m = RUN_URL.exec(url);
  if (!m) return null;
  const runId = Number(m[2]), attempt = m[3] === undefined ? null : Number(m[3]);
  if (!Number.isSafeInteger(runId) || runId < 1 || (attempt !== null && attempt < 1)) return null;
  return { repo: m[1]!.toLowerCase(), runId, attempt };
}

function reasonOf(v: unknown): string {
  if (typeof v !== "string" || !v.trim()) return bad("reason", "要写非空理由");
  if (Buffer.byteLength(v) > REASON_MAX || BAD_SINGLE.test(v)) return bad("reason", `要是单行、不超过 ${REASON_MAX} 字节`);
  return v.trim();
}
const runOf = (v: unknown, path: string): string => (typeof v === "string" && runRef(v) ? v : bad(path, "要是 https://github.com/<owner>/<repo>/actions/runs/<id> 链接"));

function filesOf(v: unknown): string[] {
  if (!Array.isArray(v) || v.length === 0 || v.length > FILES_MAX) return bad("files", `要是 1–${FILES_MAX} 个失败文件`);
  const out = v.map((f, i) => (typeof f === "string" && Buffer.byteLength(f) <= FILE_MAX && REPO_PATH.test(f) && !f.split("/").includes("..")
    ? f : bad(`files[${i}]`, "要是仓库相对路径")));
  if (new Set(out).size !== out.length) bad("files", "有重复");
  return [...out].sort();
}

function fields(r: Record<string, unknown>, keys: readonly string[]): void {
  const extra = Object.keys(r).filter((k) => !keys.includes(k));
  if (extra.length) bad("", `不认识的字段 ${extra.slice(0, 3).join(", ")}`);
  const missing = keys.filter((k) => !(k in r));
  if (missing.length) bad("", `缺字段 ${missing.join(", ")}`);
}

/** 字段顺序固定：同一份 noChange 解析后逐字节一样（幂等比的就是它） */
function read(raw: unknown): NoChange {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return bad("", "要是对象");
  const r = raw as Record<string, unknown>;
  if (r.kind === "out_of_scope_ci") {
    fields(r, ["kind", "reason", "run", "files"]);
    return { kind: r.kind, reason: reasonOf(r.reason), run: runOf(r.run, "run"), files: filesOf(r.files) };
  }
  if (r.kind === "main_already_resolved") {
    fields(r, ["kind", "reason", "sourceRun", "mainHead", "mainRun"]);
    if (typeof r.mainHead !== "string" || !SHA40.test(r.mainHead)) bad("mainHead", "要是小写完整 40 位 SHA");
    const sourceRun = runOf(r.sourceRun, "sourceRun"), mainRun = runOf(r.mainRun, "mainRun");
    if (runRef(sourceRun)!.repo !== runRef(mainRun)!.repo) bad("mainRun", "与 sourceRun 不是同一个仓库");
    return { kind: r.kind, reason: reasonOf(r.reason), sourceRun, mainHead: r.mainHead as string, mainRun };
  }
  return bad("kind", `只认 ${NO_CHANGE_KINDS.join(" / ")}`);
}

export type NoChangeRead = { ok: true; value: NoChange } | { ok: false; error: string };
export function parseNoChange(raw: unknown): NoChangeRead {
  try { return { ok: true, value: read(raw) }; } catch (e) {
    if (e instanceof NoChangeError) return { ok: false, error: e.message };
    throw e;
  }
}

/** `--no-change-file` / `ledger deliver --no-change` 的正文：JSON 文本 → 严格解析 */
export function parseNoChangeText(text: string): NoChangeRead {
  let v: unknown;
  try { v = JSON.parse(text); } catch { return { ok: false, error: "noChange 要是 JSON 对象" }; }
  return parseNoChange(v);
}

export const noChangeDigest = (nc: NoChange): string => createHash("sha256").update(JSON.stringify(nc)).digest("hex");

/** 同一单 noChange 成功结果的去重键：两个入口（出借 / 本机 CLI / MCP）都按真实单号存、按单号查 */
export const noChangeDedupKey = (orderId: string): string => `no-change:${orderId}`;
export const NO_CHANGE_DELIVER_OP = "no_change_deliver";

export type NoChangeReplay = { kind: "none" } | { kind: "conflict" } | { kind: "same"; event: LedgerEvent; outcome: "recovered" | "cancelled" };
/** 同一单的 noChange 已入账：同一份（同摘要；给了卡 / head / actor 就也要同）→ 原事件与原 outcome；换了理由 / 证据 / 人 → conflict */
export function noChangeReplay(db: Database, orderId: string, nc: NoChange, who: { taskId?: string; head?: string; actor?: string }): NoChangeReplay {
  const prev = getEventByDedup(db, noChangeDedupKey(orderId));
  if (!prev) return { kind: "none" };
  const same = prev.data.noChangeDigest === noChangeDigest(nc) && (who.taskId === undefined || prev.target === who.taskId)
    && (who.head === undefined || prev.data.noChangeHead === who.head) && (who.actor === undefined || prev.actor === who.actor);
  return same ? { kind: "same", event: prev, outcome: prev.data.op === NO_CHANGE_DELIVER_OP ? "recovered" : "cancelled" } : { kind: "conflict" };
}

// ── DeliverWire wiring（order-wire.ts parseDeliverWire）：可省、严格，同 uiEvidence / disputes 的接法 ──

export function deliverWithoutNoChange(raw: unknown): unknown {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return raw;
  const { noChange: _nc, ...rest } = raw as Record<string, unknown>;
  return rest;
}

export function deliverNoChangeFields(raw: unknown, fail: (path: string, why: string) => never): { noChange?: NoChange } {
  const value = (raw as Record<string, unknown>).noChange;
  if (value === undefined) return {};
  const r = parseNoChange(value);
  return r.ok ? { noChange: r.value } : fail("noChange", r.error);
}

/**
 * 交付 head 与订单起点的关系：不带 noChange 的同 head 拒（没有新提交）；带 noChange 却换了 head 也拒（无需改码就不该有新提交）。
 * null = 这一对能收。lend-submit（出借端）与 ledger-lend-result（接收端）各自独立核一次。
 */
export function noChangeHeadRefusal(start: string | null, head: string, nc: NoChange | undefined): string | null {
  const same = !!start && start === head;
  if (same && !nc) return "交付的 head 就是订单起点，没有新提交（核实无需改码才用 noChange 交付）";
  if (!same && nc) return "带 noChange 的交付 head 必须就是订单起点：无需改码就不该有新提交";
  return null;
}

/** out_of_scope_ci 只给修复单（CI 退回后的那一步）；main_already_resolved 开工 / 修复单都可，真伪由接收端按 MAINRED1 来源核 */
export function noChangeStepRefusal(step: string, nc: NoChange | undefined): string | null {
  if (!nc) return null;
  if (step !== "write" && step !== "fix") return "noChange 只用于开工 / 修复单";
  return nc.kind === "out_of_scope_ci" && step !== "fix" ? "out_of_scope_ci 只用于 CI 退回后的修复单" : null;
}

/** MCP deliver 的字段说明（order-tools.ts）；以上解析器才是准绳 */
export const NO_CHANGE_SCHEMA = {
  type: "object", additionalProperties: false,
  description: "核实无需改码时用（head 填订单起点，不推空提交）：out_of_scope_ci 填 reason / run（原失败 run 链接）/ files（失败文件）；" +
    "main_already_resolved（修 main 卡）填 reason / sourceRun / mainHead / mainRun。接收端核验、CI 全绿才恢复，否则回未恢复原因",
  properties: {
    kind: { type: "string", enum: [...NO_CHANGE_KINDS] }, reason: { type: "string" }, run: { type: "string" },
    files: { type: "array", items: { type: "string" }, maxItems: FILES_MAX }, sourceRun: { type: "string" }, mainHead: { type: "string" }, mainRun: { type: "string" },
  },
  required: ["kind", "reason"],
} as const;

/** Freeze resolved specification bytes at dispatch; timestamps cannot prove symlink targets stayed the same. */
export function noChangeMaterialSnapshot(task: LedgerTask, docsDir: string | null): string | null {
  const path = specPathFor(task, docsDir);
  try {
    if (!path && task.spec) return null;
    const bytes = path ? readFileSync(path) : Buffer.alloc(0);
    return createHash("sha256").update(JSON.stringify({ spec: task.spec, extra: task.extra, path })).update(bytes).digest("hex");
  } catch { return null; /* Unreadable material has no trusted snapshot; noChange admission rejects it. */ }
}
