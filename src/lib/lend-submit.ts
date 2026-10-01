/**
 * `manager lend submit`：出借 worker 交结论（M3 的 submit_verdict 合入前的替身，docs/design/remote-capacity.md §2.3 第 6 步、§7）。
 * 只收 journal 里正在跑（started）的单，且调用方要对得上这张单：cwd 在这张单的工作副本里、这张单的 agent 当前会话仍是 journal 记的那个、
 * 调用进程是这个 agent 窗口里的进程（沿 ppid 往上能走到窗口的 pane 进程）。同一个 OS 用户下这防的是误投（别的会话 / 别的目录交错了单），
 * 不防伪造（同 T85 威胁模型）。结论先落 journal（result_pending + sha256），转发给 A 由调度服务做；同一份正文重交是幂等的，换了正文拒。
 * 写单（i28-R6）交的是「工作副本当前 HEAD + 一行摘要 + 自查」：HEAD 由这里读 journal 记的那个目录（不收参数），必须是新提交；
 * 落成 journal 的 work，推送、开 PR、拼交付正文都由调度服务做（lend-drive.ts publishWork）。tests/lend-submit.test.ts、tests/lend-write.test.ts。
 */
import type { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { closeSync, constants, fstatSync, openSync, readSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";
import { isWriteStep } from "./lend-git.js";
import { advance, getOrder, JournalConflict, orderOf, type LendRow } from "./lend-journal.js";
import { parseVerdictWire, type VerdictWire } from "./order-wire.js";

/** 报告正文与整个请求体的上限（T93 lend wire v1）：超了让 worker 自己精简，不截断 */
const REPORT_MAX_BYTES = 64 * 1024;
const BODY_MAX_BYTES = 96 * 1024;

export interface SubmitInput {
  verdict: string;
  /** VerdictWire 的 findings 原样（findingId / family / severity / probe / description） */
  findings: unknown;
  report: string;
}

/** 写单交活：一行摘要与自查（都进 A 的 DeliverWire：摘要 ≤ 500 字节单行，自查 ≤ 4000 字节） */
export interface WorkInput { summary: string; selfCheck: string }

/** POST /api/v1/lend/result 的请求体，整份存进 journal：A 按原始字节的 sha256 做幂等，重发必须逐字节一样 */
interface LendResultPayload {
  v: 1;
  orderId: string;
  gen: number;
  verdict: VerdictWire;
  report: string;
  session: { id: string; family: string };
}

export interface SubmitterDeps {
  cwd: string;
  pid: number;
  /** registry 里这个 agent 当前的会话 id */
  agentSession: (agent: string) => string | undefined;
  /** 这个 agent 窗口的 pane 进程（窗口 shell）；窗口不在 = null */
  panePid: (agent: string) => Promise<number | null>;
  /** pid 的祖先链（不含自己），由近到远 */
  ancestors: (pid: number) => Promise<number[]>;
  /** 这个目录里 git 的当前 HEAD（写单用）；读不到 = null */
  headOf?: (dir: string) => Promise<string | null>;
}

const realOr = (p: string): string => {
  try { return realpathSync.native(p); } catch { return p; /* 不存在的目录按原样比，比不上就拒 */ }
};

/** 调用方是不是这张单的 worker；null = 是，否则是给 worker 看的一句拒绝理由 */
async function submitterProblem(row: LendRow, d: SubmitterDeps): Promise<string | null> {
  if (!row.dir || !row.agent || !row.sessionId) return `${row.orderId} 还没起 worker（journal 状态 ${row.state}）`;
  const rel = relative(realOr(row.dir), realOr(d.cwd));
  if (rel.startsWith("..") || isAbsolute(rel)) return `当前目录不在这张单的工作副本里（应在 ${row.dir} 下运行）`;
  if (d.agentSession(row.agent) !== row.sessionId) return `${row.agent} 的当前会话已不是这张单的会话，不收`;
  const pane = await d.panePid(row.agent);
  if (!pane) return `找不到 ${row.agent} 的窗口`;
  if (!(await d.ancestors(d.pid)).includes(pane)) return `这条命令不是从 ${row.agent} 的会话里跑的，不收`;
  return null;
}

/** 按 journal 里的订单补上 orderId / head / 计数，再过一遍 order-wire 的严格校验 */
function buildPayload(row: LendRow, input: SubmitInput): { ok: true; payload: LendResultPayload; sha: string } | { ok: false; error: string } {
  const order = orderOf(row);
  const head = typeof order?.head === "string" ? order.head : null;
  if (row.leaseGen === null || !row.sessionId) return { ok: false, error: `${row.orderId} 的 journal 缺租约代数或会话` };
  if (!head) return { ok: false, error: `${row.orderId} 的订单没有 head，不能交审查结论` };
  const findings = Array.isArray(input.findings) ? input.findings : null;
  if (!findings) return { ok: false, error: "--findings 要是 JSON 数组（没有问题就写 []）" };
  const count = (sev: string) => findings.filter((f) => (f as { severity?: unknown })?.severity === sev).length;
  const parsed = parseVerdictWire({ v: 1, orderId: row.orderId, head, verdict: input.verdict, p0: count("P0"), p1: count("P1"), p2: count("P2"),
    findings, reportPath: "report.md" });
  if (!parsed.ok) return { ok: false, error: `结论不合格：${parsed.error}` };
  const bytes = Buffer.byteLength(input.report);
  if (!input.report.trim()) return { ok: false, error: "报告正文不能为空" };
  if (bytes > REPORT_MAX_BYTES) return { ok: false, error: `报告正文 ${bytes} 字节，超过 ${REPORT_MAX_BYTES}，请精简后再交（不截断）` };
  const payload: LendResultPayload = { v: 1, orderId: row.orderId, gen: row.leaseGen, verdict: parsed.value, report: input.report,
    session: { id: row.sessionId, family: row.family } };
  const raw = JSON.stringify(payload);
  if (Buffer.byteLength(raw) > BODY_MAX_BYTES) return { ok: false, error: `结论整体超过 ${BODY_MAX_BYTES} 字节，请精简报告或问题描述后再交` };
  return { ok: true, payload, sha: payloadSha(raw) };
}

/** 请求体原始字节的 sha256：A 的幂等键，也是回执里要对上的那个值 */
export const payloadSha = (raw: string): string => createHash("sha256").update(raw, "utf8").digest("hex");

export type SubmitOutcome = { ok: true; duplicate: boolean; sha: string } | { ok: false; error: string };

const SUMMARY_MAX = 500;
const SELF_CHECK_MAX = 4000;
const BAD_LINE = /[\p{Cc}\u2028\u2029]/u;
const BAD_MULTI = /[\u0000-\u0008\u000b-\u001f\u007f\u2028\u2029]/;

function workProblem(w: WorkInput): string | null {
  const summary = w.summary.trim();
  if (!summary || BAD_LINE.test(summary) || Buffer.byteLength(summary) > SUMMARY_MAX) return `摘要要是一行、非空、不超过 ${SUMMARY_MAX} 字节`;
  if (!w.selfCheck.trim() || BAD_MULTI.test(w.selfCheck) || Buffer.byteLength(w.selfCheck) > SELF_CHECK_MAX) return `自查要非空、不超过 ${SELF_CHECK_MAX} 字节、不含控制字符`;
  return null;
}

/** 写单：核调用方 → 读工作副本 HEAD（必须是新提交）→ started 推到 result_pending 带 work；同一份（head + 摘要 + 自查）重交幂等 */
export async function submitLendWork(db: Database, orderId: string, input: WorkInput, d: SubmitterDeps, now = Date.now()): Promise<SubmitOutcome> {
  const row = getOrder(db, orderId);
  if (!row) return { ok: false, error: `本机没有出借单 ${orderId}` };
  if (!isWriteStep(String(orderOf(row)?.step ?? "")) || !row.wire?.write) return { ok: false, error: `${orderId} 不是开工 / 修复单，交结论用 --verdict` };
  if (row.state !== "started" && row.state !== "result_pending") return { ok: false, error: `${orderId} 当前是 ${row.state}，不收交付` };
  const who = await submitterProblem(row, d);
  if (who) return { ok: false, error: who };
  const bad = workProblem(input);
  if (bad) return { ok: false, error: bad };
  const head = await d.headOf?.(row.dir!);
  if (!head || !/^[0-9a-f]{40}$/.test(head)) return { ok: false, error: "读不到工作副本的 HEAD（先 git commit）" };
  if (head === String(orderOf(row)?.head ?? "")) return { ok: false, error: "HEAD 还在订单起点上：先把改动 git commit 到当前分支" };
  const work = { head, summary: input.summary.trim(), selfCheck: input.selfCheck };
  const sha = payloadSha(JSON.stringify(work));
  if (row.state === "result_pending") {
    return row.work && payloadSha(JSON.stringify(row.work)) === sha ? { ok: true, duplicate: true, sha }
      : { ok: false, error: `${orderId} 已经交过一份不同的交付（或 HEAD 又动了），不能改` };
  }
  advance(db, orderId, "started", "result_pending", { work }, now);
  return { ok: true, duplicate: false, sha };
}

/** 审查单收不收结论：写单、还没起 worker / 已结束的单不收；null = 收 */
function resultRefusal(row: LendRow): string | null {
  if (isWriteStep(String(orderOf(row)?.step ?? ""))) return `${row.orderId} 是开工 / 修复单：提交后用 --summary-file / --self-check-file 交`;
  if (row.state !== "started" && row.state !== "result_pending") return `${row.orderId} 当前是 ${row.state}，不收结论`;
  return null;
}

/**
 * 公共提交核心（CLI `lend submit` 与 bridge 的 submit_verdict 共用）：调用方已证明是这张单的 worker（CLI 靠目录 + 会话 + 进程祖先，
 * MCP 靠 T85 身份 + journal 绑定）。建 payload → started 推到 result_pending（CAS）；已交过同一份 = 幂等成功，换了内容 = 拒。
 * 两个入口同时交（CAS 输了）按重读后的那一行再判一次，不会写两次。
 */
export function commitLendResult(db: Database, row: LendRow, input: SubmitInput, now = Date.now()): SubmitOutcome {
  const refused = resultRefusal(row);
  if (refused) return { ok: false, error: refused };
  const built = buildPayload(row, input);
  if (!built.ok) return built;
  if (row.state === "started") {
    try {
      advance(db, row.orderId, "started", "result_pending", { payload: built.payload as unknown as Record<string, unknown>, payloadSha: built.sha }, now);
      return { ok: true, duplicate: false, sha: built.sha };
    } catch (e) {
      if (!(e instanceof JournalConflict)) throw e;
      const cur = getOrder(db, row.orderId);
      if (!cur || cur.state !== "result_pending") return { ok: false, error: `${row.orderId} 刚变成 ${cur?.state ?? "不存在"}，不收结论` };
      row = cur;
    }
  }
  return row.payloadSha === built.sha ? { ok: true, duplicate: true, sha: built.sha }
    : { ok: false, error: `${row.orderId} 已经交过一份不同的结论（sha ${row.payloadSha?.slice(0, 12)}），不能改` };
}

/** CLI：核调用方 → 公共提交核心 */
export async function submitLendResult(db: Database, orderId: string, input: SubmitInput, d: SubmitterDeps, now = Date.now()): Promise<SubmitOutcome> {
  const row = getOrder(db, orderId);
  if (!row) return { ok: false, error: `本机没有出借单 ${orderId}` };
  const refused = resultRefusal(row);
  if (refused) return { ok: false, error: refused };
  const who = await submitterProblem(row, d);
  if (who) return { ok: false, error: who };
  return commitLendResult(db, row, input, now);
}

/**
 * 读工作副本里的报告（CLI 与 MCP 共用）：路径相对副本根，或副本内的绝对路径。拒软链（最后一段 O_NOFOLLOW、中间段解析后必须仍在副本里）、
 * 硬链（nlink > 1：可能是副本外文件的别名）、非普通文件、超过 64 KiB；打开后再比一次 inode，挡住核对与打开之间换掉目录的竞态。
 */
export function readReportIn(dir: string, reportPath: string): { ok: true; text: string } | { ok: false; error: string } {
  if (!reportPath || reportPath.includes("\0")) return { ok: false, error: "reportPath 不能为空、不能带 NUL" };
  const root = realOr(dir);
  const abs = resolve(dir, reportPath);
  let real: string;
  try { real = realpathSync.native(abs); } catch { return { ok: false, error: `读不到报告 ${reportPath}（文件不存在？）` }; }
  const inside = (p: string) => { const rel = relative(root, p); return !!rel && !rel.startsWith("..") && !isAbsolute(rel); };
  if (!inside(real)) return { ok: false, error: "报告不在这张单的工作副本里（或是指向副本外的软链），不收" };
  let fd: number;
  try { fd = openSync(abs, constants.O_RDONLY | constants.O_NOFOLLOW); } catch { return { ok: false, error: "报告打不开（软链不收）" }; }
  try {
    const st = fstatSync(fd);
    const named = statSync(real);
    if (!st.isFile()) return { ok: false, error: "报告要是普通文件" };
    if (st.nlink !== 1) return { ok: false, error: "报告是硬链接（可能是副本外文件的别名），不收；另存一份普通文件再交" };
    if (st.ino !== named.ino || st.dev !== named.dev || !inside(realOr(abs))) return { ok: false, error: "报告在核对时被换掉了，不收" };
    if (st.size > REPORT_MAX_BYTES) return { ok: false, error: `报告 ${st.size} 字节，超过 ${REPORT_MAX_BYTES}，请精简后再交（不截断）` };
    const buf = Buffer.alloc(REPORT_MAX_BYTES + 1);
    const n = readSync(fd, buf, 0, buf.length, 0);
    if (n > REPORT_MAX_BYTES) return { ok: false, error: `报告超过 ${REPORT_MAX_BYTES} 字节，请精简后再交（不截断）` };
    return { ok: true, text: buf.subarray(0, n).toString("utf8") };
  } finally { closeSync(fd); }
}

/** `ps -eo pid=,ppid=` 输出 → pid 的祖先链（纯函数；成环或断链就停） */
export function ancestorsIn(psOut: string, pid: number): number[] {
  const parent = new Map<number, number>();
  for (const line of psOut.split("\n")) {
    const m = line.trim().match(/^(\d+)\s+(\d+)$/);
    if (m) parent.set(Number(m[1]), Number(m[2]));
  }
  const out: number[] = [];
  for (let cur = parent.get(pid); cur && cur > 1 && !out.includes(cur) && out.length < 64; cur = parent.get(cur)) out.push(cur);
  return out;
}
