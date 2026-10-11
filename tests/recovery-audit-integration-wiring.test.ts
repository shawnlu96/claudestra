/**
 * dispatch-recovery-AUD 的生产接线证据（审查 runtime-unwired）：不测叶子函数本身，只证「生产入口真的把 CFG 接到了它」。
 * - localDelivery：调度一轮的真实入口 autostartHooks().resume → autoResumeTick → 真 git ls-remote 核 origin head → 真实调度身份 CLI
 *   `scheduler-auto-resume --checked-head`（事务里按 CFG 再判）。on 交回恰好一次，observe / off 一次 CLI 都不调，origin 不符不交回。
 * - askReminder：bridge 的真实入口 initAskWiring（子进程，独立状态目录）之后，真实过期扫描 sweepExpired 按策略文件走 on / observe / off。
 * localFallback 不在这里：PM 10-11 定它归跟进节点 AUDW1，生产仍未接（见 recovery-audit-integration.test.ts 钉住的现状）。
 * 临时台账 / 临时 git 仓库 / 临时状态目录；不连 bridge、不碰生产状态。
 */
import type { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { confirmOrderDelivery } from "../src/lib/ledger-autostart-resume.js";
import { getWorkflow } from "../src/lib/ledger-scheduler.js";
import { setWorkflow } from "../src/lib/ledger-scheduler-write.js";
import { closeLedger, getTask, listEvents, openLedger } from "../src/lib/ledger-store.js";
import { setMeta } from "../src/lib/ledger-write.js";
import { deliverOrder } from "../src/lib/order-deliver.js";
import type { VerifiedCall } from "../src/lib/order-tool-route.js";
import { RECOVERY_POLICY_PATH, type RecoveryMode } from "../src/lib/recovery-policy.js";
import { autostartHooks } from "../src/lib/scheduler-autostart-deps.js";
import { parseSchedulerConfig } from "../src/lib/scheduler-config.js";
import type { Registry } from "../src/manager/core.js";
import { runLedger } from "../src/manager/ledger.js";
import { testChildEnv } from "./test-env.js";

const P = "p1", T = "DEL1", PM = "agent-lead", DISP = "agent-disp", DEV = "agent-task-del1", BR = "feat/del1", INTENT = "disp:DEL1:write:a0";
const PR = "https://github.com/o/r/pull/9";
const me: VerifiedCall = { agent: DEV, sessionId: "s1", family: "claude-code", channelId: "c-dev" };
const channels: Record<string, string> = { "c-lead": PM, "c-dev": DEV, "c-disp": DISP };
const tmp = (pre: string) => mkdtempSync(join(tmpdir(), pre));

function git(cwd: string, ...args: string[]): string {
  const r = Bun.spawnSync(["git", "-c", "user.name=aud", "-c", "user.email=aud@example.invalid", "-c", "commit.gpgsign=false", ...args], { cwd });
  if (r.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr.toString()}`);
  return r.stdout.toString().trim();
}

describe("localDelivery：调度入口 → 核 origin head → 调度身份 CLI", () => {
  let db: Database, now: number, repo: string, head: string, calls: string[][], saved: Buffer | null;
  const policyFile = (mode: RecoveryMode) => writeFileSync(RECOVERY_POLICY_PATH, JSON.stringify({ projects: { [P]: { keys: { localDelivery: mode } } } }));
  const ledger = (actor: string, ...args: string[]) => {
    const reg = { socket: "", agents: Object.fromEntries([PM, DEV, DISP].map((a) => [a, { status: "active", projectId: P }])) } as unknown as Registry;
    return runLedger(args, { db, actor, actorProject: P, projectIds: [P], loadRegistry: async () => structuredClone(reg), saveRegistry: async () => {},
      now: () => now++, autoDispatch: () => true, autoProjects: () => [P] }) as Promise<Record<string, any>>;
  };
  const card = () => getTask(db, T)!, wf = () => getWorkflow(db, T)!;
  const resumes = () => listEvents(db, { target: T }).filter((e) => e.data.op === "workflow_resume");
  const config = () => parseSchedulerConfig({ enabled: true, pollMs: 5000, autoDispatch: true, projects: { [P]: { maxActiveWorkers: 4, requiredChecks: ["ci"], repoDir: repo } } });
  /** 生产接线原样：只把调度身份 CLI 换成进程内的真实 runLedger（并记下每次调用），其余端口都是 autostartHooks 自己接的 */
  const tick = () => autostartHooks({ db, active: () => {}, lease: undefined, ledger: (...args) => { calls.push(args); return ledger("scheduler", ...args.slice(1)); } })
    .resume(config(), { yieldNow: () => false, cursor: {} });

  beforeEach(async () => {
    now = Date.now() - 60_000; // 生产接线按真实时钟判授予有效期
    calls = [];
    saved = existsSync(RECOVERY_POLICY_PATH) ? readFileSync(RECOVERY_POLICY_PATH) : null;
    // 真仓库：origin 是本地裸仓库，卡的分支推在上面
    const bare = tmp("aud-wire-origin-");
    repo = tmp("aud-wire-repo-");
    git(bare, "init", "--bare", "-q");
    git(repo, "init", "-q");
    git(repo, "remote", "add", "origin", bare);
    git(repo, "commit", "-q", "--allow-empty", "-m", "base");
    git(repo, "checkout", "-q", "-b", BR);
    git(repo, "commit", "-q", "--allow-empty", "-m", "work");
    git(repo, "push", "-q", "origin", BR);
    head = git(repo, "rev-parse", "HEAD");
    db = openLedger(":memory:");
    setMeta(db, { actor: "owner", now: 1 }, { project: P, key: "pms", value: [PM, DISP] });
    setMeta(db, { actor: "owner", now: 2 }, { project: P, key: "team", value: { dispatcher: DISP, audit: true } });
    // auto 卡在 build（有 done 的写派单与作者绑定）→ PM 接管成 manual → 真 PM 授予 → 执行者本人经正式单交付（同 tests/order-local-deliver.test.ts）
    await ledger(PM, "item-new", "i1", "--title", "底座");
    await ledger(PM, "task-new", T, "--title", "DEL", "--kind", "code", "--item", "i1", "--agent", DEV, "--branch", BR, "--pr", PR);
    setWorkflow(db, { actor: PM, now: now++ }, { taskId: T, taskRev: card().rev, template: "code", templateVersion: 2, mode: "auto", authorFamily: "claude", fallback: "PM 接管" });
    db.query("UPDATE tasks SET stage = 'build' WHERE id = ?").run(T);
    db.query(`INSERT INTO events (ts, actor, project, target, kind, text, data) VALUES (?, 'scheduler', ?, ?, 'stage', '', '{"from":"restate","to":"build"}')`).run(now++, P, T);
    const seq = (db.query("SELECT MAX(seq) AS s FROM events").get() as { s: number }).s;
    db.query(`INSERT INTO scheduler_intents (id, taskId, project, node, action, causalSeq, eventSeq, taskRev, specRev, head, templateVersion, status, reason, createdAt, updatedAt)
      VALUES (?, ?, ?, 'write', 'dispatch', 1, ?, ?, ?, NULL, 2, 'done', 'write', 1, 1)`).run(INTENT, T, P, seq + 1, card().rev, card().specRev);
    db.query(`INSERT INTO scheduler_sessions (taskId, role, agent, sessionId, family, transport, state, createIntentId, createdAt, updatedAt)
      VALUES (?, 'author', ?, 's1', 'claude', 'tmux', 'active', ?, 1, 1)`).run(T, DEV, INTENT);
    setWorkflow(db, { actor: PM, now: now++ }, { taskId: T, taskRev: card().rev, workflowRev: wf().rev, template: "code", templateVersion: 2, mode: "manual",
      authorFamily: "claude", fallback: "PM 接管", reason: "外发闸拒，留本机" });
    expect(await ledger(PM, "resume-grant", T, "--rev", String(card().rev), "--workflow-rev", String(wf().rev), "--reason", "外发闸拒，本机修")).toMatchObject({ ok: true });
    expect(await deliverOrder(me, { v: 1, orderId: INTENT, head, evidence: "docs/tasks/DEL1.md", summary: "交付", selfCheck: "过" }, {
      db, run: (args, ch) => ledger(channels[ch] ?? "unknown", ...args.slice(1)), confirmSource: (c, input) => confirmOrderDelivery(db, c, input),
      remoteHead: async () => ({ ok: true, head }), findPr: async () => ({ ok: true, rows: [{ url: PR, headRefOid: head, baseRefName: "main", isCrossRepository: false }] }),
    })).toMatchObject({ ok: true, stage: "review" });
    expect(wf().mode).toBe("manual");
  });
  afterEach(() => {
    closeLedger(":memory:");
    if (saved === null) rmSync(RECOVERY_POLICY_PATH, { force: true });
    else writeFileSync(RECOVERY_POLICY_PATH, saved);
  });

  test("on：核过 origin head 后经 --checked-head 交回，恰好一次；再跑一轮不再调", async () => {
    policyFile("on");
    expect(await tick()).toEqual([]);
    expect(calls).toEqual([["ledger", "scheduler-auto-resume", T, "--rev", expect.any(String), "--workflow-rev", expect.any(String), "--max-workers", "4", "--checked-head", head]]);
    expect(wf().mode).toBe("auto");
    expect(resumes().map((e) => [e.actor, e.data.auto, typeof e.data.grant])).toEqual([["scheduler", true, "string"]]);
    expect(await tick()).toEqual([]);
    expect([calls.length, resumes().length]).toEqual([1, 1]);
  });

  test("observe（缺配置也是它）/ off：一次 CLI 都不调，卡留在 manual", async () => {
    for (const mode of ["observe", "off", null] as const) {
      if (mode) policyFile(mode);
      else rmSync(RECOVERY_POLICY_PATH, { force: true });
      expect(await tick()).toEqual([]);
    }
    expect([calls, wf().mode, resumes()]).toEqual([[], "manual", []]);
  });

  // 放在几条 tick 用例的最后：被拒的这次交付会记进接线的进程内去重表（同一交付不再试）
  test("on 但 origin 上的分支不是交付的那个 head：真 ls-remote 查出不符，不调 CLI、不交回", async () => {
    policyFile("on");
    git(repo, "commit", "-q", "--allow-empty", "-m", "别人又推了");
    git(repo, "push", "-q", "origin", BR);
    await tick(); // 通知 PM 走不通（测试里没有 bridge）只会进 failed，不影响判定
    expect([calls, wf().mode, resumes()]).toEqual([[], "manual", []]);
  });

  test("CLI 事务自己也按 CFG 判：策略不是 on 时带着 --checked-head 也不交回；不带的照旧 not_eligible", async () => {
    const run = (...extra: string[]) => ledger("scheduler", "scheduler-auto-resume", T, "--rev", String(card().rev), "--workflow-rev", String(wf().rev), "--max-workers", "4", ...extra);
    policyFile("observe");
    expect(await run("--checked-head", head)).toMatchObject({ ok: false, code: "not_eligible" });
    policyFile("on");
    expect(await run()).toMatchObject({ ok: false, code: "not_eligible" });
    expect(await run("--checked-head", "f".repeat(40))).toMatchObject({ ok: false, code: "not_eligible" });
    expect(wf().mode).toBe("manual");
    expect(await run("--checked-head", head)).toMatchObject({ ok: true });
    expect(wf().mode).toBe("auto");
  });
});

describe("askReminder：bridge 入口 initAskWiring 之后的真实过期扫描", () => {
  /** 子进程里起 initAskWiring，建一条已到点的阻塞授权 ask，跑一次 sweepExpired；返回开出的再提示卡数与 observe 日志数 */
  async function sweep(mode: RecoveryMode | null): Promise<{ reminders: number; observed: number; original: string }> {
    const dir = tmp("aud-wire-ask-");
    if (mode) writeFileSync(join(dir, "recovery-policy.json"), JSON.stringify({ projects: { p: { keys: { askReminder: mode } } } }));
    const script = `
      const logs = []; const log = console.log; console.log = (...a) => { logs.push(String(a[0])); };
      const { initAskWiring } = await import("./src/bridge/ask-entry.ts");
      const { sweepExpired } = await import("./src/bridge/ask-expire.ts");
      const { ownerPresence } = await import("./src/bridge/asks.ts");
      const { openLedger, LEDGER_PATH } = await import("./src/lib/ledger-store.ts");
      const { listAsks, openAsk } = await import("./src/lib/ledger-asks.ts");
      initAskWiring({ clients: new Map([["111", { ws: {} }]]), controlChannelId: "fixture", hold: () => {}, discord: null,
        deliver: async (env) => ({ envelope: env, outcome: { kind: "sent" } }) });
      ownerPresence.setVisible("dev_aud", true);
      const db = openLedger(LEDGER_PATH), t = Date.now();
      const a = openAsk(db, { project: "p", source: "reply", kind: "authorize", title: "发版吗", fromAgent: "agent-x", fromChannelId: "111", blocking: true,
        options: [{ id: "go", label: "发" }], chatId: "api:owner:self", expiresAt: t + 600_000 }, t - 600_000);
      db.run("UPDATE asks SET expiresAt = ? WHERE id = ?", [t - 1000, a.id]);
      await sweepExpired();
      const all = listAsks(db);
      log("RESULT " + JSON.stringify({ reminders: all.filter((x) => x.extra.recoveryOf === a.id).length,
        observed: logs.filter((l) => l.includes("[askReminder observe]")).length, original: all.find((x) => x.id === a.id).state }));
      process.exit(0);
    `;
    const proc = Bun.spawn([process.execPath, "--no-env-file", "-e", script], { cwd: join(import.meta.dir, ".."),
      env: testChildEnv({ HOME: tmp("aud-wire-home-"), TMPDIR: tmp("aud-wire-tmp-"), CLAUDESTRA_STATE_DIR: dir, CLAUDESTRA_RUNTIME_DIR: join(dir, "run"), DISCORD_CHANNEL_ID: "" }),
      stdout: "pipe", stderr: "pipe" });
    const [stdout, stderr, exit] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
    const line = stdout.split("\n").find((l) => l.startsWith("RESULT "));
    expect({ exit, line: !!line, stderr: line ? "" : stderr }).toEqual({ exit: 0, line: true, stderr: "" });
    return JSON.parse(line!.slice(7));
  }

  test("on 开一张再提示卡；observe 与缺配置只记 observe 日志；off 什么都不做", async () => {
    const [on, observe, unset, off] = await Promise.all([sweep("on"), sweep("observe"), sweep(null), sweep("off")]);
    expect(on).toEqual({ reminders: 1, observed: 0, original: "expired" });
    expect(observe).toEqual({ reminders: 0, observed: 1, original: "expired" });
    expect(unset).toEqual({ reminders: 0, observed: 1, original: "expired" });
    expect(off).toEqual({ reminders: 0, observed: 0, original: "expired" });
  }, 60_000);
});
