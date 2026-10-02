/** 出借 Claude 位按本机登录判定（不要 setup-token）：探测解析、缓存、报 0 位走 QP1 同一路（poll 容量为 0 + lend status 写原因）。 */
import { afterEach, expect, test } from "bun:test";
import { getMeta } from "../src/lib/lend-journal.js";
import type { LendEntry } from "../src/lib/lend-config.js";
import {
  claudeAuthStatus, claudeLendSlots, claudeReadiness, freshClaudeReadiness, lendBlockedReason, noteClaudeReadiness, probeClaudeLend,
  refreshClaudeReadiness, CLAUDE_READY_FRESH_MS,
} from "../src/lib/lend-claude-worker-capacity.js";
import { harness } from "./lend-harness.js";

afterEach(() => noteClaudeReadiness(null));
const entry = { families: { claude: 3 } } as LendEntry;
const notFull = async () => ({ observedAt: 1, full: false, resetsAt: null });
const status = (text: string) => ({ status: async () => text, quota: notFull });

test("探测：只认 auth status 的 loggedIn；没登录 / 读不到 / 额度满都给一句原因", async () => {
  expect(await probeClaudeLend(status('{"loggedIn":true,"authMethod":"claude.ai"}'))).toBeNull();
  expect(await probeClaudeLend(status('{"loggedIn":false,"authMethod":"none"}'))).toContain("没登录");
  expect(await probeClaudeLend(status("Usage: claude [options]"))).toContain("读不到");
  expect(await probeClaudeLend(status('{"loggedIn":"yes"}'))).toContain("读不到");
  expect(await probeClaudeLend({ status: async () => { throw new Error("找不到 Claude Code CLI"); }, quota: notFull })).toBe("找不到 Claude Code CLI");
  const full = { status: async () => '{"loggedIn":true}', quota: async () => ({ observedAt: 1, full: true, resetsAt: Date.UTC(2026, 9, 2, 10) }) };
  expect(await probeClaudeLend(full)).toBe("本机 Claude 额度已满，2026-10-02T10:00:00.000Z 重置");
  const unknown = { status: async () => '{"loggedIn":true}', quota: async () => { throw new Error("no snapshot"); } };
  expect(await probeClaudeLend(unknown)).toBeNull(); // 额度读不到按未知，不挡
  await expect(claudeAuthStatus()).rejects.toThrow("测试进程"); // 测试进程不跑真 CLI
});

test("缓存：同时只探一次；新鲜期内直接给缓存；探测出错落成不可用", async () => {
  let runs = 0;
  const probe = async () => { runs++; await Bun.sleep(5); return null; };
  const [a, b] = await Promise.all([refreshClaudeReadiness(probe), refreshClaudeReadiness(probe)]);
  expect(runs).toBe(1);
  expect(a).toBe(b);
  expect(a.ready).toBe(true);
  expect(claudeReadiness()).toBe(a);
  expect(await freshClaudeReadiness()).toBe(a);
  const failed = await (noteClaudeReadiness(null), refreshClaudeReadiness(async () => { throw new Error("boom"); }));
  expect(failed).toMatchObject({ ready: false, reason: "核对本机 Claude 登录失败" }); // 原始错误不带进原因（i28-CLP）
  noteClaudeReadiness({ ready: true, reason: null, at: Date.now() - CLAUDE_READY_FRESH_MS });
  expect((await freshClaudeReadiness()).reason).toBe("测试进程不探本机 Claude 登录"); // 过期就重探
});

test("本机已登录报满位；没登录 / 还没探过报 0 位，同一原因只提示一次", () => {
  const logs: string[] = [];
  noteClaudeReadiness({ ready: true, reason: null, at: Date.now() });
  expect(claudeLendSlots(entry, (s) => logs.push(s))).toBe(3);
  expect(claudeLendSlots({ families: { codex: 2 } } as LendEntry, (s) => logs.push(s))).toBe(0);
  noteClaudeReadiness({ ready: false, reason: "本机 Claude Code 没登录", at: Date.now() });
  expect(claudeLendSlots(entry, (s) => logs.push(s))).toBe(0);
  expect(claudeLendSlots(entry, (s) => logs.push(s))).toBe(0);
  expect(logs).toEqual(["[lend] Claude 位暂不可用（报 0 位）：本机 Claude Code 没登录"]);
  noteClaudeReadiness(null);
  expect(claudeLendSlots(entry, (s) => logs.push(s))).toBe(0);
  expect(logs).toHaveLength(1);
});

test("整体借不出去才算 blocked：Codex 暂停 / 没授权且 Claude 不可用时写两边原因", () => {
  const codex = { families: { codex: 2 } } as LendEntry;
  noteClaudeReadiness({ ready: false, reason: "本机 Claude Code 没登录", at: Date.now() });
  expect(lendBlockedReason(null, [codex, entry])).toBeNull();
  expect(lendBlockedReason(null, [entry])).toBe("Claude 位不可用：本机 Claude Code 没登录");
  const until = Date.UTC(2026, 9, 2, 12);
  expect(lendBlockedReason(until, [codex])).toBe("本机 Codex 撞了额度，暂停借单到 2026-10-02T12:00:00.000Z");
  expect(lendBlockedReason(until, [codex, entry])).toBe("本机 Codex 撞了额度，暂停借单到 2026-10-02T12:00:00.000Z；Claude 位不可用：本机 Claude Code 没登录");
  noteClaudeReadiness({ ready: true, reason: null, at: Date.now() });
  expect(lendBlockedReason(until, [codex, entry])).toBeNull();
  expect(lendBlockedReason(null, [{ families: {} } as LendEntry])).toBeNull();
});

test("QP1 同一路：本机没登录时 poll 上报 Claude 0 位，lend status 写原因；登录后恢复", async () => {
  const h = harness({ entry: { families: { claude: 2 }, roles: ["review", "write"], ordersPerDay: 20 } });
  try {
    noteClaudeReadiness({ ready: false, reason: "本机 Claude Code 没登录：在出借方机器上运行 claude 完成 /login", at: Date.now() });
    await h.tick();
    expect(h.calls.filter((c) => c.op === "poll").at(-1)?.body).toMatchObject({ capacity: { families: { codex: 0, claude: 0 } } });
    expect(JSON.parse(getMeta(h.db, "status")!).blocked).toContain("本机 Claude Code 没登录");
    noteClaudeReadiness({ ready: true, reason: null, at: Date.now() });
    h.advanceTime(3600_000);
    await h.tick();
    expect(h.calls.filter((c) => c.op === "poll").at(-1)?.body).toMatchObject({ capacity: { families: { codex: 0, claude: 2 } } });
    expect(JSON.parse(getMeta(h.db, "status")!).blocked).toBeNull();
  } finally { h.db.close(); }
});
