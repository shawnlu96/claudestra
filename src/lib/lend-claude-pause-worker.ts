/** Read only this leased worker's JSONL API failures; hooks and supervisor cards are not involved. */
import type { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { closeSync, fstatSync, openSync, readSync } from "node:fs";
import { claudeWorkerSessionPath } from "./lend-claude-worker-session.js";
import { translateSessionLine } from "./session-source.js";
import { liveOrders, type LendRow } from "./lend-journal.js";
import type { LendDeps } from "./lend-drive.js";
import type { CodexFailureSeen } from "./lend-health.js";
import { parseWallText } from "./quota-wall-text.js";
import { CLAUDE_AUTH_FAILURE, claudeWorkerRecovered, pauseClaude, type ClaudeFailure } from "./lend-claude-pause.js";

const TAIL_BYTES = 256 * 1024;
const AUTH = /authentication_(?:error|failed)|invalid api key|OAuth[^\n]{0,100}(?:expired|revoked|refresh[^\n]{0,60}fail)|(?:failed|unable) to refresh[^\n]{0,60}(?:token|auth)/i;

/** A real assistant response after the error wins; user/tool text and synthetic bootstrap replies never do. */
export function claudeSessionSignal(text: string, row: Pick<LendRow, "sessionId" | "createdAt">, now: number):
  { failure?: ClaudeFailure; successAt?: number } {
  for (const line of text.split("\n").reverse()) {
    const rec = translateSessionLine("claude-code", line);
    if (!rec || rec.type !== "assistant" || rec.isSidechain === true || (rec.sessionId && rec.sessionId !== row.sessionId)) continue;
    const at = Date.parse(String(rec.timestamp ?? ""));
    // Bootstrap can fail before manager create returns and records startedAt; the session ID already pins this worker.
    if (Number.isFinite(at) && at < row.createdAt) continue;
    const content = rec.message?.content;
    const body = typeof content === "string" ? content : Array.isArray(content)
      ? content.filter((c) => c?.type === "text").map((c) => String(c.text ?? "")).join("\n") : "";
    if (rec.isApiErrorMessage !== true) {
      if (rec.message?.model && rec.message.model !== "<synthetic>" && !rec.error && Number.isFinite(at)) return { successAt: at };
      continue;
    }
    const error = typeof rec.error === "string" ? rec.error : JSON.stringify(rec.error ?? "");
    const auth = AUTH.test(`${error}\n${body}`);
    const wall = /^(?:rate_limit|rate_limit_error)$/.test(error) ? parseWallText(body, Number.isFinite(at) ? at : now) : null;
    if (!auth && !wall) continue;
    const key = createHash("sha256").update(line).digest("hex").slice(0, 16);
    // Only a fixed category and parsed timestamp leave the session file; API text can contain account details or credentials.
    const resets = wall?.resetsAt;
    return { failure: { kind: auth ? "auth" : "quota", askId: `claude:${row.sessionId}:${key}`, resetsAt: resets,
      message: auth ? CLAUDE_AUTH_FAILURE : `You've hit your usage limit.${resets ? ` try again at ${new Date(resets).toISOString()}` : ""}` } };
  }
  return {};
}

/** Bounded read; partial first/last lines are skipped by the session adapter until the writer finishes them. */
function sessionTail(path: string): string {
  const fd = openSync(path, "r");
  try {
    const size = fstatSync(fd).size;
    const len = Math.min(size, TAIL_BYTES);
    const buf = Buffer.alloc(len);
    const n = readSync(fd, buf, 0, len, size - len);
    const text = buf.subarray(0, n).toString("utf8");
    return size > len ? text.slice(text.indexOf("\n") + 1) : text;
  } finally { closeSync(fd); }
}

/** The journal's session identity is authoritative: a recycled registry name cannot select another session. */
export function lendWorkerFailureOf(db: Database, agent: string, codex: () => CodexFailureSeen | undefined,
  now = Date.now(), pathOf = claudeWorkerSessionPath): ClaudeFailure | undefined {
  const row = liveOrders(db).find((r) => r.agent === agent && r.state === "started");
  if (row?.family !== "claude") return codex();
  if (!row?.sessionId) return undefined;
  let signal: ReturnType<typeof claudeSessionSignal>;
  try {
    const path = pathOf(row.sessionId, agent);
    if (!path) return undefined;
    signal = claudeSessionSignal(sessionTail(path), row, now);
  } catch (e) {
    console.error(`[lend] 读 Claude worker 会话失败（${(e as NodeJS.ErrnoException).code ?? "unknown"}），下轮重试`);
    return undefined;
  }
  if (signal.successAt !== undefined) claudeWorkerRecovered(db, row, signal.successAt);
  return signal.failure;
}

type Finish = (row: LendRow, to: "stopped", why: string, d: LendDeps, notify: boolean) => Promise<void>;

/** Keep drive's existing Codex branch intact, and use the same stop/release settlement for Claude. */
export async function leasedWorkerFailure(row: LendRow, d: LendDeps, finish: Finish): Promise<CodexFailureSeen | true | undefined> {
  const f = d.failure(row.agent!);
  if (row.family !== "claude" || !f) return f;
  const until = pauseClaude(d.db, row, f, d.now());
  const message = f.kind === "quota" && until !== null ? `You've hit your usage limit. try again at ${new Date(until).toISOString()}` : f.message;
  const reason = `worker 的 Claude ${f.kind === "auth" ? "登录失效" : "额度已满"}，没交结论：${message}`;
  d.log(`${row.orderId} ${reason}`);
  await finish(row, "stopped", reason, d, true);
  return true;
}
