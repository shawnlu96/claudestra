import { afterEach, expect, spyOn, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { getMeta, getOrder, patchOrder, recordAsked } from "../src/lib/lend-journal.js";
import { claudeLendSlots, claudeReadiness, lendBlockedReason, lendPollCapacity, noteClaudeReadiness,
  probeClaudeLend, refreshClaudeReadiness } from "../src/lib/lend-claude-worker-capacity.js";
import { loopClaudeReadiness, primeInboxClaude, syncClaudeReadiness } from "../src/lib/lend-claude-ready.js";
import { claudeSessionSignal } from "../src/lib/lend-claude-pause-worker.js";
import { pauseClaude, refreshClaudePause } from "../src/lib/lend-claude-pause.js";
import { CLAUDE_LEND_ROOT, RUN_RECORD_FILE } from "../src/lib/lend-claude-worker-session.js";
import { helloBody } from "../src/lib/lend-hello.js";
import { lendDeps } from "../src/lib/lend-deps.js";
import { LedgerReader } from "../src/lib/ledger-read.js";
import { FP, harness, polled, toStarted } from "./lend-harness.js";

let clock: ReturnType<typeof spyOn> | undefined;
const journals: ReturnType<typeof harness>[] = [];
afterEach(() => { clock?.mockRestore(); noteClaudeReadiness(null); for (const h of journals.splice(0)) h.db.close(); });

const unknown = async () => ({ observedAt: null, full: null, resetsAt: null });
const api = (at: number, error: string, text: string, extra: Record<string, unknown> = {}) => JSON.stringify({
  type: "assistant", sessionId: "thr-1", timestamp: new Date(at).toISOString(), isApiErrorMessage: true, error,
  message: { model: "<synthetic>", content: [{ type: "text", text }] }, ...extra,
});
const success = (at: number, sessionId = "thr-2") => JSON.stringify({ type: "assistant", sessionId, timestamp: new Date(at).toISOString(),
  message: { model: "claude-sonnet", content: [{ type: "text", text: "正常开跑" }] } });

async function running(codex = 2) {
  const h = harness({ entry: { families: { claude: 2, codex } } });
  journals.push(h);
  clock = spyOn(Date, "now").mockImplementation(h.d.now);
  h.d.claudeProbe = () => probeClaudeLend({ status: async () => '{"loggedIn":true}', quota: unknown });
  h.A.poll = () => ({ status: 200, body: { ok: true, v: 1, orders: [{ ...polled(), family: "claude" }], pollAfterMs: 30_000 } });
  await toStarted(h);
  const row = getOrder(h.db, "o1")!;
  const dir = mkdtempSync(join(tmpdir(), "claude-pause-"));
  const run = join(CLAUDE_LEND_ROOT, row.agent!, "run");
  mkdirSync(run, { recursive: true });
  writeFileSync(join(run, RUN_RECORD_FILE), JSON.stringify({ cwd: row.dir, sessions: dir }));
  // Exercise the real production failureOf wiring while keeping worker, network and model calls stubbed.
  h.d.failure = lendDeps(h.db, new LedgerReader(join(dir, "absent.sqlite")), () => {}, undefined).failure;
  return { h, row, dir, emit: (line: string, session = "thr-1") => writeFileSync(join(dir, `${session}.jsonl`), line + "\n") };
}

test("首轮 authentication_error：下一轮停单、退租带原因、Claude 零位，Codex 不变", async () => {
  const { h, row, emit } = await running();
  emit(api(h.d.now(), "authentication_error", "API Error: OAuth token expired secret@example.invalid"));
  expect((await h.tick()).failed).toEqual([]);
  expect(getOrder(h.db, "o1")).toMatchObject({ state: "stopped" });
  const release = h.calls.find((c) => c.op === "lease" && c.body.action === "release");
  expect(release?.body).toMatchObject({ reason: "stopped" });
  expect(String(release?.body.detail)).toContain("Claude 登录失效");
  expect(String(release?.body.detail)).not.toContain("secret@");
  expect(h.log.killed).toEqual([row.agent!]);
  expect(h.log.notices.at(-1)?.kind).toBe("stopped");
  expect(lendPollCapacity(h.lend.lend[0], h.db, h.d.now()).families).toEqual({ codex: 2, claude: 0 });
  expect(getMeta(h.db, "pause:codex")).toBeNull();
  expect(lendBlockedReason(null, [{ ...h.lend.lend[0], families: { claude: 2 } }])).toContain("登录失效");
  // A new inbox process must read the same runtime pause even though shared auth status still says true.
  noteClaudeReadiness(null);
  await primeInboxClaude(h.d, { peer: "team-a", fp: FP }, [{ family: "claude" }]);
  expect(claudeLendSlots(h.lend.lend[0])).toBe(0);
  expect(helloBody(h.db, h.lend.lend[0], h.d.now()).slots.claude.total).toBe(0);
});

test("auth 重探成功后接下一单，真实 assistant 响应才清掉运行时失败", async () => {
  const { h, emit, dir } = await running(0);
  emit(api(h.d.now(), "authentication_error", "authentication_error"));
  await h.tick();
  expect(JSON.parse(getMeta(h.db, "status")!).blocked).toContain("登录失效");
  h.advanceTime(61_000);
  h.d.claudeProbe = async () => "本机 Claude Code 没登录：在出借方机器上运行 claude 完成 /login";
  await h.tick();
  expect(claudeLendSlots(h.lend.lend[0])).toBe(0);
  h.advanceTime(61_000);
  h.d.claudeProbe = async () => null;
  await h.tick();
  expect(claudeLendSlots(h.lend.lend[0])).toBe(1); // Only a trial until an actual worker response validates auth.
  expect(JSON.parse(getMeta(h.db, "pause:claude")!).auth).toBeDefined();
  recordAsked(h.db, { orderId: "o2", peer: "team-a", fp: FP, family: "claude", preview: { ...polled("o2"), family: "claude" } });
  for (let i = 0; i < 4; i++) await h.tick();
  const row2 = getOrder(h.db, "o2")!;
  expect(row2.state).toBe("started");
  patchOrder(h.db, "o2", ["started"], { sessionId: "thr-2" }, h.d.now());
  const run = join(CLAUDE_LEND_ROOT, row2.agent!, "run");
  mkdirSync(run, { recursive: true });
  writeFileSync(join(run, RUN_RECORD_FILE), JSON.stringify({ cwd: row2.dir, sessions: dir }));
  emit(success(h.d.now()), "thr-2");
  await h.tick();
  expect(JSON.parse(getMeta(h.db, "pause:claude")!).auth).toBeUndefined();
  expect(getOrder(h.db, "o2")!.state).toBe("started");
  expect(claudeLendSlots(h.lend.lend[0])).toBe(2);
});

test("额度 API 错误：停单且按原文重置；hello 和新登录探测不能缩短冷却", async () => {
  const { h, emit } = await running(0);
  const reset = 3_600_000;
  emit(api(h.d.now(), "rate_limit", "You've hit your session limit · resets 1am (UTC)"));
  await h.tick();
  expect(getOrder(h.db, "o1")!.reason).toContain("try again at 1970-01-01T01:00:00.000Z");
  expect(JSON.parse(getMeta(h.db, "pause:claude")!).quota.until).toBe(reset);
  expect(JSON.parse(getMeta(h.db, "status")!).blocked).toContain("额度已满");
  h.advanceTime(61_000);
  noteClaudeReadiness(null);
  await loopClaudeReadiness(h.db, h.lend.lend, async () => null);
  for (let i = 0; i < 3; i++) expect(helloBody(h.db, h.lend.lend[0], h.d.now()).slots.claude.total).toBe(0);
  expect(JSON.parse(getMeta(h.db, "pause:claude")!).quota.until).toBe(reset);
  h.advanceTime(reset - h.d.now());
  await h.tick();
  expect(claudeLendSlots(h.lend.lend[0])).toBe(2);
  expect(helloBody(h.db, h.lend.lend[0], h.d.now()).slots.claude.total).toBe(2);
});

test("新额度快照可延长或提前恢复；未知/旧快照不解闸", async () => {
  const { h, row } = await running();
  const at = h.d.now();
  const f = { kind: "quota" as const, askId: "q", message: "quota", resetsAt: at + 90_000 };
  pauseClaude(h.db, row, f, at);
  refreshClaudePause(h.db, { observedAt: at, full: false, resetsAt: null }, at + 1);
  expect(claudeLendSlots(h.lend.lend[0])).toBe(0);
  refreshClaudePause(h.db, { observedAt: at + 1, full: true, resetsAt: at + 180_000 }, at + 1);
  expect(JSON.parse(getMeta(h.db, "pause:claude")!).quota.until).toBe(at + 180_000);
  refreshClaudePause(h.db, { observedAt: at + 2, full: true, resetsAt: at + 30_000 }, at + 2);
  expect(JSON.parse(getMeta(h.db, "pause:claude")!).quota.until).toBe(at + 180_000);
  refreshClaudePause(h.db, { observedAt: at + 3, full: null, resetsAt: null }, at + 3);
  expect(claudeLendSlots(h.lend.lend[0])).toBe(0);
  refreshClaudePause(h.db, { observedAt: at + 4, full: false, resetsAt: null }, at + 4);
  expect(claudeLendSlots(h.lend.lend[0])).toBe(2);
  pauseClaude(h.db, row, f, at + 5); // Same JSONL failure while kill retries cannot re-arm the old window.
  expect(claudeLendSlots(h.lend.lend[0])).toBe(2);
});

test("kill 未确认退出时保留 started，下轮重试，不滑动暂停截止", async () => {
  const { h, emit } = await running();
  const kill = h.d.worker.kill;
  h.d.worker.kill = async () => ({ ok: false, reason: "暂不可确认" });
  emit(api(h.d.now(), "rate_limit", "You've hit your usage limit"));
  await h.tick();
  const until = JSON.parse(getMeta(h.db, "pause:claude")!).quota.until;
  expect(getOrder(h.db, "o1")!.state).toBe("started");
  h.advanceTime(61_000);
  await h.tick();
  expect(JSON.parse(getMeta(h.db, "pause:claude")!).quota.until).toBe(until);
  h.d.worker.kill = kill;
  await h.tick();
  expect(getOrder(h.db, "o1")!.state).toBe("stopped");
});

test("bootstrap 在 create 返回前就失败、首条派单还没送达：仍立即退单", async () => {
  const { h, emit } = await running();
  emit(api(h.d.now(), "authentication_failed", "Invalid API key · Please run /login"));
  h.advanceTime(1000);
  patchOrder(h.db, "o1", ["started"], { startedAt: h.d.now(), submit: null }, h.d.now());
  const sent = h.log.sent.length;
  await h.tick();
  expect(getOrder(h.db, "o1")!.state).toBe("stopped");
  expect(h.log.sent).toHaveLength(sent);
});

test("探测途中撞 auth：旧探测晚返回 true 不能覆盖暂停", async () => {
  const { h, row } = await running();
  let done!: (reason: null) => void;
  const probing = refreshClaudeReadiness(() => new Promise((resolve) => { done = resolve; }));
  h.advanceTime(1);
  pauseClaude(h.db, row, { kind: "auth", askId: "auth", message: "authentication_error" }, h.d.now());
  h.advanceTime(1);
  done(null);
  await probing;
  syncClaudeReadiness(h.db);
  expect(claudeReadiness()?.ready).toBe(false);
});

test("只认当前 worker 的 API 错误，不认正文、旧会话、旧轮次、sidechain、临时限流", () => {
  const row = { sessionId: "thr-1", createdAt: 1000 };
  const line = api(2000, "authentication_error", "API Error authentication_error");
  expect(claudeSessionSignal(line, row, 2000).failure?.kind).toBe("auth");
  expect(claudeSessionSignal(api(2000, "unknown", "OAuth token refresh failed"), row, 2000).failure?.kind).toBe("auth");
  for (const extra of [{ type: "user" }, { type: "tool" }, { isApiErrorMessage: false }, { isSidechain: true }, { sessionId: "wrong" }]) {
    expect(claudeSessionSignal(api(2000, "authentication_error", "authentication_error", extra), row, 2000).failure).toBeUndefined();
  }
  expect(claudeSessionSignal(api(999, "authentication_error", "authentication_error"), row, 2000).failure).toBeUndefined();
  expect(claudeSessionSignal(api(2000, "rate_limit", "API Error: 429 This request would exceed your account's rate limit"), row, 2000).failure).toBeUndefined();
  expect(claudeSessionSignal(line + "\n" + success(2001, "thr-1"), row, 2001)).toEqual({ successAt: 2001 });
  expect(claudeSessionSignal('{"type":"assistant"', row, 2000)).toEqual({});
});
