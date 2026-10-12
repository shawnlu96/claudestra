/**
 * agents-PMAUTO1 观察期登记与到期核对（lib/observation-plan*.ts、manager/ledger-observation-cmds.ts）。只用合成台账、假时钟和临时目录。
 * 验收线 1：到期全满足才切指定目标并记一条 note；2：零样本 / error / 误判 / 证据缺或不完整各只交 PM 一次；
 * 4：人工切 off、改规格、重新 verified、换授权、并发标误判都挡住陈旧登记，发布后崩溃重启只补 note，发布失败不记成功，整机与额度目标拒登记。
 */
import type { Database } from "bun:sqlite";
import { beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { acquireLock } from "../src/lib/file-lock.js";
import { setAutostartSwitch } from "../src/lib/ledger-autostart.js";
import { LedgerError, listEvents, openLedger } from "../src/lib/ledger-store.js";
import { appendEvent, createTask, setMeta } from "../src/lib/ledger-write.js";
import { autoMode, parseTarget, readPlans, targetState } from "../src/lib/observation-plan.js";
import { p2BacklogMode } from "../src/lib/p2-backlog-mode.js";
import type { DueOpts } from "../src/lib/observation-plan-due.js";
import { observationTickAt } from "../src/lib/observation-plan-tick.js";
import { recoveryPolicy, setRecovery } from "../src/lib/recovery-policy.js";
import { readSwitch } from "../src/lib/scheduler-autostart.js";
import type { SpecWaitEnv } from "../src/lib/scheduler-spec-wait.js";
import type { Registry } from "../src/manager/core.js";
import { AUTOSTART_CMDS } from "../src/manager/ledger-autostart-cmds.js";
import { LedgerCli, type LedgerDeps } from "../src/manager/ledger-context.js";
import { parseLedgerArgs } from "../src/manager/ledger-identity.js";
import { observationCmds } from "../src/manager/ledger-observation-cmds.js";
import { tempLedgerPath } from "./ledger-test-helpers.js";

const PM = "agent-pm", DISP = "agent-helper", EXEC = "agent-exec", H = 3_600_000, T0 = 1_760_000_000_000, DUE = T0 + 24 * H;
const TARGET = "recovery:dagWriteScrub";
let db: Database, plans: string, recovery: string, clock: number, extra: DueOpts;
const owner = (now: number) => ({ actor: "owner", now });

/** 直接写一条事件（观察记录 / 结构化错误 / stage），时间由测试定 */
function ev(ts: number, kind: string, data: Record<string, unknown>, target = "", project = "a"): number {
  return (db.prepare("INSERT INTO events (ts, actor, project, target, kind, text, data) VALUES (?, 'scheduler', ?, ?, ?, '', ?) RETURNING seq")
    .get(ts, project, target, kind, JSON.stringify(data)) as { seq: number }).seq;
}
const observed = (ts: number) => ev(ts, "feature", { op: "dag-rewrite", dagWriteScrub: "这一版推不出去：nodes[0].title" });
const verified = (ts: number) => ev(ts, "stage", { from: "live", to: "verified" }, "T1");

async function run(actor: string, sub: string, ...args: string[]): Promise<Record<string, any>> {
  const spec = observationCmds({ plans, recovery, lockMs: 4000, readSpec: () => ({ text: "# T1\n\n## 上线后 PM\n观察期：24 小时\n核一下\n" }), ...extra })[sub]!;
  const p = parseLedgerArgs([sub, ...args], spec.valued, spec.bools);
  if ("error" in p) return { ok: false, code: "invalid", error: p.error };
  const deps: LedgerDeps = { db, actor, projectIds: ["a", "b"], now: () => clock, loadRegistry: async () => ({ socket: "s", agents: {} }) as Registry, saveRegistry: async () => {} };
  try { return await spec.run(new LedgerCli(deps, p)); }
  catch (e) { if (e instanceof LedgerError) return { ok: false, code: e.code, error: e.message }; throw e; }
}
const register = (actor = PM, target = TARGET, ...more: string[]) =>
  run(actor, "observation-register", "T1", "--target", target, "--project", "a", "--rule", "v1", "--source", "ledger-events", "--reason", "上线观察", ...more);
const due = (at: number, id = "obs-1") => { clock = at; return run("scheduler", "observation-due", "T1", id); };
const mode = (m: string) => setAutostartSwitch(db, owner(T0), { project: "a", on: true, reason: "测", autoMode: m });
const policy = (key = "dagWriteScrub") => recoveryPolicy("a", key as "dagWriteScrub", recovery).mode;
const ops = (op: string) => listEvents(db, { project: "a" }).filter((e) => e.data.op === op);

/** 调度侧：真 tick + 调度身份的命令；记下调了几次台账、发了什么 */
function service() {
  const sent: string[] = [], calls: string[] = [];
  const env = { db, svc: { projects: ["a"] }, now: () => clock, readSpec: () => ({ mtimeMs: 0, text: "## 上线后 PM\n观察期：24 小时\n" }), notifyPm: async () => {},
    ledger: async (_l: string, sub: string, ...a: string[]) => { calls.push([sub, ...a].join(" ")); return run("scheduler", sub, ...a); },
    specWaitSend: async (_d: Database, _p: string, to: string, text: string) => void sent.push(`${to}|${text}`),
  } as unknown as SpecWaitEnv;
  const tick = observationTickAt(plans);
  const ticks = async (...at: number[]) => { for (const t of at) { clock = t; expect(await tick(env)).toEqual([]); } };
  return { sent, calls, ticks };
}

beforeEach(() => {
  const dir = mkdtempSync(join(tmpdir(), "observation-plan-"));
  [plans, recovery, clock, extra] = [join(dir, "observation-plans.json"), join(dir, "recovery-policy.json"), T0 + H, {}];
  db = openLedger(tempLedgerPath("observation-plan-db-"));
  setMeta(db, owner(1), { project: "a", key: "pms", value: [PM, DISP] });
  setMeta(db, owner(1), { project: "a", key: "team", value: { dispatcher: DISP, audit: true } });
  createTask(db, owner(2), { project: "a", id: "T1", title: "机制上线", kind: "code", agent: EXEC, pm: PM });
  db.prepare("UPDATE tasks SET stage = 'verified' WHERE id = 'T1'").run();
  verified(T0);
});

describe("登记：白名单目标、明确参数、权限", () => {
  test("缺省起点 = 最近一次 verified，时长取规格观察期；绑定规格版本与 observe 世代，卡上留一条 decision", async () => {
    const r = await register();
    expect(r).toMatchObject({ ok: true, autoMode: "observe", adapted: true,
      plan: { id: "obs-1", task: "T1", target: TARGET, status: "active", hours: 24, startAt: new Date(T0).toISOString(), dueAt: new Date(DUE).toISOString(), specRev: 1, generation: 0, by: PM } });
    expect(ops("observation_plan").map((e) => [e.kind, e.target, e.actor, e.data.action])).toEqual([["decision", "T1", PM, "register"]]);
    expect((await register()).code).toBe("conflict"); // 同一目标只留一条有效登记
    expect((await register(PM, TARGET, "--hours", "500")).code).toBe("conflict");
  });

  test("--hours 复用 PVDEFER1 的格式与 168 封顶；项目、口径、来源必须明确且对得上", async () => {
    expect((await register(PM, "recovery:nearMarker", "--hours", "500")).plan.hours).toBe(168);
    for (const bad of ["0", "1.5", "abc"]) expect((await register(PM, "recovery:audit", "--hours", bad)).code).toBe("invalid");
    const base = ["observation-register", "T1", "--target", "recovery:audit", "--reason", "x"];
    expect((await run(PM, ...base as [string], "--rule", "v1", "--source", "ledger-events")).error).toContain("--project");
    expect((await run(PM, ...base as [string], "--project", "b", "--rule", "v1", "--source", "ledger-events")).code).toBe("forbidden");
    expect((await run("owner", ...base as [string], "--project", "b", "--rule", "v1", "--source", "ledger-events")).error).toContain("属于项目 a");
    expect((await run(PM, ...base as [string], "--project", "a", "--rule", "v0", "--source", "ledger-events")).error).toContain("--rule");
    expect((await run(PM, ...base as [string], "--project", "a", "--rule", "v1", "--source", "grep-log")).error).toContain("--source");
  });

  test("整机键、manualStall、额度线、阈值、本机制自己的两个开关都拒登记；普通 agent 与调度助理无权", async () => {
    for (const t of ["recovery:lendConfigFailure", "recovery:manualStall", "autostart:weeklyLinePct", "autostart:codexWeeklyLinePct", "autostart:wipGateThreshold",
      "autostart:autoMode", "autostart:p2BacklogMode"]) expect([t, (await register("owner", t)).code]).toEqual([t, "forbidden"]);
    for (const t of ["recovery:nope", "autostart:nope", "dagWriteScrub", "schema:x"]) expect((await register("owner", t)).code).toBe("invalid");
    for (const who of [EXEC, DISP, "scheduler"]) expect((await register(who)).code).toBe("forbidden");
    expect(readPlans(plans).plans).toEqual([]);
    expect(() => parseTarget("recovery:lendConfigFailure")).toThrow("整机");
  });

  test("不倒填：起点早于 verified / 早于本 observe 世代都拒；目标不在 observe 不能登记", async () => {
    expect((await register(PM, TARGET, "--start", String(T0 - H))).error).toContain("不倒填");
    await setRecovery(db, owner(T0 + 10), { project: "a", set: { key: "dagWriteScrub", mode: "off" }, reason: "关" }, { path: recovery });
    expect((await register()).error).toContain("现在是 off");
    await setRecovery(db, owner(T0 + 20 * 60_000), { project: "a", set: { key: "dagWriteScrub", mode: "observe" }, reason: "回" }, { path: recovery });
    expect((await register()).error).toContain("本次进 observe");
    const ok = await register(PM, TARGET, "--start", String(T0 + 30 * 60_000));
    expect(ok.plan.generation).toBe(targetState(db, "a", { kind: "recovery", key: "dagWriteScrub" }, recovery).generation);
    expect(ok.plan.generation).toBeGreaterThan(0);
  });
});

test("autostart-set 的两个独立开关：--auto-mode / --p2-backlog 各改各的，缺省 observe，别的字段不动", async () => {
  const spec = AUTOSTART_CMDS["autostart-set"]!;
  const set = async (...args: string[]) => {
    const p = parseLedgerArgs(["autostart-set", "on", "--project", "a", "--reason", "测", ...args], spec.valued, spec.bools);
    if ("error" in p) throw new Error(p.error);
    const deps: LedgerDeps = { db, actor: PM, projectIds: ["a"], now: () => clock, loadRegistry: async () => ({ socket: "s", agents: {} }) as Registry, saveRegistry: async () => {} };
    try { return await spec.run(new LedgerCli(deps, p)) as Record<string, any>; } catch (e) { return { ok: false, error: (e as Error).message }; }
  };
  expect([autoMode(db, "a"), p2BacklogMode(db, "a")]).toEqual(["observe", "observe"]);
  expect((await set("--auto-mode", "on", "--spec-wait", "off")).autostart).toMatchObject({ autoMode: "on", specWait: "off" });
  expect([autoMode(db, "a"), p2BacklogMode(db, "a")]).toEqual(["on", "observe"]);
  expect((await set("--p2-backlog", "off")).autostart).toMatchObject({ autoMode: "on", p2BacklogMode: "off", specWait: "off" });
  for (const flag of ["--auto-mode", "--p2-backlog"]) expect((await set(flag, "yes")).error).toContain(`${flag} 只能是 on / observe / off`);
});

describe("[验收线 1] 到期全满足才转正", () => {
  test("24 小时、同世代一条观察、无 error 无误判：到期前不切，到期只切指定目标并记一条 note；重复核不再切", async () => {
    mode("on");
    await register();
    const rec = observed(T0 + 2 * H);
    expect(await due(DUE - 1)).toMatchObject({ ok: true, outcome: "idle", why: "未到期" });
    expect([policy(), ops("observation_promote")]).toEqual(["observe", []]);
    const r = await due(DUE);
    expect(r).toMatchObject({ outcome: "promoted", to: PM, plan: { status: "promoted", receipt: { phase: "noted" } } });
    expect(r.text).toBe(`[观察期转正] T1 ${TARGET} observe→on（登记 obs-1，卡上 note #${r.plan.receipt.note}）`);
    expect([policy(), policy("nearMarker"), policy("audit")]).toEqual(["on", "observe", "observe"]);
    const notes = ops("observation_promote");
    expect(notes.map((e) => [e.kind, e.target, e.actor])).toEqual([["note", "T1", "scheduler"]]);
    expect(notes[0]!.data).toMatchObject({ plan: "obs-1", target: TARGET, from: "observe", to: "on", ruleVersion: "v1", records: [rec], recordCount: 1,
      window: { from: T0, to: DUE }, source: "ledger-events", audit: r.plan.receipt.audit });
    expect(notes[0]!.text).toContain("观察记录 1 条");
    await due(DUE + H); await due(DUE + 2 * H);
    expect([ops("observation_promote").length, ops("scheduler_recovery").length]).toEqual([1, 1]);
    expect(ops("scheduler_recovery")[0]).toMatchObject({ actor: PM, data: { to: { keys: { dagWriteScrub: "on" } } } });
  });

  test("没有登记：到期什么都不会切（旧机制只提醒）；窗口外的观察不算样本", async () => {
    mode("on");
    observed(T0 - H); observed(DUE + 1);
    expect((await due(DUE + H)).code).toBe("not_found");
    expect(policy()).toBe("observe");
    await register();
    expect(await due(DUE + 2)).toMatchObject({ outcome: "judge", plan: { judge: { code: "no_samples" } } });
  });

  test("autostart 单字段同口径：只改那一个字段，项目开关与别的字段不动，回执就是带 dedupKey 的台账事件", async () => {
    extra = { adapters: () => ({ observed: { where: "json_extract(data, '$.op') = 'spec_wait'" }, errors: { where: "json_extract(data, '$.op') = 'spec_wait_error'" }, basis: "测" }) };
    setAutostartSwitch(db, owner(T0), { project: "a", on: false, reason: "先关着", autoMode: "on", line: 80 });
    await register(PM, "autostart:specWait");
    ev(T0 + H, "note", { op: "spec_wait" });
    expect(await due(DUE)).toMatchObject({ outcome: "promoted" });
    expect(readSwitch(db, "a")).toMatchObject({ specWait: "on", autoMode: "on", weeklyLinePct: 80, off: { reason: "先关着", by: "owner", at: T0 } });
    expect(readSwitch(db, "a").mergePmWait).toBeUndefined();
    await due(DUE + H);
    expect(listEvents(db, { project: "a" }).filter((e) => e.data.op === "autostart" && e.actor === PM).length).toBe(1);
  });
});

describe("[验收线 2] 不满足只交 PM 一次，误判持久", () => {
  const cases: [string, () => Promise<void> | void, string][] = [
    ["零样本", () => {}, "no_samples"],
    ["结构化 error", () => { observed(T0 + H); ev(T0 + 2 * H, "note", { op: "converge_dag_scrub", round: 2 }, "T1"); }, "errors"],
    ["人工误判", async () => { const s = observed(T0 + H); await run(PM, "observation-mark", "obs-1", "--misjudged", String(s), "--reason", "这条其实推得出去"); }, "misjudged"],
    ["证据读不出（不完整）", () => { observed(T0 + H); extra = { adapters: () => ({ observed: { where: "no_such_column = 1" }, errors: { where: "1 = 0" }, basis: "坏" }) }; }, "evidence_incomplete"],
  ];
  for (const [name, arrange, code] of cases) {
    test(`${name} → 不切，judge 一条带证据，之后不重核不重发`, async () => {
      mode("on");
      await register();
      await arrange();
      const { sent, ticks } = service();
      await ticks(DUE, DUE + H, DUE + 2 * H);
      expect(sent.length).toBe(1);
      expect(sent[0]).toStartWith(`${PM}|[观察期核对] obs-1 T1 的 ${TARGET} 观察 24 小时到期，没有自动转正：`);
      expect(sent[0]).toContain("证据：");
      const p = readPlans(plans).plans[0]!;
      expect([p.status, p.judge?.code, p.judge?.sentAt, policy(), ops("observation_promote").length]).toEqual(["judged", code, DUE, "observe", 0]);
    });
  }

  test("没有证据适配器的机制（nearMarker 等）到期判不可核，不拿别的东西冒充证据", async () => {
    mode("on");
    await register(PM, "recovery:nearMarker");
    ev(T0 + H, "scheduler", { op: "review_near_marker", mode: "observe" }, "T1");
    const r = await due(DUE);
    expect(r).toMatchObject({ outcome: "judge", plan: { judge: { code: "evidence_incomplete" } } });
    expect(r.text).toContain("没有证据适配器");
    expect(policy("nearMarker")).toBe("observe");
  });

  test("误判标记落在文件里重启不丢；清除是另一条显式命令并留审计；普通 agent 不能标也不能清", async () => {
    await register();
    const s = observed(T0 + H);
    expect((await run(EXEC, "observation-mark", "obs-1", "--misjudged", String(s), "--reason", "x")).code).toBe("forbidden");
    expect((await run(PM, "observation-mark", "obs-1", "--misjudged", "999999", "--reason", "x")).code).toBe("not_found");
    await run(PM, "observation-mark", "obs-1", "--misjudged", String(s), "--reason", "误判了");
    expect(JSON.parse(readFileSync(plans, "utf8")).plans[0].misjudged).toEqual([{ record: s, reason: "误判了", by: PM, at: clock }]);
    for (const who of [EXEC, DISP, "scheduler"]) expect((await run(who, "observation-unmark", "obs-1", "--misjudged", String(s), "--reason", "x")).code).toBe("forbidden");
    mode("on");
    expect(await due(DUE)).toMatchObject({ outcome: "judge", plan: { judge: { code: "misjudged" } } });
    expect((await run(PM, "observation-unmark", "obs-1", "--misjudged", String(s), "--reason", "x")).code).toBe("conflict"); // 已交 PM 的登记不再被标记改动
    await run(PM, "observation-recheck", "obs-1", "--reason", "核过了，标错了");
    expect((await run(PM, "observation-unmark", "obs-1", "--misjudged", String(s), "--reason", "标错了")).plan.misjudged[0].cleared).toMatchObject({ by: PM, reason: "标错了" });
    expect(await due(DUE + H)).toMatchObject({ outcome: "promoted" });
    expect(ops("observation_plan").map((e) => e.data.action)).toEqual(["register", "mark", "recheck", "unmark"]);
  });
});

describe("[验收线 4] 陈旧登记与崩溃对账", () => {
  const stale: [string, () => Promise<unknown> | unknown, string, string][] = [
    ["人工切 off", () => setRecovery(db, owner(T0 + 3 * H), { project: "a", set: { key: "dagWriteScrub", mode: "off" }, reason: "关" }, { path: recovery }), "mode_changed", "off"],
    ["切 off 又切回 observe（换了世代）", async () => {
      await setRecovery(db, owner(T0 + 3 * H), { project: "a", set: { key: "dagWriteScrub", mode: "off" }, reason: "关" }, { path: recovery });
      await setRecovery(db, owner(T0 + 4 * H), { project: "a", set: { key: "dagWriteScrub", mode: "inherit" }, reason: "回" }, { path: recovery });
    }, "generation_changed", "observe"],
    ["改规格", () => db.prepare("UPDATE tasks SET specRev = specRev + 1 WHERE id = 'T1'").run(), "spec_changed", "observe"],
    ["重新 verified", () => verified(T0 + 5 * H), "reverified", "observe"],
    ["换授权（登记人不再是 PM）", () => setMeta(db, owner(T0 + 5 * H), { project: "a", key: "pms", value: ["agent-new-pm"] }), "authorization_changed", "observe"],
    ["人工撤销后再标误判无效、到期不动", () => {}, "", "observe"],
  ];
  for (const [name, change, code, after] of stale) {
    test(`${name} → 不转正`, async () => {
      mode("on");
      await register();
      observed(T0 + H);
      await change();
      if (!code) {
        await run(PM, "observation-cancel", "obs-1", "--reason", "规则要改");
        expect(await due(DUE)).toMatchObject({ outcome: "idle", plan: { status: "cancelled" } });
        expect((await register()).plan.id).toBe("obs-2"); // 重新登记
      } else expect(await due(DUE)).toMatchObject({ outcome: "judge", plan: { judge: { code } } });
      expect([String(policy()), ops("observation_promote").length]).toEqual([after, 0]);
    });
  }

  test("等恢复策略写锁期间人工切了 off：在 writer 的锁里重核，不覆盖人工的 off", async () => {
    mode("on");
    await register();
    observed(T0 + H);
    const lock = (await acquireLock(`${recovery}.lock`, 1000))!;
    const pending = due(DUE);
    await Bun.sleep(400);
    writeFileSync(recovery, JSON.stringify({ projects: { a: { keys: { dagWriteScrub: "off" } } } }));
    lock.release();
    expect(await pending).toMatchObject({ outcome: "judge", plan: { judge: { code: "mode_changed" }, receipt: { phase: "failed" } } });
    expect([policy(), ops("observation_promote").length, ops("scheduler_recovery").length]).toEqual(["off", 0, 0]);
  });

  test("并发标误判先到：到期核对在同一把锁后面，看得见标记", async () => {
    mode("on");
    await register();
    const s = observed(T0 + H);
    clock = DUE;
    const [m, d] = await Promise.all([run(PM, "observation-mark", "obs-1", "--misjudged", String(s), "--reason", "误判"), run("scheduler", "observation-due", "T1", "obs-1")]);
    expect(m.ok).toBe(true);
    expect(d).toMatchObject({ outcome: "judge", plan: { judge: { code: "misjudged" } } });
    expect(policy()).toBe("observe");
  });

  test("模式发布后崩溃：重启只补成功 note，不再切第二次", async () => {
    mode("on");
    await register();
    observed(T0 + H);
    extra = { fault: () => { throw new Error("模拟崩溃"); } };
    await expect(due(DUE)).rejects.toThrow("模拟崩溃");
    expect([policy(), ops("observation_promote").length, readPlans(plans).plans[0]!.receipt?.phase, readPlans(plans).plans[0]!.status]).toEqual(["on", 0, "prepared", "active"]);
    extra = {};
    const r = await due(DUE + 60_000);
    expect(r).toMatchObject({ outcome: "promoted", plan: { status: "promoted", receipt: { phase: "noted" } } });
    await due(DUE + 120_000);
    expect([ops("observation_promote").length, ops("scheduler_recovery").length, policy()]).toEqual([1, 1, "on"]);
    expect(ops("observation_promote")[0]!.data.audit).toBe(ops("scheduler_recovery")[0]!.seq);
  });

  test("发布失败不记成功：模式原样，登记带失败回执交 PM，PM 放回后可重核", async () => {
    mode("on");
    await register();
    observed(T0 + H);
    extra = { writers: { recovery: async () => { throw new Error("磁盘满"); } } };
    const r = await due(DUE);
    expect(r).toMatchObject({ outcome: "judge", plan: { status: "judged", judge: { code: "switch_failed" }, receipt: { phase: "failed", error: "磁盘满" } } });
    expect(r.text).toContain("模式仍是原样");
    expect([policy(), ops("observation_promote").length]).toEqual(["observe", 0]);
    expect(await due(DUE + H)).toMatchObject({ outcome: "judge" }); // 没送达前原文重发，不重试切换
    expect(policy()).toBe("observe");
    extra = {};
    await run(PM, "observation-recheck", "obs-1", "--reason", "磁盘清了");
    expect(await due(DUE + 2 * H)).toMatchObject({ outcome: "promoted" });
    expect(policy()).toBe("on");
  });
});

describe("[验收线 4] 第 1 轮审查的四条：配置版本、等锁期间关 autoMode、发布后换授权、登记锁失租", () => {
  /** 占住恢复策略的写锁，让到期核对停在目标 writer 门口；during 跑完再放锁 */
  async function whileWaiting(during: () => Promise<unknown> | unknown, at = DUE): Promise<Record<string, any>> {
    const lock = (await acquireLock(`${recovery}.lock`, 1000))!;
    const pending = due(at).catch((e: Error) => ({ ok: false, thrown: e instanceof LedgerError ? e.code : e.message }));
    await Bun.sleep(400);
    await during();
    lock.release();
    return pending;
  }
  const arrange = async () => { mode("on"); await register(); return observed(T0 + H); };

  test("config-revision：同一目标被显式写成 observe（生效模式、世代都没变）→ 配置版本变了，不转正", async () => {
    await arrange();
    expect(readPlans(plans).plans[0]).toMatchObject({ generation: 0, configRev: 0 });
    const set = await setRecovery(db, owner(T0 + 3 * H), { project: "a", set: { key: "dagWriteScrub", mode: "observe" }, reason: "显式写一遍" }, { path: recovery });
    expect(targetState(db, "a", { kind: "recovery", key: "dagWriteScrub" }, recovery)).toMatchObject({ mode: "observe", generation: 0, rev: set.event });
    const r = await due(DUE);
    expect(r).toMatchObject({ outcome: "judge", plan: { judge: { code: "config_changed" } } });
    expect(r.text).toContain(`审计 #${set.event}，登记时 #0`);
    expect([policy(), ops("observation_promote").length]).toEqual(["observe", 0]);
    // 别的键、别的登记转正会抬整个项目的文件 rev，但不算这个目标的配置变了
    await run(PM, "observation-cancel", "obs-1", "--reason", "x").catch(() => {});
    expect((await register(PM, "recovery:nearMarker")).plan.id).toBe("obs-2");
    await setRecovery(db, owner(T0 + 4 * H), { project: "a", set: { key: "audit", mode: "off" }, reason: "别的键" }, { path: recovery });
    expect(targetState(db, "a", { kind: "recovery", key: "nearMarker" }, recovery).rev).toBe(readPlans(plans).plans[1]!.configRev!);
  });

  test("config-revision：等目标写锁期间配置被写了一版 → 在 writer 的锁里比版本，不覆盖", async () => {
    await arrange();
    const r = await whileWaiting(() => {
      const seq = ev(T0 + 25 * H, "decision", { op: "scheduler_recovery", from: { mode: null, keys: {} }, to: { mode: null, keys: { dagWriteScrub: "observe" } } });
      appendEvent(db, { actor: "owner", now: T0 + 25 * H, dedupKey: `recovery-published:${seq}` }, { project: "a", target: "", kind: "note", text: "已生效", data: {} });
      writeFileSync(recovery, JSON.stringify({ projects: { a: { keys: { dagWriteScrub: "observe" }, rev: seq } } }));
    });
    expect(r).toMatchObject({ outcome: "judge", plan: { judge: { code: "config_changed" }, receipt: { phase: "failed" } } });
    expect([policy(), ops("observation_promote").length]).toEqual(["observe", 0]);
  });

  test("config-revision（autostart 字段）：显式 --spec-wait observe 之后旧登记不转正；没绑配置版本的旧登记也不转正", async () => {
    extra = { adapters: () => ({ observed: { where: "json_extract(data, '$.op') = 'spec_wait'" }, errors: { where: "1 = 0" }, basis: "测" }) };
    mode("on");
    await register(PM, "autostart:specWait");
    await register(PM, "autostart:wipGate");
    ev(T0 + H, "note", { op: "spec_wait" });
    setAutostartSwitch(db, owner(T0 + 2 * H), { project: "a", on: true, reason: "显式写一遍", specWait: "observe" });
    expect(await due(DUE)).toMatchObject({ outcome: "judge", plan: { judge: { code: "config_changed" } } });
    const doc = JSON.parse(readFileSync(plans, "utf8"));
    delete doc.plans[1].configRev;
    writeFileSync(plans, JSON.stringify(doc));
    expect(await due(DUE, "obs-2")).toMatchObject({ outcome: "judge", plan: { judge: { code: "config_changed" } } });
    expect([readSwitch(db, "a").specWait, readSwitch(db, "a").wipGate]).toEqual(["observe", undefined]);
  });

  for (const off of ["off", "observe"]) {
    test(`auto-off-race：等目标写锁期间 autoMode 被改成 ${off} → 不切、不交 PM，登记原样留着；再开 on 照常核`, async () => {
      await arrange();
      const r = await whileWaiting(() => mode(off));
      expect(r).toMatchObject({ ok: true, outcome: "idle", plan: { status: "active" } });
      expect(r.why).toContain(`autoMode 现在是 ${off}`);
      expect([policy(), ops("scheduler_recovery").length, ops("observation_promote").length, readPlans(plans).plans[0]!.receipt]).toEqual(["observe", 0, 0, undefined]);
      mode("on");
      expect(await due(DUE + H)).toMatchObject({ outcome: "promoted" });
    });
  }

  test("reconcile-auth：发布后崩溃、随后换了 PM → 重启按已发布的审计只补成功 note，不重入 writer、不看已撤销的权限", async () => {
    await arrange();
    extra = { fault: () => { throw new Error("模拟崩溃"); } };
    await expect(due(DUE)).rejects.toThrow("模拟崩溃");
    setMeta(db, owner(DUE + 1), { project: "a", key: "pms", value: ["agent-new-pm"] });
    extra = { writers: { recovery: async () => { throw new Error("不该再进 writer"); } } };
    const r = await due(DUE + 60_000);
    expect(r).toMatchObject({ outcome: "promoted", to: "agent-new-pm", plan: { status: "promoted", receipt: { phase: "noted" } } });
    expect([policy(), ops("observation_promote").length, ops("scheduler_recovery").length]).toEqual(["on", 1, 1]);
    expect(ops("observation_promote")[0]!.data).toMatchObject({ from: "observe", to: "on", audit: ops("scheduler_recovery")[0]!.seq });
  });

  test("reconcile-auth：发布记录没记上、文件 rev 就是这条审计 → 同样算已发布；审计已作废 → 不记成功、交 PM", async () => {
    await arrange();
    const prepared = (d: Database, by: string, ctx: { now: number; dedupKey: string }, key: string) => appendEvent(d, { actor: by, now: ctx.now, dedupKey: ctx.dedupKey },
      { project: "a", target: "", kind: "decision", text: "转正",
        data: { op: "scheduler_recovery", from: { mode: null, keys: {} }, to: { mode: null, keys: { [key]: "on" } }, publish: "prepared" } }).event.seq;
    extra = { writers: { recovery: async (d, plan, ctx) => { // 审计提交、文件也写成了（rev = 审计号），发布记录还没记就死了
      const seq = prepared(d, plan.by, ctx, "dagWriteScrub");
      writeFileSync(recovery, JSON.stringify({ projects: { a: { keys: { dagWriteScrub: "on" }, rev: seq } } }));
      throw new LedgerError("busy", "进程没了");
    } } };
    expect(await due(DUE)).toMatchObject({ outcome: "idle", plan: { status: "active", receipt: { phase: "prepared" } } });
    const audit = ops("scheduler_recovery")[0]!.seq;
    setMeta(db, owner(DUE + 1), { project: "a", key: "pms", value: ["agent-new-pm"] });
    extra = { writers: { recovery: async () => { throw new Error("不该再进 writer"); } } };
    expect(await due(DUE + 60_000)).toMatchObject({ outcome: "promoted", plan: { receipt: { phase: "noted", audit } } });
    expect(policy()).toBe("on");
    // 另一条登记：审计提交了、文件没写成（原 writer 已记作废）
    await register("owner", "recovery:nearMarker");
    extra = { adapters: () => ({ observed: { where: "1 = 1" }, errors: { where: "1 = 0" }, basis: "测" }), writers: { recovery: async (d, plan, ctx) => {
      const seq = prepared(d, plan.by, ctx, "nearMarker");
      appendEvent(d, { actor: plan.by, now: ctx.now, dedupKey: `recovery-void:${seq}` }, { project: "a", target: "", kind: "note", text: "没写成", data: {} });
      throw new LedgerError("busy", "文件没写成");
    } } };
    const r = await due(DUE + 2 * H, "obs-2");
    expect(r).toMatchObject({ outcome: "judge", plan: { judge: { code: "switch_failed" }, receipt: { phase: "failed" } } });
    expect([r.text.includes("模式仍是原样"), policy("nearMarker"), ops("observation_promote").length]).toEqual([true, "observe", 1]);
    expect(await due(DUE + 3 * H, "obs-2")).toMatchObject({ outcome: "judge" }); // 没送达前原文重发，不再进 writer
  });

  test("plan-lease：等目标写锁期间登记锁被回收、新持有者标了误判 → 旧执行在 writer 的锁里发现失租，不切", async () => {
    const rec = await arrange();
    let marked: Record<string, any> = {};
    const r = await whileWaiting(async () => {
      renameSync(`${plans}.lock`, `${plans}.lock.stale-test`); // 租期到了被别人原子回收
      marked = await run(PM, "observation-mark", "obs-1", "--misjudged", String(rec), "--reason", "误判");
    });
    expect(marked.ok).toBe(true);
    expect(r).toMatchObject({ ok: false, code: "busy" });
    const p = readPlans(plans).plans[0]!;
    expect([policy(), ops("scheduler_recovery").length, ops("observation_promote").length, p.status, p.misjudged.map((m) => m.record)]).toEqual(["observe", 0, 0, "active", [rec]]);
    expect(await due(DUE + H)).toMatchObject({ outcome: "judge", plan: { judge: { code: "misjudged" } } }); // 下一轮在新锁里看见标记
  });
});

describe("[验收线 3] 没登记 / 缺省 / observe / off 都不会意外切换", () => {
  test("规格写了观察期但没有登记：autoMode on 也不调台账、不发、不切", async () => {
    mode("on");
    observed(T0 + H);
    const { sent, calls, ticks } = service();
    await ticks(DUE, DUE + H);
    expect([sent, calls, policy()]).toEqual([[], [], "observe"]);
  });

  test("旧配置没有 autoMode = observe：到期只在卡上记一条「本会转正」，不切、不通知，之后不再调", async () => {
    expect(readSwitch(db, "a").autoMode).toBeUndefined();
    await register();
    observed(T0 + H);
    const { sent, calls, ticks } = service();
    await ticks(DUE - 1, DUE, DUE + H, DUE + 2 * H);
    expect([sent, calls, policy()]).toEqual([[], ["observation-due T1 obs-1"], "observe"]);
    const dry = ops("observation_dry_run");
    expect(dry.map((e) => [e.kind, e.target, e.data.wouldPromote])).toEqual([["note", "T1", true]]);
    expect(dry[0]!.text).toContain("本会转正");
    expect([ops("observation_promote"), ops("scheduler_recovery")]).toEqual([[], []]);
    mode("on"); // PM 核过预演后开 on：同一条登记照常转正
    await ticks(DUE + 3 * H);
    expect([policy(), sent.length, ops("observation_promote").length]).toEqual(["on", 1, 1]);
    expect(sent[0]).toStartWith(`${PM}|[观察期转正] T1 ${TARGET} observe→on`);
    expect(sent[0]).not.toContain("\n");
  });

  test("observe 下不满足：只记「本会交 PM 判断」，不发 judge", async () => {
    mode("observe");
    await register();
    const { sent, ticks } = service();
    await ticks(DUE, DUE + H);
    expect(sent).toEqual([]);
    expect(ops("observation_dry_run").map((e) => [e.data.wouldPromote, e.data.code])).toEqual([[false, "no_samples"]]);
    expect(readPlans(plans).plans[0]!.status).toBe("active");
  });

  test("off：到期的登记原样躺着，不调台账、不写事件、不动登记文件", async () => {
    await register();
    observed(T0 + H);
    mode("off");
    const before = [readFileSync(plans, "utf8"), listEvents(db, {}).length];
    const { sent, calls, ticks } = service();
    await ticks(DUE, DUE + 30 * H);
    expect([sent, calls, policy()]).toEqual([[], [], "observe"]);
    expect([readFileSync(plans, "utf8"), listEvents(db, {}).length]).toEqual(before);
    expect(await due(DUE + 31 * H)).toMatchObject({ outcome: "idle", why: "autoMode off" }); // 手动调也不核
  });
});
