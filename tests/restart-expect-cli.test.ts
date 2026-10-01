/**
 * i28-S1c r1：真实 manager CLI 走到 --expect 复核之前就被拒的分支，结果要带 skipped，监护（agent-supervisor-deps.ts restartOutcome）照 skipped 记。
 * 子进程跑真实的 manager.ts：状态、运行目录指到临时目录，PATH 前面放一个只 exit 0 的假 tmux（没有窗口），bridge 指到没人听的端口，碰不到线上。
 */
import { afterAll, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { AgentSupervisor, type SuperviseDeps } from "../src/lib/agent-supervisor.js";
import { restartOutcome } from "../src/lib/agent-supervisor-deps.js";
import { encodeExpect } from "../src/lib/agent-supervisor-expect.js";
import { priorAttempts, recordSupervise, superviseEvents } from "../src/lib/agent-supervisor-ledger.js";
import { HOUR_MS } from "../src/lib/agent-supervisor-policy.js";
import type { SchedulerConfig } from "../src/lib/scheduler-config.js";
import { markExpectSkips } from "../src/manager/restart-expect.js";
import { autoFixture, toBuild } from "./scheduler-auto-helpers.js";

const dir = mkdtempSync(join(tmpdir(), "restart-expect-cli-"));
const state = join(dir, "state"), run = join(dir, "run"), bin = join(dir, "bin");
for (const d of [state, run, bin, join(state, "locks")]) mkdirSync(d, { recursive: true });
writeFileSync(join(bin, "tmux"), "#!/bin/sh\nexit 0\n");
chmodSync(join(bin, "tmux"), 0o755);
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const AGENT = "agent-s1c-probe";
const WIRE = encodeExpect({ agent: AGENT, sessionId: "old-session", down: "no_window", workKey: "order:i1" });
const row = (extra: Record<string, unknown> = {}) => ({ sessionId: "new-session", channelId: "local-s1c", status: "active", cwd: dir, ...extra });
const registry = (agents: Record<string, unknown>) => writeFileSync(join(state, "registry.json"), JSON.stringify({ socket: "", agents }));
/** 本测试进程的 pid：pending / 锁的持有者「还活着」 */
const livePending = { op: "rename", pid: process.pid, startedAt: new Date().toISOString(), from: AGENT };

async function manager(...args: string[]): Promise<Record<string, unknown>> {
  const env: Record<string, string | undefined> = { ...process.env, PATH: `${bin}:${process.env.PATH}`, CLAUDESTRA_STATE_DIR: state,
    CLAUDESTRA_RUNTIME_DIR: run, BRIDGE_URL: "ws://127.0.0.1:9", BRIDGE_PORT: "9" };
  delete env.DISCORD_CHANNEL_ID;
  const proc = Bun.spawn([process.execPath, "--no-env-file", resolve(import.meta.dir, "../src/manager.ts"), ...args], { env, stdout: "pipe", stderr: "pipe" });
  const out = await new Response(proc.stdout).text();
  await proc.exited;
  return JSON.parse(out.trim().split("\n").pop() || "{}");
}

describe("--expect：复核前就被拒的分支也记 skipped（真实 manager CLI）", () => {
  test("会话换了且 rename 还在做：skipped；不带 --expect 原样是失败", async () => {
    registry({ [AGENT]: row({ pending: livePending }) });
    const r = await manager("restart", "--expect", WIRE, "--", AGENT);
    expect(restartOutcome(r, AGENT)).toEqual({ ok: false, skipped: expect.stringContaining("正在 rename") });
    const plain = await manager("restart", "--", AGENT);
    expect((plain.results as Record<string, unknown>[])[0]).toEqual({ name: AGENT, ok: false, error: expect.stringContaining("正在 rename") });
    expect(restartOutcome(plain, AGENT)).toEqual({ ok: false, error: expect.stringContaining("正在 rename") });
  }, 60_000);

  test("另一个 restart 拿着锁 / registry 缺 sessionId / agent 已经没了：都是 skipped", async () => {
    registry({ [AGENT]: row() });
    const lock = join(state, "locks", `restart-${AGENT}.lock`);
    writeFileSync(lock, `${process.pid}\n${Date.now()}`);
    expect(restartOutcome(await manager("restart", "--expect", WIRE, "--", AGENT), AGENT).skipped).toContain("另一个 restart");
    rmSync(lock);
    registry({ [AGENT]: row({ sessionId: undefined }) });
    expect(restartOutcome(await manager("restart", "--expect", WIRE, "--", AGENT), AGENT).skipped).toContain("缺少 sessionId");
    registry({});
    expect(restartOutcome(await manager("restart", "--expect", WIRE, "--", AGENT), AGENT).skipped).toContain("不存在");
    const gone = await manager("restart", "--", AGENT); // 不带 --expect：输出原样，没有 results
    expect(gone).toEqual({ ok: false, error: `${AGENT} 不存在` });
  }, 60_000);
});

describe("监护 → 真实 manager → 监护记账", () => {
  test("拉起后子进程撞上做到一半的 rename：记 restart/done/skipped，不占额度、不报派活方", async () => {
    const f = autoFixture();
    try {
      await toBuild(f);
      await f.tick(); // build 单发给 agent-task-one
      const name = "agent-task-one";
      registry({ [name]: row({ sessionId: "s-one", pending: { ...livePending, from: name } }) });
      const config: SchedulerConfig = { enabled: true, pollMs: 5000, autoDispatch: true, supervise: { enabled: true, stuckMin: 20 },
        projects: { p: { maxActiveWorkers: 2, requiredChecks: ["ci"], repoDir: "/tmp/repo" } } };
      let now = 10 * HOUR_MS, reports = 0;
      const wires: string[] = [];
      const deps: SuperviseDeps = {
        registry: () => [{ name, channelId: "ch-one", sessionId: "s-one", projectId: "p", runtime: "claude-code", status: "active" }],
        calls: () => [], held: () => undefined, probe: async () => "no_window", activity: () => null, overload: () => ({}),
        record: async (rec) => ({ ok: true, duplicate: recordSupervise(f.db, { actor: "scheduler", now }, rec).duplicate }),
        send: async () => ({ ok: true }),
        restart: async (agent, want) => { // 生产 restart 的同一串：eligible → manager restart --expect → restartOutcome
          const wire = encodeExpect({ agent, sessionId: want.sessionId, down: want.down, workKey: want.workKey });
          wires.push(wire);
          return want.eligible() ? { ok: false, skipped: want.eligible()! } : restartOutcome(await manager("restart", "--expect", wire, "--", agent), agent);
        },
        escalate: async () => void reports++, notifyCaller: async () => void reports++, notifyOwner: async () => void reports++,
        now: () => now, log: () => {},
      };
      const sup = new AgentSupervisor(() => {});
      for (let i = 0; i < 2; i++) { now += 31_000; await sup.tick(f.db, config, deps); }
      expect(wires).toHaveLength(1);
      const events = superviseEvents(f.db, name);
      expect(events.map((e) => `${e.step}/${e.phase}/${e.result ?? ""}`)).toEqual(["restart/claim/", "restart/done/skipped"]);
      expect(events[1].detail).toContain("正在 rename");
      expect(priorAttempts(events, "dead", events[0].workKey, now)).toEqual([]);
      expect(reports).toBe(0);
    } finally {
      f.close();
    }
  }, 60_000);
});

describe("markExpectSkips：只改复核通过之前的拒绝", () => {
  test("没过复核的失败改记 skipped；成功、已有 skipped 的不动；不带 --expect 原样", () => {
    const results: { name: string; ok: boolean; error?: string; skipped?: string }[] = [
      { name: "agent-mark-a", ok: false, error: "另一个 restart 正在进行，已跳过" },
      { name: "agent-mark-b", ok: true },
      { name: "agent-mark-c", ok: false, skipped: "已有原因", error: "x" },
    ];
    expect(markExpectSkips(results, undefined)).toBe(results);
    const marked = markExpectSkips(results, WIRE);
    expect(marked[0]).toEqual({ ...results[0], skipped: "复核前已拒：另一个 restart 正在进行，已跳过" });
    expect(marked[1]).toBe(results[1]);
    expect(marked[2]).toBe(results[2]);
  });
});
