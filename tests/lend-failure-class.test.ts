/**
 * dispatch-recovery-MODELXP2 验收线 1：出借方只在确认属于本单当前回合时才给 release 带结构化类别。
 * 走 lend-deps failureOf 的同一条判据：turnFailureDoubt（真实 rollout 文件）→ confirmedTurnFailure → lenderFailureOf。
 */
import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { confirmedTurnFailure, failureReason, lenderFailureOf } from "../src/lib/lend-health.js";
import { turnFailureDoubt } from "../src/lib/lend-turn-failure.js";

const CYBER = "This request has been flagged for possible cybersecurity risk";
const USAGE = "API Error: Claude Code is unable to respond to this request, which appears to violate our Usage Policy";
const STARTED = Date.parse("2026-10-07T01:00:00Z"), TURN = Date.parse("2026-10-07T01:00:05Z"), FAILED = Date.parse("2026-10-07T01:10:00Z");

let dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

function rollout(turns: number[]): string {
  const dir = mkdtempSync(join(tmpdir(), "modelxp2-lend-")); dirs.push(dir);
  const path = join(dir, "rollout.jsonl");
  writeFileSync(path, turns.map((t) => JSON.stringify({ timestamp: new Date(t).toISOString(), type: "event_msg", payload: { type: "task_started" } })).join("\n") + "\n");
  return path;
}

const card = (message: string, extra: Record<string, unknown> = {}) =>
  ({ id: "ask_1", context: message, extra: { failure: "error", sessionId: "s-1", failedAt: FAILED, ...extra } });
const row = { sessionId: "s-1", startedAt: STARTED };

/** failureOf 的确认分支，原样：疑点用真实 turnFailureDoubt 判 */
const classOf = (c: ReturnType<typeof card>, r: { sessionId: string | null; startedAt: number | null } = row, turns = [TURN]) => {
  const path = rollout(turns);
  return lenderFailureOf(confirmedTurnFailure(c, turnFailureDoubt(c, r, () => path)));
};

test("cyber / usage_policy 确认属于本单 → 带 provider_policy、会话与失败时刻", () => {
  expect(classOf(card(CYBER))).toEqual({ class: "provider_policy", sessionId: "s-1", failedAt: FAILED });
  expect(classOf(card(USAGE))).toEqual({ class: "provider_policy", sessionId: "s-1", failedAt: FAILED });
  expect(classOf(card("rate limit exceeded, try later"))?.class).toBe("usage");
  expect(classOf(card("context window exhausted"))?.class).toBe("other");
});

test("失败卡属于旧回合（本单开跑之前）→ 不带", () => {
  expect(classOf(card(CYBER, { failedAt: STARTED - 1 }))).toBeNull();
});

test("换了会话 → 不带", () => {
  expect(classOf(card(CYBER, { sessionId: "s-old" }))).toBeNull();
  expect(classOf(card(CYBER), { sessionId: "s-2", startedAt: STARTED })).toBeNull();
});

test("失败之后又开了新回合 → 不带", () => {
  expect(classOf(card(CYBER), row, [TURN, FAILED + 1_000])).toBeNull();
});

test("判不了（老宿主卡没有时刻 / 会话）、额度 / 登录卡 → 不带", () => {
  expect(classOf(card(CYBER, { failedAt: undefined }))).toBeNull();
  expect(lenderFailureOf({ kind: "error", askId: "a", message: CYBER })).toBeNull();
  expect(lenderFailureOf({ kind: "quota", askId: "a", message: "usage limit" })).toBeNull();
  expect(lenderFailureOf({ kind: "auth", askId: "a", message: "login" })).toBeNull();
  expect(lenderFailureOf(undefined)).toBeNull();
});

test("原因文本照旧（不改现有字段）：原文只留本机", () => {
  const f = confirmedTurnFailure(card(CYBER), null)!;
  expect(failureReason(f)).toBe("worker 回合失败（内容策略拦截；出借方不自动重试、不换家族），没交结论；报错原文只留在出借方本机");
});
