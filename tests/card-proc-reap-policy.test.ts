/**
 * REAPALIVE1：卡残留进程回收的档位（恢复键 cardProcReap + 环境变量紧急关闭），以及同一个服务不重启的热切档。
 * 热切档走真的退役 tick（schedulerRetireTick：巡检 + 收卡）、真台账与台账 CLI、真的恢复策略文件读法；只有进程表是假的，不发真信号。
 */
import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CARD_REAP_ENV, CARD_REAP_KEY, cardReapModeReader, cardReapPolicy } from "../src/lib/card-proc-reap-policy.js";
import { resetCardPatrolClock, type CardProcDeps, type ObserveRow } from "../src/lib/card-proc-reap.js";
import { closeLedger, openLedger } from "../src/lib/ledger-store.js";
import { createTask } from "../src/lib/ledger-write.js";
import { ORPHAN_EVERY_MS } from "../src/lib/lend-proc-reap.js";
import type { Proc, ProcPorts } from "../src/lib/proc-reap-core.js";
import { RECOVERY_KEYS, recoveryPolicy, type RecoveryPolicy, type RecoveryPolicyPort } from "../src/lib/recovery-policy.js";
import { readLiveAgents, schedulerRetireTick, type RetireDeps } from "../src/lib/scheduler-retire.js";
import { git } from "../src/lib/scheduler-review-worktree.js";
import { runLedger } from "../src/manager/ledger.js";
import type { LedgerDeps } from "../src/manager/ledger-context.js";
import type { Registry } from "../src/manager/core.js";

const cleanups: (() => void)[] = [];
afterEach(() => { for (const c of cleanups.splice(0)) c(); resetCardPatrolClock(); });

const fixed = (mode: string, extra: Partial<RecoveryPolicy> = {}): RecoveryPolicyPort =>
  () => ({ mode, manualAfterMs: null, source: "config", ...extra }) as RecoveryPolicy;

test("恢复键 cardProcReap 已登记；缺省 observe；env=off 是整机紧急关闭，env 其余值（含 on）不越过恢复键", () => {
  expect(RECOVERY_KEYS).toContain(CARD_REAP_KEY);
  const dir = mkdtempSync(join(tmpdir(), "card-reap-policy-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, "recovery-policy.json");
  const read = (project: string, env: Record<string, string | undefined> = {}) => cardReapPolicy(project, { env, policy: (p, k) => recoveryPolicy(p, k, path) });
  expect(read("p")).toEqual({ mode: "observe" }); // 没有文件
  writeFileSync(path, JSON.stringify({ projects: { p: { keys: { cardProcReap: "on" } }, q: { mode: "on", keys: { cardProcReap: "off" } }, r: { mode: "off" } } }));
  expect([read("p").mode, read("q").mode, read("r").mode, read("other").mode]).toEqual(["on", "off", "off", "observe"]);
  for (const v of ["off", " off "]) expect(read("p", { [CARD_REAP_ENV]: v })).toEqual({ mode: "off" });
  for (const v of ["on", "observe", "yes", "", "OFF"]) {
    expect([read("p", { [CARD_REAP_ENV]: v }).mode, read("q", { [CARD_REAP_ENV]: v }).mode, read("other", { [CARD_REAP_ENV]: v }).mode]).toEqual(["on", "off", "observe"]);
  }
});

test("坏策略保守 off 并带原因：文件坏、端口报错、不认识的档位、读法抛错；env=on 也救不回来", () => {
  const dir = mkdtempSync(join(tmpdir(), "card-reap-policy-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, "recovery-policy.json");
  writeFileSync(path, "{bad");
  const env = { [CARD_REAP_ENV]: "on" };
  const broken = cardReapPolicy("p", { env, policy: (p, k) => recoveryPolicy(p, k, path) });
  expect(broken.mode).toBe("off");
  expect(broken.diagnostic).toContain("读不了");
  writeFileSync(path, JSON.stringify({ projects: { p: { keys: { cardProcReap: "kill" } } } }));
  expect(cardReapPolicy("p", { env, policy: (p, k) => recoveryPolicy(p, k, path) }).mode).toBe("off");
  expect(cardReapPolicy("p", { env, policy: fixed("on", { source: "error", diagnostic: "未知恢复键" }) })).toEqual({ mode: "off", diagnostic: "未知恢复键" });
  expect(cardReapPolicy("p", { env, policy: fixed("kill") })).toEqual({ mode: "off", diagnostic: "不认识的档位 kill" });
  expect(cardReapPolicy("p", { env, policy: () => { throw new Error("磁盘没了"); } })).toEqual({ mode: "off", diagnostic: "磁盘没了" });
});

test("档位读法每次现读、不缓存；坏策略的原因同一项目只记一次，修好再坏会再记", () => {
  let now: RecoveryPolicy = { mode: "observe", manualAfterMs: null, source: "default" };
  const lines: string[] = [], env: Record<string, string | undefined> = {};
  const mode = cardReapModeReader((m) => lines.push(m), { env, policy: () => now });
  expect(mode("p")).toBe("observe");
  now = { ...now, mode: "on", source: "config" };
  expect(mode("p")).toBe("on");
  env[CARD_REAP_ENV] = "off";
  expect(mode("p")).toBe("off");
  delete env[CARD_REAP_ENV];
  now = { mode: "off", manualAfterMs: null, source: "error", diagnostic: "文件坏了" };
  expect([mode("p"), mode("p"), mode("q")]).toEqual(["off", "off", "off"]);
  expect(lines).toEqual(["卡残留进程回收按 off 停手（项目 p）：文件坏了", "卡残留进程回收按 off 停手（项目 q）：文件坏了"]);
  now = { mode: "on", manualAfterMs: null, source: "config" };
  expect(mode("p")).toBe("on");
  now = { mode: "off", manualAfterMs: null, source: "error", diagnostic: "文件坏了" };
  expect(mode("p")).toBe("off");
  expect(lines).toHaveLength(3);
});

/** 真台账 + 台账 CLI + 退役 tick；进程表是假的。档位读法就是生产那一个（cardReapModeReader），只把策略文件路径与 env 换成临时的。 */
function service() {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "card-reap-hot-"))), ledgerPath = join(dir, "ledger.sqlite"), db = openLedger(ledgerPath);
  const root = join(dir, "worktrees"), registryPath = join(dir, "registry.json"), policyPath = join(dir, "recovery-policy.json");
  mkdirSync(root);
  writeFileSync(registryPath, JSON.stringify({ socket: "", agents: {} }));
  db.query("INSERT INTO meta (project, key, value) VALUES ('p', 'pms', '[\"pm\"]') ON CONFLICT (project, key) DO UPDATE SET value = excluded.value").run();
  cleanups.push(() => { closeLedger(ledgerPath); rmSync(dir, { recursive: true, force: true }); });
  let now = 1000;
  const ledgerDeps: LedgerDeps = { db, actor: "scheduler", registryPath, projectIds: ["p", "q"], now: () => (now += 10),
    loadRegistry: async () => JSON.parse(readFileSync(registryPath, "utf8")) as Registry, saveRegistry: async () => {} };
  const live = new Map<number, Proc>(), sent: string[] = [], lines: string[] = [], notices: string[] = [], rows: ObserveRow[] = [];
  const env: Record<string, string | undefined> = {}, clock = { now: 1_000_000 };
  let lists = 0;
  const ports: ProcPorts = { uid: 501, self: 4242, list: async () => { lists++; return [...live.values()]; }, sleep: async () => {},
    signal: (pid, sig) => { sent.push(`${sig}:${pid}`); return live.delete(pid); } };
  const procs: CardProcDeps = { ports, log: (m) => lines.push(m), now: () => clock.now,
    mode: cardReapModeReader((m) => lines.push(m), { env, policy: (p, k) => recoveryPolicy(p, k, policyPath) }),
    observed: { has: (k) => rows.some((r) => r.key === k), add: (r) => void rows.push(...r) } };
  const deps: RetireDeps = { ledger: async (...args) => runLedger(args.slice(1), ledgerDeps), agent: async () => ({ ok: true }), git, exists: existsSync,
    worktreeRoot: root, notifyPm: async (_t, text) => { notices.push(text); }, agents: () => readLiveAgents(registryPath, async () => []), procs };
  const bindPeerSession = (id: string, project: string) => {
    db.query(`INSERT INTO scheduler_intents (id, taskId, project, node, action, causalSeq, taskRev, specRev, templateVersion, status, reason, createdAt, updatedAt)
      VALUES (?, ?, ?, 'restate', 'ensure_session', 0, 1, 1, 2, 'done', 'test', 0, 0)`).run(`ens:${id}`, id, project);
    db.query(`INSERT INTO scheduler_sessions (taskId, role, agent, sessionId, family, transport, state, createIntentId, createdAt, updatedAt)
      VALUES (?, 'author', ?, ?, 'claude', 'peer', 'active', ?, 0, 0)`).run(id, `peer-${id}`, `s-${id}`, `ens:${id}`);
  };
  let seq = 0;
  /** 一轮：给每个项目各放一张刚 verified 的卡（收卡入口，进程有父进程，巡检不看）和一张进行中、cwd 已删的卡（巡检入口，ppid=1），再跑一次 tick */
  const round = async () => {
    const n = ++seq, pids: Record<string, { retire: number; patrol: number }> = {};
    for (const [i, project] of ["p", "q"].entries()) {
      const done = `${project}D${n}`, open = `${project}L${n}`, base = n * 100 + i * 10;
      for (const [id, stage] of [[done, "verified"], [open, "build"]]) {
        createTask(db, { actor: "owner", now: (now += 10) }, { project, id, title: id, kind: "code", agent: `agent-${id.toLowerCase()}` });
        db.query("UPDATE tasks SET stage = ? WHERE id = ?").run(stage, id);
        if (stage === "verified") bindPeerSession(id, project); // 有没收的 session 才是退役候选；peer 的只标记，不用 archive / kill
      }
      live.set(base + 1, { pid: base + 1, ppid: 777, uid: 501, cwd: join(root, done.toLowerCase()), comm: "/opt/bin/bun", ageSec: 900 });
      live.set(base + 2, { pid: base + 2, ppid: 1, uid: 501, cwd: join(root, open.toLowerCase(), "gone"), comm: "/opt/bin/bun", ageSec: 900 });
      pids[project] = { retire: base + 1, patrol: base + 2 };
    }
    clock.now += ORPHAN_EVERY_MS;
    const before = { lists, sent: sent.length, notices: notices.length, rows: rows.length, lines: lines.length };
    const r = await schedulerRetireTick(db, ["p", "q"], deps);
    if (r.failed.length) throw new Error(JSON.stringify(r.failed));
    for (const project of ["p", "q"]) if (r.cards.find((c) => c.taskId === `${project}D${n}`)?.step !== "retired") throw new Error(JSON.stringify(r.cards));
    return { pids, lists: lists - before.lists, sent: sent.slice(before.sent), notices: notices.slice(before.notices), rows: rows.slice(before.rows).map((x) => x.pid),
      lines: lines.slice(before.lines) };
  };
  const policy = (projects: Record<string, string>) => writeFileSync(policyPath,
    JSON.stringify({ projects: Object.fromEntries(Object.entries(projects).map(([id, mode]) => [id, { keys: { [CARD_REAP_KEY]: mode } }])) }));
  return { round, policy, policyPath, env };
}

test("[REAPALIVE1 验收线 3] 同一服务不重启：按项目热切 observe / off / on，收卡与巡检两个入口都跟着变；env=off 一律停，env=on 不越过恢复键，坏策略零信号", async () => {
  const s = service();
  const a = await s.round(); // 没有策略文件：两个项目都是缺省 observe
  expect(a.sent).toEqual([]);
  expect(a.rows.sort()).toEqual([a.pids.p.retire, a.pids.p.patrol, a.pids.q.retire, a.pids.q.patrol].sort());
  expect(a.notices).toHaveLength(4); // 巡检 p / q 各一条，收卡 p / q 各一条
  expect(a.notices.every((n) => n.includes(`--key ${CARD_REAP_KEY}`))).toBe(true);

  s.policy({ p: "off", q: "observe" });
  const b = await s.round();
  expect(b.sent).toEqual([]);
  expect(b.rows.sort()).toEqual([b.pids.q.retire, b.pids.q.patrol].sort()); // p 零记录
  expect(b.notices).toHaveLength(2);
  expect(b.notices.join("\n")).not.toContain(`pid=${b.pids.p.retire}`);
  expect(b.lines.filter((l) => l.includes(`pid=${b.pids.p.retire}`) || l.includes(`pid=${b.pids.p.patrol}`) || l.includes("pD2") || l.includes("pL2"))).toEqual([]);

  s.policy({ p: "on", q: "off" });
  const c = await s.round();
  // 巡检先于收卡：p 在 observe / off 两轮留下的巡检对象这回一起收；q（含前两轮留下的）零信号
  expect(c.sent).toEqual([a.pids.p.patrol, b.pids.p.patrol, c.pids.p.patrol, c.pids.p.retire].map((pid) => `SIGTERM:${pid}`));
  expect([c.notices, c.rows]).toEqual([[], []]);
  expect(c.lines.filter((l) => l.includes("qD3") || l.includes("qL3"))).toEqual([]);

  s.policy({ p: "off", q: "off" });
  const d = await s.round();
  expect(d).toMatchObject({ lists: 0, sent: [], notices: [], rows: [], lines: [] }); // 全 off：进程表都不读

  s.policy({ p: "on", q: "on" });
  s.env[CARD_REAP_ENV] = "off";
  const e = await s.round();
  expect(e).toMatchObject({ lists: 0, sent: [], notices: [], rows: [], lines: [] }); // 整机紧急关闭压过 on

  s.policy({ p: "observe", q: "off" });
  s.env[CARD_REAP_ENV] = "on";
  const g = await s.round();
  expect(g.sent).toEqual([]); // env=on 不强制回收
  expect(g.rows.length).toBeGreaterThan(0);
  expect(g.lines.filter((l) => l.includes("qD6") || l.includes("qL6"))).toEqual([]);

  writeFileSync(s.policyPath, "{bad");
  const h = await s.round();
  expect(h).toMatchObject({ lists: 0, sent: [], notices: [], rows: [] });
  expect(h.lines).toHaveLength(2); // 每个项目记一行停手原因，之后不重复
  expect(h.lines.every((l) => l.includes("按 off 停手") && l.includes("读不了"))).toBe(true);
  expect((await s.round()).lines).toEqual([]);
});
