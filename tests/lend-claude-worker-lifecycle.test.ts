import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { runClaudeWorker } from "../src/lib/lend-claude-worker-host.js";
import { archiveClaudeWorker } from "../src/lib/lend-claude-worker-archive.js";
import { CLAUDE_LEND_ROOT, claudeWorkerSessionPath, RUN_RECORD_FILE } from "../src/lib/lend-claude-worker-session.js";
import { ARCHIVE_ROOT } from "../src/lib/paths.js";
import { projectsSlug } from "../src/lib/jsonl-cost.js";
import { claudeCodeAdapter } from "../src/lib/runtimes/claude-code.js";
import { claudeWorkerPlan } from "../src/lib/lend-claude-worker.js";
import { lendCreateDenied, lendModelArgs, stopRevokedWorkers, LEND_ORDER_ENV, type StopIo } from "../src/lib/lend-grant-spawn.js";
import { lendStopReason, lendWatchdog, WATCHDOG_GRACE_MS } from "../src/lib/lend-watchdog.js";
import { advance, openLendJournal, patchOrder, recordAsked } from "../src/lib/lend-journal.js";

const cleanup: (() => void)[] = [];
afterEach(() => { for (const f of cleanup.splice(0).reverse()) f(); });

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "cc-life-"));
  cleanup.push(() => rmSync(root, { recursive: true, force: true }));
  const agent = `agent-lend-${randomUUID()}`;
  const dir = join(CLAUDE_LEND_ROOT, agent, "run-test");
  mkdirSync(dir, { recursive: true });
  cleanup.push(() => rmSync(join(CLAUDE_LEND_ROOT, agent), { recursive: true, force: true }));
  const journal = join(root, "journal.sqlite"), lendPath = join(root, "lend.json"), now = 1000;
  const entry = { peer: "a", fp: "abcd-ef01-2345-6789", families: { claude: 1, codex: 1 }, roles: ["review"], repos: ["o/r"], ordersPerDay: 10,
    grantedAt: new Date(0).toISOString(), until: new Date(86_400_000).toISOString(), codexModel: "gpt-6-astra", codexEffort: "high" };
  const grant = (enabled: boolean) => writeFileSync(lendPath, JSON.stringify({ version: 2, enabled, lend: [entry], borrow: [] }));
  grant(true);
  const db = openLendJournal(journal);
  cleanup.push(() => db.close());
  recordAsked(db, { orderId: "o1", peer: "a", fp: entry.fp, family: "claude", preview: { repo: "o/r", step: "review" } }, now);
  advance(db, "o1", "asked", "claimed", { leaseUntil: now + 60_000, leaseGen: 1 }, now);
  advance(db, "o1", "claimed", "cloned", { dir: root }, now);
  patchOrder(db, "o1", ["cloned"], { agent }, now);
  const plan = claudeWorkerPlan({ mode: "new", cwd: root, agentName: agent, channelId: "test", bridgeUrl: "ws://localhost:9", sessionId: randomUUID(), callerCredFile: "/cred" },
    dir, {}, "/fake/claude");
  return { root, agent, dir, journal, lendPath, now, grant, db, plan };
}

test("Claude 最终启动闸按本族授权；Codex 的模型/effort 不串到 Claude；收回拒起", () => {
  const f = fixture();
  const options = { journal: f.journal, lendPath: f.lendPath, now: f.now, env: { [LEND_ORDER_ENV]: "o1" } };
  expect(lendModelArgs(f.db, "o1", f.lendPath)).toEqual([]);
  expect(lendCreateDenied(f.agent, options)).toBeNull();
  expect(lendCreateDenied(f.agent, { ...options, choice: { model: "gpt-6-astra", effort: "high" } })).toContain("模型或推理档");
  f.grant(false);
  expect(lendCreateDenied(f.agent, options)).toContain("已收回");
});

test("收回授权：现有 stopRevokedWorkers 停 Claude 窗口且删除全部隔离代次", async () => {
  const f = fixture();
  f.grant(false);
  let window = true, stopped = false;
  const io: StopIo = { workers: async () => [{ name: f.agent }], stopReason: (n) => lendStopReason(n, f.journal, f.now, f.lendPath),
    isCreate: () => false, signal: () => {}, killWindows: async () => { window = false; }, probe: async () => window ? "running" : "no_window",
    markStopped: async () => { stopped = true; }, sleep: async () => {} };
  expect(await stopRevokedWorkers(io)).toEqual({ stopped: [f.agent], unconfirmed: [] });
  expect(stopped).toBe(true);
  expect(existsSync(f.dir)).toBe(false);
});

test("没确认停止时保留配置，下次确认再删", async () => {
  const f = fixture();
  f.grant(false);
  const io: StopIo = { workers: async () => [{ name: f.agent }], stopReason: () => "revoked", isCreate: () => false,
    signal: () => {}, killWindows: async () => {}, probe: async () => "unknown", markStopped: async () => {}, sleep: async () => {} };
  expect((await stopRevokedWorkers(io)).unconfirmed).toHaveLength(1);
  expect(existsSync(f.dir)).toBe(true);
});

for (const reason of ["revoke", "expired", "terminal"] as const) test(`Claude 宿主看门狗 ${reason}：停止子进程后删配置`, async () => {
  const f = fixture();
  let now = f.now, resolveExit: (code: number) => void = () => {};
  const exited = new Promise<number>((r) => { resolveExit = r; });
  const order: string[] = [];
  const why = lendWatchdog(f.agent, () => {}, f.journal, f.lendPath);
  const result = await runClaudeWorker(f.plan, { intervalMs: 5, reason: () => why(now), log: () => {},
    spawn: (p) => {
      expect(p.env.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();
      order.push("spawn");
      if (reason === "revoke") f.grant(false);
      if (reason === "expired") now += 60_001 + WATCHDOG_GRACE_MS;
      if (reason === "terminal") advance(f.db, "o1", "cloned", "released", {}, now);
      return { pid: 123, exited };
    },
    stop: async () => { order.push("stop"); resolveExit(0); },
    cleanup: () => { order.push("cleanup"); rmSync(f.dir, { recursive: true }); },
  });
  expect(result).toBe(0);
  expect(order).toEqual(["spawn", "stop", "cleanup"]);
  expect(existsSync(f.dir)).toBe(false);
});

test("起之前授权已收回：不起 Claude，删除目录", async () => {
  const f = fixture();
  f.grant(false);
  const spawned: string[] = [];
  expect(await runClaudeWorker(f.plan, { reason: () => lendStopReason(f.agent, f.journal, f.now, f.lendPath),
    spawn: () => { spawned.push("bad"); return { pid: 123, exited: Promise.resolve(0) }; }, stop: async () => {}, log: () => {},
    cleanup: () => rmSync(f.dir, { recursive: true }) })).toBe(1);
  expect(spawned).toEqual([]);
  expect(existsSync(f.dir)).toBe(false);
});

test("CLI 启动失败也清理目录", async () => {
  const f = fixture();
  await expect(runClaudeWorker(f.plan, { reason: () => null, log: () => {},
    spawn: () => { throw new Error("spawn failed"); }, stop: async () => {}, cleanup: () => rmSync(f.dir, { recursive: true }) })).rejects.toThrow("failed");
  expect(existsSync(f.dir)).toBe(false);
});

test("本机登录口径：会话在出借方默认 projects 目录，按代次记录接回读取 / 归档；清理代次后会话仍在、快照也在", async () => {
  const f = fixture();
  const home = mkdtempSync(join(tmpdir(), "cc-life-home-")); // 出借方的 HOME（假的，不写真实 ~/.claude）
  cleanup.push(() => rmSync(home, { recursive: true, force: true }));
  const session = randomUUID();
  const project = join(home, ".claude", "projects", projectsSlug(f.root));
  writeFileSync(join(f.dir, RUN_RECORD_FILE), JSON.stringify({ cwd: f.root, sessions: project }));
  mkdirSync(join(project, session, "subagents"), { recursive: true });
  const file = join(project, `${session}.jsonl`);
  writeFileSync(file, '{"type":"assistant","message":{"content":[{"type":"text","text":"done"}]}}\n');
  writeFileSync(join(project, session, "subagents", "agent-a.jsonl"), '{"type":"assistant"}\n');
  const archive = join(ARCHIVE_ROOT, f.agent);
  cleanup.push(() => rmSync(archive, { recursive: true, force: true }));
  expect(claudeWorkerSessionPath(session, f.agent)).toBe(file);
  expect(claudeWorkerSessionPath(session)).toBe(file);
  expect(claudeCodeAdapter.sessionPath(f.root, session)).toBe(file);
  await archiveClaudeWorker(f.plan, () => {});
  rmSync(f.dir, { recursive: true });
  expect(existsSync(file)).toBe(true);
  expect(readFileSync(join(archive, `${session}.jsonl`), "utf8")).toContain("done");
  expect(existsSync(join(archive, session, "subagents", "agent-a.jsonl"))).toBe(true);
  writeFileSync(join(CLAUDE_LEND_ROOT, f.agent, "run-file"), ""); // 代次目录旁的杂项文件不当代次
  mkdirSync(join(CLAUDE_LEND_ROOT, f.agent, "run-broken"), { recursive: true });
  writeFileSync(join(CLAUDE_LEND_ROOT, f.agent, "run-broken", RUN_RECORD_FILE), "{broken");
  expect(claudeWorkerSessionPath(randomUUID())).toBeNull(); // 坏记录不让普通会话查询抛错
});

test("旧版独立配置目录的会话（升级前起的 worker）照样接回读取 / 归档", async () => {
  const f = fixture();
  const session = randomUUID();
  const project = join(f.dir, "config", "projects", projectsSlug(f.root));
  mkdirSync(join(project, session, "subagents"), { recursive: true });
  const file = join(project, `${session}.jsonl`);
  writeFileSync(file, '{"type":"assistant","message":{"content":[{"type":"text","text":"done"}]}}\n');
  writeFileSync(join(project, session, "subagents", "agent-a.jsonl"), '{"type":"assistant"}\n');
  const archive = join(ARCHIVE_ROOT, f.agent);
  cleanup.push(() => rmSync(archive, { recursive: true, force: true }));
  expect(claudeWorkerSessionPath(session, f.agent)).toBe(file);
  expect(claudeCodeAdapter.sessionPath(f.root, session)).toBe(file);
  expect(claudeCodeAdapter.findSessionById(session)).toBe(file);
  await archiveClaudeWorker(f.plan, () => {});
  rmSync(f.dir, { recursive: true });
  expect(readFileSync(join(archive, `${session}.jsonl`), "utf8")).toContain("done");
  expect(existsSync(join(archive, session, "subagents", "agent-a.jsonl"))).toBe(true);
});
