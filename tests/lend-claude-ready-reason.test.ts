/**
 * i28-CLP r1 P2：Claude 不可用原因只用固定分类文案（CLAUDE_REASONS，额度已满可带重置时刻）。原因会进 journal meta、lend status、
 * 收单进程的 stderr（bridge 再转进自己的日志）；探测抛出的原始错误可能带本机路径和账号，一律不落盘、不转发。
 */
import { afterAll, afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { instanceKeySync, keyFingerprint } from "../src/lib/instance-key.js";
import { CLAUDE_REASONS, isClaudeReason, noteClaudeReadiness, probeClaudeLend, refreshClaudeReadiness } from "../src/lib/lend-claude-worker-capacity.js";
import { READY_KEY, sharedClaudeReadiness } from "../src/lib/lend-claude-ready.js";
import { TICK_KEY } from "../src/lib/lend-inbox.js";
import { getMeta, openLendJournal, setMeta } from "../src/lib/lend-journal.js";
import type { HttpPeer } from "../src/lib/peers.js";
import { lendInbox } from "../src/manager/lend-inbox.js";

const dir = mkdtempSync(join(tmpdir(), "lend-claude-reason-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
const SECRET = "EACCES: permission denied, open '/Users/alice/.claude/alice@example.com/.credentials.json'";
const leaks = (s: string) => s.includes("/Users/alice") || s.includes("alice@example.com") || s.includes("EACCES");
const notFull = async () => ({ observedAt: 1, full: false, resetsAt: null });
let stderr: ReturnType<typeof spyOn>;
beforeEach(() => {
  noteClaudeReadiness(null);
  stderr = spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  stderr.mockRestore();
  noteClaudeReadiness(null);
});
const stderrText = () => stderr.mock.calls.map((c: unknown[]) => c.map(String).join(" ")).join("\n");

test("探测：auth status 抛出带路径和账号的错误 → 只回「核对失败」；自己的固定错误照原样；额度读失败只打固定文案", async () => {
  expect(await probeClaudeLend({ status: async () => { throw new Error(SECRET); }, quota: notFull })).toBe(CLAUDE_REASONS.failed);
  expect(await probeClaudeLend({ status: async () => { throw new Error(CLAUDE_REASONS.noCli); }, quota: notFull })).toBe(CLAUDE_REASONS.noCli);
  expect(await probeClaudeLend({ status: async () => '{"loggedIn":true}', quota: async () => { throw new Error(SECRET); } })).toBeNull();
  expect(stderrText()).toBe("[lend] 读本机 Claude 额度失败，按未知处理");
});

test("缓存：探测拒绝、或给出分类以外的原因，都落成「核对失败」", async () => {
  expect((await refreshClaudeReadiness(async () => { throw new Error(SECRET); })).reason).toBe(CLAUDE_REASONS.failed);
  expect((await refreshClaudeReadiness(async () => SECRET)).reason).toBe(CLAUDE_REASONS.failed);
  expect((await refreshClaudeReadiness(async () => CLAUDE_REASONS.loggedOut)).reason).toBe(CLAUDE_REASONS.loggedOut);
});

test("分类：固定文案与「额度已满 + 重置时刻」认，拼了别的文字不认", () => {
  for (const ok of [...Object.values(CLAUDE_REASONS), `${CLAUDE_REASONS.quotaFull}，2026-10-02T10:00:00.000Z 重置`]) expect(isClaudeReason(ok)).toBe(true);
  for (const bad of [SECRET, `${CLAUDE_REASONS.failed}：${SECRET}`, `${CLAUDE_REASONS.quotaFull}，${SECRET}`, "", null, 1]) expect(isClaudeReason(bad)).toBe(false);
});

test("收单进程：探测抛出带路径和账号的错误 → no_slot；meta、journal 文件、stderr 里只有分类文案", async () => {
  const key = instanceKeySync(join(dir, "key"))!;
  const FP = keyFingerprint(key.publicKey);
  const journalPath = join(dir, "j.sqlite");
  const db = openLendJournal(journalPath);
  setMeta(db, TICK_KEY, String(Date.now()));
  db.close();
  const now = Date.now();
  const deps = {
    env: {}, journalPath, findPeer: async () => ({ name: "team-a", addedAt: "x", fp: FP, baseUrl: "relay://x", outToken: "t", publicKey: key.publicKey,
      e2e: { idk: "i", ek: {} } }) as unknown as HttpPeer,
    readLend: async () => ({ status: "ok" as const, file: { version: 2 as const, enabled: true, borrow: [], lend: [{ peer: "team-a", fp: FP, families: { claude: 2 },
      roles: ["review" as const], repos: ["shawnlu96/claudestra"], ordersPerDay: 50, grantedAt: new Date(now - 1000).toISOString(), until: new Date(now + 86_400_000).toISOString() }] } }),
    context: async () => ({ contacts: [{ name: "team-a", fp: FP }], projects: [] }),
    claude: { probe: async (): Promise<string | null> => { throw new Error(SECRET); } },
  };
  const order = { orderId: "c1", taskId: "T93", step: "review", family: "claude", repo: "shawnlu96/claudestra", pr: 270, head: "e".repeat(40), round: 1, specRev: 1, offeredAt: 1 };
  expect(await lendInbox(["--", "team-a", FP, JSON.stringify({ v: 1, proto: 2, orders: [order] })], deps))
    .toEqual({ ok: true, accepted: [], refused: [{ orderId: "c1", code: "no_slot" }] });
  expect(stderrText()).toBe(`[lend] Claude 位暂不可用（报 0 位）：${CLAUDE_REASONS.failed}`);
  const check = openLendJournal(journalPath);
  try {
    expect(sharedClaudeReadiness(check)).toMatchObject({ ready: false, reason: CLAUDE_REASONS.failed });
    expect(leaks(getMeta(check, READY_KEY) ?? "")).toBe(false);
  } finally { check.close(); }
  for (const f of [journalPath, `${journalPath}-wal`]) {
    let raw = "";
    try { raw = readFileSync(f, "latin1") + readFileSync(f, "utf8"); } catch { raw = ""; /* WAL 已检查点合回主库、文件不在：主库那份已经查过 */ }
    expect(leaks(raw)).toBe(false);
  }
});
