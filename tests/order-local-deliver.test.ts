/**
 * dispatch-recovery-DEL：真 PM 一次性授予 → 执行者本人经正式单（MCP deliverOrder）交新 head → 调度 tick 交回 auto，恰好一次。
 * 写入都走进程内的真实 ledger CLI（runLedger）；交付走真实 deliverOrder（origin / PR 查询注入）；tick 是真实 autoResumeTick。
 * 反例：缺 port / observe / off、过期、hold、PM 代交、CLI 交付、换会话、head 未变或 origin 不符、blocker ask、未结意图 / 出借单、非真 PM 授予；
 * 裸 CLI 自带 mcp-deliver dedup（审查 P1 DEL-mcp-source-spoof）与来源记录对不上 / 会话不符。
 */
import type { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { autoResume } from "../src/lib/ledger-autostart-resume.js";
import { getWorkflow } from "../src/lib/ledger-scheduler.js";
import { setWorkflow } from "../src/lib/ledger-scheduler-write.js";
import { closeLedger, getTask, listEvents, openLedger } from "../src/lib/ledger-store.js";
import { setMeta } from "../src/lib/ledger-write.js";
import { deliverOrder } from "../src/lib/order-deliver.js";
import type { LedgerRun } from "../src/lib/order-ledger-exit.js";
import { localDeliveryPolicy, ORDER_TOOL_ENV, ORDER_TOOL_OP, type LocalDeliveryPolicyPort, type RecoveryPolicy } from "../src/lib/order-local-deliver.js";
import { currentOrders } from "../src/lib/order-take.js";
import type { VerifiedCall } from "../src/lib/order-tool-route.js";
import { autoResumeTick, resumeVerdict, type ResumeTickEnv } from "../src/lib/scheduler-autostart-resume.js";
import type { ServiceFacts } from "../src/lib/scheduler-autostart.js";
import type { Registry } from "../src/manager/core.js";
import { runLedger } from "../src/manager/ledger.js";

const P = "p1", T = "DEL1", PM = "agent-lead", DISP = "agent-disp", DEV = "agent-task-del1", BR = "feat/del1";
const NEW = "a".repeat(40), NEW2 = "b".repeat(40), INTENT = "disp:DEL1:write:a0";
const PR = "https://github.com/o/r/pull/9";

let db: Database, now: number, notes: string[], logs: string[], svc: ServiceFacts, origin: string, mode: RecoveryPolicy["mode"] | null;
const channels: Record<string, string> = { "c-lead": PM, "c-dev": DEV, "c-disp": DISP };

const ledger = (actor: string, ...args: string[]) => {
  const reg = { socket: "", agents: Object.fromEntries([PM, DEV, DISP].map((a) => [a, { status: "active", projectId: P }])) } as unknown as Registry;
  return runLedger(args, {
    db, actor, actorProject: P, projectIds: [P], loadRegistry: async () => structuredClone(reg), saveRegistry: async () => {}, now: () => now++,
    autoDispatch: () => svc.autoDispatch, autoProjects: () => [...svc.projects],
  }) as Promise<Record<string, any>>;
};
/** 带环境跑一次进程内 CLI（bridge 的 ledgerRun 只给子进程加环境，这里临时设上、跑完还原） */
async function withEnv<T>(extra: Record<string, string> | undefined, fn: () => Promise<T>): Promise<T> {
  const was = process.env[ORDER_TOOL_ENV];
  if (extra?.[ORDER_TOOL_ENV] !== undefined) process.env[ORDER_TOOL_ENV] = extra[ORDER_TOOL_ENV];
  try { return await fn(); } finally { if (was === undefined) delete process.env[ORDER_TOOL_ENV]; else process.env[ORDER_TOOL_ENV] = was; }
}
const viaCli: LedgerRun = (args, ch, extra) => withEnv(extra, () => ledger(channels[ch] ?? "unknown", ...args.slice(1)));
const sources = () => listEvents(db, { target: T }).filter((e) => e.data.op === ORDER_TOOL_OP);
const forged = (session: string, o: Partial<{ orderId: string; head: string }> = {}) =>
  ({ [ORDER_TOOL_ENV]: JSON.stringify({ tool: "deliver", orderId: o.orderId ?? INTENT, head: o.head ?? NEW, session }) });
const me: VerifiedCall = { agent: DEV, sessionId: "s1", family: "claude-code", channelId: "c-dev" };
const policy: LocalDeliveryPolicyPort = () => (mode ? { mode, manualAfterMs: null } : (undefined as never));

const mcpDeliver = (head = NEW, orderId = INTENT, call = me) =>
  deliverOrder(call, { v: 1, orderId, head, evidence: "docs/tasks/DEL1.md", summary: "交付", selfCheck: "过" }, {
    db, run: viaCli, remoteHead: async () => ({ ok: true, head }), findPr: async () => ({ ok: true, rows: [{ url: PR, headRefOid: head, baseRefName: "main", isCrossRepository: false }] }),
  });

/** 已接线的执行端：与 CLI 同一事务函数，带同一 policy 与核过的 head */
const wired: ResumeTickEnv["resumeGrant"] = async (taskId, a) =>
  autoResume(db, { actor: "scheduler", now: now++ }, { taskId, ...a, svc, grant: { policy, checkedHead: a.checkedHead } });
const env = (o: Partial<ResumeTickEnv> = {}): ResumeTickEnv => ({
  db, svc, memo: new Set(), ledger: (...args) => ledger("scheduler", ...args.slice(1)), notifyPm: async (_p, t) => void notes.push(t),
  policy, remoteHead: async () => ({ ok: true, head: origin }), resumeGrant: wired, log: (l) => void logs.push(l), now: () => now, ...o,
});
const resumes = () => listEvents(db, { target: T }).filter((e) => e.data.op === "workflow_resume");
const wf = () => getWorkflow(db, T)!;
const card = () => getTask(db, T)!;
const grant = (actor = PM, extra: string[] = []) => ledger(actor, "resume-grant", T, "--rev", String(card().rev), "--workflow-rev", String(wf().rev), "--reason", "外发闸拒，本机修", ...extra);

/** auto 卡在 build，有 done 的写派单与作者绑定；PM 接管为 manual */
async function takenOver(): Promise<void> {
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
}

beforeEach(async () => {
  now = 1_000_000;
  notes = [];
  logs = [];
  origin = NEW;
  mode = "on";
  svc = { autoDispatch: true, projects: [P], maxWorkers: () => 4 };
  db = openLedger(":memory:");
  setMeta(db, { actor: "owner", now: 1 }, { project: P, key: "pms", value: [PM, DISP] });
  setMeta(db, { actor: "owner", now: 2 }, { project: P, key: "team", value: { dispatcher: DISP, audit: true } });
  await takenOver();
});
afterEach(() => closeLedger(":memory:"));

describe("成功：授予 → 本人正式交付 → 交回一次", () => {
  test("build 卡保留 done 派单：单号仍是派单 id，交回 auto 恰好一次，重复 tick / 重复 deliver 不再交回", async () => {
    expect(currentOrders(db, me).map((o) => o.orderId)).toEqual([INTENT]);
    const g = await grant();
    expect(g).toMatchObject({ ok: true, grant: { agent: DEV, session: "s1", orderId: INTENT, orderKind: "dispatch", workRound: 0, stage: "build", step: "write" } });
    expect(await mcpDeliver()).toMatchObject({ ok: true, stage: "review" });
    expect(card()).toMatchObject({ stage: "review", round: 1, headSHA: NEW });
    expect(await autoResumeTick(env())).toEqual([]);
    expect(wf().mode).toBe("auto");
    const [r] = resumes();
    expect(r).toMatchObject({ actor: "scheduler", data: { auto: true, grant: `grant:${T}:${g.event.seq}`, trigger: g.event.seq } });
    expect(await mcpDeliver()).toMatchObject({ ok: true, duplicate: true });
    expect(await autoResumeTick(env())).toEqual([]);
    expect(resumes()).toHaveLength(1);
    expect(db.query("SELECT status FROM scheduler_intents WHERE id = ?").get(INTENT)).toEqual({ status: "done" });
    expect(notes).toEqual([]);
  });

  test("fix 卡（workRound=1）无本阶段派单：单号是 manualOrderId，交付后 round=2，交回一次；拿 r1 以外的单号不交回", async () => {
    db.query("UPDATE tasks SET stage = 'fix', round = 1 WHERE id = ?").run(T);
    db.query(`INSERT INTO events (ts, actor, project, target, kind, text, data) VALUES (?, ?, ?, ?, 'stage', '', '{"from":"review","to":"fix"}')`).run(now++, PM, P, T);
    const manual = `${T}:fix:r1`;
    expect(currentOrders(db, me).map((o) => o.orderId)).toEqual([manual]);
    expect(await grant()).toMatchObject({ ok: true, grant: { orderId: manual, orderKind: "manual", workRound: 1, stage: "fix", step: "fix" } });
    expect(await mcpDeliver(NEW, INTENT)).toMatchObject({ ok: false, code: "not_current_order" });
    expect(await mcpDeliver(NEW, manual)).toMatchObject({ ok: true });
    expect(card().round).toBe(2);
    await autoResumeTick(env());
    expect(resumes()).toHaveLength(1);
  });

  test("两个并发交回（tick×2）：只有一条 workflow_resume", async () => {
    await grant();
    await mcpDeliver();
    await Promise.all([autoResumeTick(env()), autoResumeTick(env())]);
    expect(resumes()).toHaveLength(1);
  });
});

describe("开关：缺 port observe、observe 只记日志、off 不判、坏值 off", () => {
  test("缺 port：只记一次 would_resume，不查远端、不写、不通知", async () => {
    await grant();
    await mcpDeliver();
    let asked = 0;
    const e = env({ policy: undefined, remoteHead: async () => (asked++, { ok: true, head: origin }) });
    await autoResumeTick(e);
    await autoResumeTick(e);
    expect(wf().mode).toBe("manual");
    expect(asked).toBe(0);
    expect(logs).toHaveLength(1);
    expect(logs[0]).toContain("remote: unchecked");
    expect(notes).toEqual([]);
  });

  test("observe / off：不交回；off 连日志都没有", async () => {
    await grant();
    await mcpDeliver();
    mode = "observe";
    await autoResumeTick(env());
    expect(logs).toHaveLength(1);
    mode = "off";
    logs = [];
    await autoResumeTick(env());
    expect(logs).toEqual([]);
    expect(wf().mode).toBe("manual");
  });

  test("port 抛错或坏值 → off", () => {
    expect(localDeliveryPolicy(() => { throw new Error("坏"); }, P).mode).toBe("off");
    expect(localDeliveryPolicy(() => ({ mode: "yes" }) as never, P).mode).toBe("off");
    expect(localDeliveryPolicy(undefined, P).mode).toBe("observe");
  });

  test("on 但执行端没接线：不写台账；真实 CLI scheduler-auto-resume 没有 policy 也不交回", async () => {
    await grant();
    await mcpDeliver();
    await autoResumeTick(env({ resumeGrant: undefined }));
    expect(logs[0]).toContain("未接线");
    const r = await ledger("scheduler", "scheduler-auto-resume", T, "--rev", String(card().rev), "--workflow-rev", String(wf().rev), "--max-workers", "4");
    expect(r).toMatchObject({ ok: false, code: "not_eligible" });
    expect(wf().mode).toBe("manual");
  });

  test("事务里 checkedHead 与交付 head 不一致 → not_eligible", async () => {
    await grant();
    await mcpDeliver();
    const r = autoResume(db, { actor: "scheduler", now: now++ }, { taskId: T, taskRev: card().rev, workflowRev: wf().rev, maxWorkers: 4, svc, grant: { policy, checkedHead: NEW2 } });
    expect(r).toMatchObject({ ok: false, code: "not_eligible" });
  });
});

describe("授予权限：worker 不能自授", () => {
  for (const [who, actor] of [["执行者", DEV], ["调度助理", DISP], ["调度服务", "scheduler"]] as const) {
    test(`${who}授予 → forbidden，不写事件`, async () => {
      expect(await grant(actor)).toMatchObject({ ok: false, code: "forbidden" });
      expect(listEvents(db, { target: T }).some((e) => e.data.op === "resume_grant")).toBe(false);
    });
  }

  test("stale rev → conflict；ttl 越界 → 拒；卡不在 build/fix → 拒", async () => {
    expect(await ledger(PM, "resume-grant", T, "--rev", String(card().rev + 1), "--workflow-rev", String(wf().rev), "--reason", "x")).toMatchObject({ ok: false, code: "conflict" });
    expect(await grant(PM, ["--ttl-h", "73"])).toMatchObject({ ok: false, code: "invalid" });
    db.query("UPDATE tasks SET stage = 'review' WHERE id = ?").run(T);
    expect(await grant()).toMatchObject({ ok: false, code: "invalid" });
  });

  test("同一 --dedup 重放：返回同一条授予，不另记", async () => {
    const a = await grant(PM, ["--dedup", "g1"]);
    const b = await grant(PM, ["--dedup", "g1"]);
    expect(b).toMatchObject({ ok: true, duplicate: true });
    expect(b.event.seq).toBe(a.event.seq);
  });

  test("换了会话（绑定不是执行者本人）→ 拒授予", async () => {
    db.query("UPDATE scheduler_sessions SET agent = 'agent-other' WHERE taskId = ?").run(T);
    expect(await grant()).toMatchObject({ ok: false, code: "invalid" });
  });

  test("有未结出借单 → 拒授予", async () => {
    db.query(`INSERT INTO scheduler_intents (id, taskId, project, node, action, causalSeq, eventSeq, taskRev, specRev, templateVersion, status, reason, createdAt, updatedAt)
      VALUES ('x-unk', ?, ?, 'write', 'dispatch', 1, 1, 1, 1, 2, 'unknown', 'r', 1, 1)`).run(T, P);
    expect(await grant()).toMatchObject({ ok: false, code: "conflict" });
  });
});

describe("不交回", () => {
  const cases: [string, () => Promise<unknown> | void][] = [
    ["没有授予（普通接管）", async () => { await mcpDeliver(); }],
    ["授予后 PM hold", async () => {
      await grant();
      setWorkflow(db, { actor: PM, now: now++ }, { taskId: T, taskRev: card().rev, workflowRev: wf().rev, template: "code", templateVersion: 2, mode: "manual",
        authorFamily: "claude", fallback: "PM 接管", reason: "owner hold" });
      await mcpDeliver();
    }],
    ["资格过期", async () => { await grant(PM, ["--ttl-h", "1"]); await mcpDeliver(); now += 3_600_001; }],
    ["PM 代交（CLI）", async () => { await grant(); await ledger(PM, "deliver", T, "--from", "build", "--head", NEW); }],
    ["执行者 CLI 交付（无正式单）", async () => { await grant(); await ledger(DEV, "deliver", T, "--from", "build", "--head", NEW); }],
    ["交付后换了作者会话", async () => { await grant(); await mcpDeliver(); db.query("UPDATE scheduler_sessions SET sessionId = 's2' WHERE taskId = ?").run(T); }],
    ["交付后 spec 变了", async () => { await grant(); await mcpDeliver(); db.query("UPDATE tasks SET specRev = specRev + 1 WHERE id = ?").run(T); }],
    ["交付后分支变了", async () => { await grant(); await mcpDeliver(); db.query("UPDATE tasks SET branch = 'feat/other' WHERE id = ?").run(T); }],
    ["执行者有未答的 blocker ask", async () => {
      await grant();
      await mcpDeliver();
      db.query(`INSERT INTO asks (id, project, taskId, fromAgent, source, kind, title, chatId, expiresAt, state, extra, createdAt, updatedAt)
        VALUES ('ask1', ?, ?, ?, 'reply', 'decide', '拒做', 'c', 9999999999999, 'open', '{"class":"blocker"}', 1, 1)`).run(P, T, DEV);
    }],
    ["授予后挂了模型安全拒绝", async () => {
      await grant();
      await mcpDeliver();
      db.query(`INSERT INTO events (ts, actor, project, target, kind, text, data) VALUES (?, 'scheduler', ?, ?, 'scheduler', 'hold', '{"op":"model_safety_hold"}')`).run(now++, P, T);
    }],
    ["派单意图被取消", async () => { await grant(); await mcpDeliver(); db.query("UPDATE scheduler_intents SET status = 'cancelled' WHERE id = ?").run(INTENT); }],
    ["调度服务没开自动派单", async () => { await grant(); await mcpDeliver(); svc = { ...svc, autoDispatch: false }; }],
  ];
  for (const [name, setup] of cases) {
    test(name, async () => {
      await setup();
      await autoResumeTick(env());
      expect(wf().mode).toBe("manual");
      expect(resumes()).toEqual([]);
    });
  }

  test("origin head 与交付不符：不交回，通知 PM 一次", async () => {
    await grant();
    await mcpDeliver();
    origin = NEW2;
    const e = env();
    await autoResumeTick(e);
    await autoResumeTick(e);
    expect(wf().mode).toBe("manual");
    expect(notes).toHaveLength(1);
    expect(notes[0]).toContain("origin");
  });

  test("交付的 head 等于授予时的 head：判定拒", async () => {
    db.query("UPDATE tasks SET headSHA = ? WHERE id = ?").run(NEW, T);
    await grant();
    await mcpDeliver();
    const v = resumeVerdict(db, card(), wf(), now);
    expect(v).toMatchObject({ ok: false });
  });

  test("PM 不能借 mcp-deliver 键冒充本人正式交付", async () => {
    await grant();
    const r = await ledger(PM, "deliver", T, "--from", "build", "--head", NEW, `--dedup=mcp-deliver:${INTENT}:${NEW}`);
    expect(r).toMatchObject({ ok: false, code: "forbidden" });
    expect(card().stage).toBe("build");
  });

  // 审查 P1 DEL-mcp-source-spoof：dedup 只是幂等键；不经 deliverOrder 的裸 CLI 带同一个键，交付照常但不交回
  test("probe: raw CLI forged MCP dedup from unverified session resumes", async () => {
    await grant();
    const r = await ledger(DEV, "deliver", T, "--from", "build", "--head", NEW, "--dedup", `mcp-deliver:${INTENT}:${NEW}`);
    expect(r).toMatchObject({ ok: true });
    expect(card()).toMatchObject({ stage: "review", headSHA: NEW });
    expect(sources()).toEqual([]);
    expect(resumeVerdict(db, card(), wf(), now)).toMatchObject({ ok: false, why: expect.stringContaining("MCP 来源") });
    await autoResumeTick(env());
    expect(wf().mode).toBe("manual");
    expect(resumes()).toEqual([]);
    // 之后真 MCP 同单号同 head 重试只回放第一次（裸 CLI 那条），补不上来源，仍不交回
    expect(await mcpDeliver()).toMatchObject({ ok: true, duplicate: true });
    expect(sources()).toEqual([]);
    await autoResumeTick(env());
    expect(wf().mode).toBe("manual");
  });

  test("MCP 交付在同一事务记一条来源（单号 / head / 已验证会话 / 交付 seq）；重放不另记", async () => {
    await grant();
    const r = (await mcpDeliver()) as { eventSeq?: number };
    const [src] = sources();
    expect(src).toMatchObject({ actor: DEV, data: { deliverSeq: r.eventSeq, call: { tool: "deliver", orderId: INTENT, head: NEW, session: "s1" } } });
    await mcpDeliver();
    expect(sources()).toHaveLength(1);
  });

  test("来源会话不是授予绑定的会话 → 不交回", async () => {
    await grant();
    const r = await viaCli(["ledger", "deliver", T, "--from", "build", "--head", NEW, `--dedup=mcp-deliver:${INTENT}:${NEW}`], "c-dev", forged("s9"));
    expect(r).toMatchObject({ ok: true });
    expect(resumeVerdict(db, card(), wf(), now)).toMatchObject({ ok: false, why: expect.stringContaining("会话") });
    await autoResumeTick(env());
    expect(wf().mode).toBe("manual");
  });

  test("来源记录与 dedup / head / 执行者对不上 → forbidden，台账不动", async () => {
    await grant();
    const key = `--dedup=mcp-deliver:${INTENT}:${NEW}`;
    const run = (actorCh: string, extra: Record<string, string>, dedup = key) => viaCli(["ledger", "deliver", T, "--from", "build", "--head", NEW, dedup], actorCh, extra);
    expect(await run("c-dev", forged("s1", { head: NEW2 }))).toMatchObject({ ok: false, code: "forbidden" });
    expect(await run("c-dev", forged("s1", { orderId: "other" }))).toMatchObject({ ok: false, code: "forbidden" });
    expect(await run("c-dev", forged("s1"), "--dedup=x1")).toMatchObject({ ok: false, code: "forbidden" });
    expect(await run("c-dev", { [ORDER_TOOL_ENV]: "{" })).toMatchObject({ ok: false, code: "forbidden" });
    expect(await run("c-lead", forged("s1"))).toMatchObject({ ok: false, code: "forbidden" });
    expect(card().stage).toBe("build");
    expect(sources()).toEqual([]);
  });

  test("别人用这张单号交付 → not_current_order，台账不动", async () => {
    await grant();
    const other: VerifiedCall = { agent: "agent-other", sessionId: "s9", family: "claude-code", channelId: "c-x" };
    expect(await mcpDeliver(NEW, INTENT, other)).toMatchObject({ ok: false, code: "not_current_order" });
    const sameAgentNewSession: VerifiedCall = { ...me, sessionId: "s2" };
    expect(await mcpDeliver(NEW, INTENT, sameAgentNewSession)).toMatchObject({ ok: false, code: "not_current_order" });
    expect(card().stage).toBe("build");
  });
});
