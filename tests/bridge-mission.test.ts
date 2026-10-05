/**
 * bridge/mission.ts：回合结束 → 落盘唤醒 → 宽限期后领成 run、递提醒；run 的回合结束按事件归类、写日志、按结果排下次；
 * 人在说话 / 画面忙 / 人刚发过消息就让位；到点递收尾并关闭；bridge 重启（落盘的 run / 唤醒）不丢不重。
 * 用 master（频道取 controlChannelId，不读真实 registry）+ 临时状态文件 + 缩短的宽限期；日志落在 preload 隔离的状态目录。
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initMission, reconcileMissions, setMissionTestHooks } from "../src/bridge/mission.js";
import { emitEvent, type BridgeEventType } from "../src/bridge/event-bus.js";
import { resetAutopilotEvidence } from "../src/bridge/autopilot-evidence.js";
import { pendingCloseOf, setEvidenceWaitForTest } from "../src/bridge/autopilot-close.js";
import type { Envelope } from "../src/bridge/router.js";
import { readRunLog } from "../src/lib/autopilot-log.js";
import { AUTOPILOT_TIMING } from "../src/lib/autopilot-run.js";
import { newMission, readMissions, updateMissions, type Mission } from "../src/lib/missions.js";
import { turnCuts } from "../src/bridge/turn-cuts.js";

const sent: Envelope[] = [];
const path = join(mkdtempSync(join(tmpdir(), "bridge-mission-")), "missions.json");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const ev = (type: BridgeEventType, data: Record<string, unknown>) => emitEvent({ agent: "master", chatId: "ctl", type, data });
const done = () => ev("agent_status", { status: "done" });
const thinking = () => ev("agent_status", { status: "thinking" });
/** 一个真实回合的结束（先 thinking 再 done）；光秃秃的 done() 是重复 Stop / 补发的 done，不放行待命（P2-9） */
const turnEnd = () => (thinking(), done());
const cur = async () => (await readMissions(path)).master;
/** 等条件成立：两处同时改 missions.json 时文件锁每 250ms 重试一次，固定 sleep 会偶发不够 */
async function until(cond: () => boolean | Promise<boolean>, ms = 3000): Promise<void> {
  const end = Date.now() + ms;
  while (!(await cond())) {
    if (Date.now() > end) throw new Error("等待超时");
    await sleep(20);
  }
}
/** 断言「没发生」之前留足时间：宽限期 + 一次锁重试 */
const settle = () => sleep(400);

async function put(over: Partial<Mission> = {}): Promise<Mission> {
  const m = { ...newMission({ agent: "master", goal: "按台账推进", until: new Date(Date.now() + 3_600_000) }), ...over };
  await updateMissions((all) => void (all.master = m), path);
  return m;
}
/** 开一条 Autopilot，走完第一次投递（回合结束 → 宽限期 → 递出），返回它 */
async function startAndNudge(): Promise<Mission> {
  const m = await put();
  turnEnd();
  await until(async () => sent.length === 1 && !!(await cur()).run?.deliveredAt);
  return m;
}

let paneBusy = false;
let paneUnknown = false;
/** 查忙闲的那一拍里插一件事（owner 恰好这时叫停） */
let onTurnSeen: (() => void) | undefined;
/** 真 bridge 投递给本地时会发 thinking（deliverToLocal）；run 只认那之后的 done */
const realDeliver = async (env: Envelope) => {
  sent.push(env);
  thinking();
  return { envelope: env, outcome: { kind: "sent" } };
};
let deliverImpl: (env: Envelope) => Promise<unknown> = realDeliver;
beforeAll(() => {
  setEvidenceWaitForTest({ minMs: 30, quietMs: 20, maxMs: 300 });
  setMissionTestHooks({ path, graceMs: 50, reconcileDelayMs: 20, turnSeen: async () => (onTurnSeen?.(), paneBusy ? "busy" : paneUnknown ? "unknown" : "idle") });
  initMission({
    clients: new Map([["ctl", { ws: {} as never, channelId: "ctl", cwd: "/tmp" }]]),
    deliver: (env) => deliverImpl(env),
    lastMessageSource: { set: () => undefined },
    controlChannelId: "ctl",
  });
});
beforeEach(async () => {
  paneBusy = false;
  paneUnknown = false;
  deliverImpl = realDeliver;
  // 先删掉上一条的 mission 再等它残留的定时器 / 回合结束处理跑完，否则它们会把提醒记到这一条头上
  await updateMissions((all) => void delete all.master, path);
  done(); // 清掉上一条测试可能留下的「thinking」
  await settle();
  sent.length = 0;
  resetAutopilotEvidence();
});
afterAll(() => updateMissions((all) => void delete all.master, path));

describe("推进与 run", () => {
  test("回合结束 → 宽限期后递一句 continue；run 落盘（已投递）、计数 +1", async () => {
    await startAndNudge();
    expect(sent[0].from).toEqual({ kind: "bridge", label: "mission" });
    expect(sent[0].content).toContain("[⏱ Autopilot] 目标：按台账推进");
    const m = await cur();
    expect(m.nudges).toBe(1);
    expect(m.run?.deliveredAt).toBeTruthy();
    expect(m.wake).toBeUndefined();
  });
  test("run 的回合结束 → 按事件归类（改了东西 = action_taken）、写一行日志、宽限期后递下一句", async () => {
    const m = await startAndNudge();
    thinking();
    ev("tool_start", { name: "Edit" });
    done();
    await until(async () => sent.length === 2 && !!(await cur()).lastRun);
    const after = await cur();
    expect(after.lastRun?.outcome).toBe("action_taken");
    expect(sent.length).toBe(2);
    const log = readRunLog(m.id!);
    expect(log[0]).toMatchObject({ outcome: "action_taken", runId: after.lastRun!.runId, why: "干了活，接着推" });
  });
  test("很短的正常一轮（只查看）不退避，接着推", async () => {
    await startAndNudge();
    ev("tool_start", { name: "Read" });
    done();
    await until(async () => sent.length === 2 && !!(await cur()).lastRun);
    expect((await cur()).lastRun?.outcome).toBe("normal");
    expect(sent.length).toBe(2);
  });
  test("撞额度 → rate_limited，按重置时间挡住（resumeAt 给网页显示），这次不递", async () => {
    await startAndNudge();
    ev("assistant_text", { text: "You've hit your usage limit … try again in 2 hours", rateLimited: true });
    done();
    await until(async () => !!(await cur()).lastRun);
    await settle();
    const m = await cur();
    expect(m.lastRun?.outcome).toBe("rate_limited");
    expect(Date.parse(m.resumeAt!) - Date.now()).toBeGreaterThan(115 * 60_000);
    expect(m.wake?.hold).toBe("rate_limit");
    expect(sent.length).toBe(1);
  });
  test("本轮发了按钮等人拍板 → blocked_approval 不催；人回话后那一轮结束就放行", async () => {
    await startAndNudge();
    ev("chat_message", { direction: "out", from: "master", components: [{ type: "buttons", buttons: [] }] });
    done();
    await until(async () => !!(await cur()).lastRun);
    await settle();
    expect((await cur()).lastRun?.outcome).toBe("blocked_approval");
    expect(sent.length).toBe(1);
    thinking(); // 人点了按钮 / 说了话，agent 回一轮
    done();
    await until(() => sent.length === 2);
  });
});

describe("让位（人优先）", () => {
  test("宽限期里人来说话（转忙）→ 不递", async () => {
    await put();
    turnEnd();
    thinking();
    await settle();
    expect(sent.length).toBe(0);
  });
  test("画面还在忙（bridge 刚重启、状态表是空的）→ 不递，唤醒留在队列里", async () => {
    await put();
    paneBusy = true;
    turnEnd();
    await settle();
    expect(sent.length).toBe(0);
    expect((await cur()).wake).toBeTruthy();
  });
  test("刚收到人类消息 → 排队不推进", async () => {
    await put();
    ev("chat_message", { direction: "in", srcKind: "user", text: "先停一下" });
    done();
    await settle();
    expect(sent.length).toBe(0);
    expect((await cur()).wake).toBeTruthy();
  });
});

describe("到点", () => {
  test("过了截止时间 → 递收尾、变 expired", async () => {
    await put({ until: new Date(Date.now() - 1000).toISOString() });
    turnEnd();
    await until(() => sent.length === 1);
    expect(sent[0].content).toContain("Autopilot 已关闭");
    expect((await cur()).status).toBe("expired");
  });
  test("到点时 agent 正忙：照样立刻 expired（不再续跑），收尾那句等它这一轮结束再递", async () => {
    await put({ until: new Date(Date.now() - 1000).toISOString() });
    paneBusy = true;
    turnEnd();
    await settle();
    expect(sent.length).toBe(0);
    expect((await cur()).status).toBe("expired");
    paneBusy = false;
    done();
    await until(() => sent.length === 1);
    expect(sent[0].content).toContain("Autopilot 已关闭");
    expect(sent[0].meta.dropIfStopped).toBe(true); // 投递途中 owner 叫停：ws.send 前那一查不投（turn-cuts noticeWanted）
  });
  test("到点时 owner 叫停中：不递收尾（不让它叫停后又写台账、发总结），只记一行日志（wf2 stop-semantics-7）", async () => {
    turnCuts.record({ channelId: "ctl", agent: "master", cause: "manual", tools: { inflight: [] } });
    try {
      const m = await put({ until: new Date(Date.now() - 1000).toISOString() });
      turnEnd();
      await until(async () => (await cur()).status === "expired");
      await settle();
      expect(sent.length).toBe(0);
      expect(readRunLog(m.id!).map((l) => l.reason)).toContain("到点已关闭（owner 叫停中，没有递收尾那句）");
      done(); // 欠着的收尾也不补投
      await settle();
      expect(sent.length).toBe(0);
    } finally {
      turnCuts.forget("ctl");
    }
  });
  test("查忙闲的那一拍里 owner 叫停：投递前再查一次，照样不递收尾（T13e r1 P2-2）", async () => {
    onTurnSeen = () => void turnCuts.record({ channelId: "ctl", agent: "master", cause: "manual", tools: { inflight: [] } });
    try {
      const m = await put({ until: new Date(Date.now() - 1000).toISOString() });
      turnEnd();
      await until(async () => (await cur()).status === "expired");
      await settle();
      expect(sent.length).toBe(0);
      expect(readRunLog(m.id!).map((l) => l.reason)).toContain("到点已关闭（owner 叫停中，没有递收尾那句）");
    } finally {
      onTurnSeen = undefined;
      turnCuts.forget("ctl");
    }
  });
  test("不在进行中的不管", async () => {
    await put({ status: "done" });
    turnEnd();
    await settle();
    expect(sent.length).toBe(0);
  });
});

describe("bridge 重启后（只有落盘的状态）", () => {
  test("重启时补发的 done（reason=bridge_restarted）不算回合结束：不放行等人拍板", async () => {
    await put({ wakeSeq: 1, wake: { seq: 1, source: "turn_end", dueAt: new Date(Date.now() + 3_600_000).toISOString(), firstAt: new Date().toISOString(), merged: 0, hold: "blocked" } });
    ev("agent_status", { status: "done", reason: "bridge_restarted" });
    await settle();
    expect((await cur()).wake).toMatchObject({ seq: 1, hold: "blocked" });
    expect(sent.length).toBe(0);
  });
  test("落盘的唤醒 → 重排后递一次，不多递", async () => {
    await put({ wakeSeq: 3, wake: { seq: 3, source: "turn_end", dueAt: new Date(Date.now() - 1000).toISOString(), firstAt: new Date().toISOString(), merged: 2 } });
    await reconcileMissions();
    await until(() => sent.length === 1);
    await reconcileMissions();
    await settle();
    expect(sent.length).toBe(1);
    expect((await cur()).run?.seq).toBe(3);
  });
  test("已投递的 run（本进程没在记账）且 agent 空闲 → 按证据不全收尾、写日志，再递下一句；只递一次", async () => {
    const t = new Date(Date.now() - 60_000).toISOString();
    const m = await put({ wakeSeq: 1, run: { runId: "run_old", seq: 1, source: "turn_end", merged: 0, firstAt: t, claimedAt: t, deliveredAt: t } });
    await reconcileMissions();
    await until(() => sent.length === 1);
    await settle();
    const after = await cur();
    expect(after.lastRun).toMatchObject({ runId: "run_old", outcome: "normal" });
    expect(readRunLog(m.id!)[0].evidence?.evidenceLost).toBe(true);
    expect(sent.length).toBe(1);
  });
  test("已投递的 run 还在忙 → 不收尾不重递，等它的回合结束", async () => {
    const t = new Date(Date.now() - 60_000).toISOString();
    await put({ wakeSeq: 1, run: { runId: "run_busy", seq: 1, source: "turn_end", merged: 0, firstAt: t, claimedAt: t, deliveredAt: t } });
    paneBusy = true;
    await reconcileMissions();
    await settle();
    expect(sent.length).toBe(0);
    expect((await cur()).run?.runId).toBe("run_busy");
    paneBusy = false;
    done();
    await until(() => sent.length === 1);
    await settle();
    expect((await cur()).lastRun?.runId).toBe("run_busy");
    expect(sent.length).toBe(1);
  });
});

describe("对抗式审查补的用例", () => {
  test("回合结束之后才到的最后几条事件（撞额度）也算进这一轮", async () => {
    await startAndNudge();
    done();
    ev("api_error_turn", { error: "rate_limit" }); // watcher 在 Stop 之后才把最后几行读完
    ev("assistant_text", { text: "You've hit your session limit · resets 4:30pm (Asia/Tokyo)" });
    await until(async () => !!(await cur()).lastRun);
    expect((await cur()).lastRun?.outcome).toBe("rate_limited");
  });
  test("deliver 报 error（没送到）→ 不标已投递、nudges 不加，唤醒放回队列", async () => {
    deliverImpl = async (env) => {
      sent.push(env);
      return { envelope: env, outcome: { kind: "error", error: new Error("ws closed") } };
    };
    await put();
    turnEnd();
    await until(() => sent.length === 1);
    await settle();
    const m = await cur();
    expect(m.nudges).toBe(0);
    expect(m.run).toBeUndefined();
    expect(m.wake?.source).toBe("retry");
  });
  test("领取后、投递前到的 done（上一回合迟到的 Stop）不算这个 run 的结束", async () => {
    deliverImpl = async (env) => {
      done(); // 上一个（人工）回合的 Stop 恰好此刻到，还没发 thinking
      await sleep(30);
      return realDeliver(env);
    };
    await put();
    turnEnd();
    await until(async () => !!(await cur()).run?.deliveredAt);
    await settle();
    const m = await cur();
    expect(m.lastRun).toBeUndefined();
    expect(m.run?.deliveredAt).toBeTruthy();
  });
  test("stop 后立刻 start：旧 run 的回合结束给旧一代补一行日志，不写进新一代", async () => {
    const a = await startAndNudge();
    await updateMissions((all) => void Object.assign(all.master, { status: "stopped" }), path);
    const b = await put(); // 新一代
    ev("tool_start", { name: "Edit" });
    done(); // 旧 run 的回合结束
    await until(() => readRunLog(a.id!).length === 1);
    expect(readRunLog(a.id!)[0]).toMatchObject({ outcome: "action_taken" });
    expect(readRunLog(a.id!)[0].reason).toContain("换了一代");
    const now = await cur();
    expect(now.id).toBe(b.id);
    expect(now.lastRun).toBeUndefined();
  });
  test("agent 在 run 里自己 mission done → 收尾写日志、不再排下一次", async () => {
    const m = await startAndNudge();
    await updateMissions((all) => void Object.assign(all.master, { status: "done" }), path);
    done();
    await until(async () => !!(await cur()).lastRun);
    await settle();
    expect((await cur()).wake).toBeUndefined();
    expect(sent.length).toBe(1);
    expect(readRunLog(m.id!)[0].nextWakeAt).toBeUndefined();
  });
  test("旧一代欠着的到点收尾：新一代开始就作废，不吞新一代的 done、不把「已关闭」发给新一代", async () => {
    await put({ until: new Date(Date.now() - 1000).toISOString() });
    paneBusy = true;
    turnEnd();
    await until(async () => (await cur()).status === "expired");
    await settle();
    expect(sent.length).toBe(0);
    paneBusy = false;
    await put(); // 新一代
    await reconcileMissions();
    await until(async () => !!(await cur()).run?.deliveredAt);
    ev("tool_start", { name: "Edit" });
    done();
    await until(async () => !!(await cur()).lastRun);
    expect(sent.every((e) => !String(e.content).includes("已关闭"))).toBe(true);
    expect((await cur()).lastRun?.outcome).toBe("action_taken");
  });
  test("点了「打断」→ 这一轮收尾，下一次按人类让位规则等，不是 45 秒后又推", async () => {
    await startAndNudge();
    ev("agent_status", { status: "done", trigger: "interrupt" });
    await until(async () => !!(await cur()).lastRun);
    await settle();
    expect(sent.length).toBe(1);
    expect((await cur()).wake).toBeTruthy();
  });
  test("事件的 agent 字段是频道 id（bridge 补发类事件）也按频道认到 master", async () => {
    await put();
    emitEvent({ agent: "ctl", chatId: "ctl", type: "agent_status", data: { status: "thinking" } });
    emitEvent({ agent: "ctl", chatId: "ctl", type: "agent_status", data: { status: "done" } });
    await until(() => sent.length === 1);
  });
  test("重启时补发的 done 用频道 id 当 agent 字段：同样不放行等人拍板", async () => {
    await put({ wakeSeq: 1, wake: { seq: 1, source: "turn_end", dueAt: new Date(Date.now() + 3_600_000).toISOString(), firstAt: new Date().toISOString(), merged: 0, hold: "blocked" } });
    emitEvent({ agent: "ctl", chatId: "ctl", type: "agent_status", data: { status: "done", reason: "bridge_restarted" } });
    await settle();
    expect((await cur()).wake).toMatchObject({ seq: 1, hold: "blocked" });
  });
  test("重启后忙闲未知（Codex / Pi）→ 已投递的 run 不收尾不重递", async () => {
    const t = new Date(Date.now() - 60_000).toISOString();
    await put({ wakeSeq: 1, run: { runId: "run_x", seq: 1, source: "turn_end", merged: 0, firstAt: t, claimedAt: t, deliveredAt: t } });
    paneUnknown = true;
    await reconcileMissions();
    await settle();
    expect((await cur()).run?.runId).toBe("run_x");
    expect(sent.length).toBe(0);
  });
});

describe("第 3 轮复验补的用例", () => {
  test("迟到的 Stop 紧贴在 thinking 之前到：事件到达那一刻还没开始 → 不算这个 run 的结束", async () => {
    deliverImpl = async (env) => {
      done(); // 同一拍：先 Stop 后 thinking
      return realDeliver(env);
    };
    await put();
    turnEnd();
    await until(async () => !!(await cur()).run?.deliveredAt);
    await settle();
    expect((await cur()).lastRun).toBeUndefined();
    ev("tool_start", { name: "Edit" });
    done();
    await until(async () => !!(await cur()).lastRun);
    expect((await cur()).lastRun?.outcome).toBe("action_taken");
  });
  test("watcher 缺位：thinking 挂在「?」名下也认得出，run 的回合结束照常收尾", async () => {
    deliverImpl = async (env) => {
      sent.push(env);
      emitEvent({ agent: "?", chatId: "ctl", type: "agent_status", data: { status: "thinking" } });
      return { envelope: env, outcome: { kind: "sent" } };
    };
    await put();
    turnEnd();
    await until(async () => !!(await cur()).run?.deliveredAt);
    ev("tool_start", { name: "Edit" });
    done();
    await until(async () => !!(await cur()).lastRun);
    expect((await cur()).lastRun?.outcome).toBe("action_taken");
  });
  test("收尾等证据的那几秒里 stop + start：旧一代照样补一行日志", async () => {
    setEvidenceWaitForTest({ minMs: 400, quietMs: 50, maxMs: 2000 });
    const a = await startAndNudge();
    ev("tool_start", { name: "Edit" });
    done();
    await sleep(100);
    await updateMissions((all) => void Object.assign(all.master, { status: "stopped" }), path);
    await put(); // 新一代
    await until(() => readRunLog(a.id!).length === 1);
    expect(readRunLog(a.id!)[0].reason).toContain("换了一代");
    setEvidenceWaitForTest({ minMs: 30, quietMs: 20, maxMs: 300 });
  });
  test("收尾窗口里开的下一个回合（押后消息放出）：它的工具不算进这一轮", async () => {
    setEvidenceWaitForTest({ minMs: 300, quietMs: 100, maxMs: 2000 });
    await startAndNudge();
    ev("tool_start", { name: "Read" });
    done();
    await sleep(100);
    ev("chat_message", { direction: "in", srcKind: "local", text: "peer 的消息" });
    thinking();
    ev("tool_start", { name: "Edit" });
    await until(async () => !!(await cur()).lastRun);
    expect((await cur()).lastRun?.outcome).toBe("normal");
    setEvidenceWaitForTest({ minMs: 30, quietMs: 20, maxMs: 300 });
  });
  test("「标已投递」和收尾连着两次写锁超时：不重投，锁放开后用留下的证据补收尾", async () => {
    const lock = `${path}.lock`;
    setMissionTestHooks({ lockMs: 300 });
    deliverImpl = async (env) => {
      const r = await realDeliver(env);
      mkdirSync(lock); // 别的进程占着锁 1.2 秒
      setTimeout(() => rmdirSync(lock), 1200);
      return r;
    };
    try {
      const m = await put();
      turnEnd();
      await until(() => sent.length === 1);
      await sleep(100);
      ev("tool_start", { name: "Edit" });
      done(); // run 的回合结束：收尾时锁还被占着
      // lastRun（missions.json）先落盘、日志紧跟着追加：rename 的 await 续体可能落后别的读好几拍，只等 lastRun 会偶发读到空日志
      await until(async () => !!(await cur()).lastRun && readRunLog(m.id!).length > 0, 12_000);
      expect(sent.length).toBe(1);
      expect((await cur()).lastRun?.outcome).toBe("action_taken");
      expect((await cur()).nudges).toBe(1);
      expect(readRunLog(m.id!)).toHaveLength(1);
    } finally {
      setMissionTestHooks({ lockMs: 10_000 });
    }
  }, 20_000);
  /** 投递后别的进程一直占着写锁 → 收尾写锁超时；放锁的同一拍做 change（acquireLock 第一次 mkdir 是同步的，重试插不进来），再按文件重排 */
  async function closeStuckThen(change: () => Promise<unknown>): Promise<Mission> {
    const lock = `${path}.lock`;
    setMissionTestHooks({ lockMs: 300, lockRetryMs: 200 });
    let held = false;
    deliverImpl = async (env) => {
      const r = await realDeliver(env);
      if (!held) (held = true), mkdirSync(lock); // 只占第一次：换代后新一代的第一句照常递
      return r;
    };
    const m = await put();
    turnEnd();
    await until(() => sent.length === 1);
    await sleep(100);
    ev("tool_start", { name: "Edit" });
    done();
    const runId = (await cur()).run!.runId;
    await until(() => !!pendingCloseOf(runId));
    rmdirSync(lock);
    await change();
    await reconcileMissions(); // 文件监听看到变化：mission 的定时器被撤掉 / 改排给新一代，收尾重试不能跟着没了
    return m;
  }
  const restoreLockHooks = () => setMissionTestHooks({ lockMs: 10_000, lockRetryMs: AUTOPILOT_TIMING.lockRetryMs });
  test("收尾写锁超时、重试之前被 stop：锁放开后照样补收尾、写日志，不再排下一次", async () => {
    try {
      const m = await closeStuckThen(() => updateMissions((all) => void Object.assign(all.master, { status: "stopped" }), path));
      await until(() => readRunLog(m.id!).length > 0);
      await settle();
      expect(readRunLog(m.id!)).toHaveLength(1);
      expect(readRunLog(m.id!)[0]).toMatchObject({ outcome: "action_taken" });
      expect(readRunLog(m.id!)[0].nextWakeAt).toBeUndefined();
      expect(await cur()).toMatchObject({ status: "stopped", nudges: 1, lastRun: { outcome: "action_taken" } });
      expect(sent.length).toBe(1);
    } finally {
      restoreLockHooks();
    }
  });
  test("收尾写锁超时、重试之前换了一代：锁放开后给旧一代补一行日志，不记到新一代头上", async () => {
    try {
      const m = await closeStuckThen(() => put());
      await until(() => readRunLog(m.id!).length > 0);
      await settle();
      expect(readRunLog(m.id!)).toHaveLength(1);
      expect(readRunLog(m.id!)[0]).toMatchObject({ outcome: "action_taken" });
      expect(readRunLog(m.id!)[0].reason).toContain("换了一代");
      expect((await cur()).lastRun).toBeUndefined();
    } finally {
      restoreLockHooks();
    }
  });
});

describe("P2-9：只有人类信号和真实的新回合才放行待命", () => {
  /** 连续第 3 轮没进展 → 这一轮收尾后进待命 5 分钟 */
  async function intoStandby(): Promise<void> {
    await put({ lastRun: { runId: "p", outcome: "normal", endedAt: new Date(Date.now() - 60_000).toISOString(), streaks: { idle: 2, fail: 0 } } });
    turnEnd();
    await until(async () => !!(await cur()).run?.deliveredAt);
    done(); // run 的回合结束（投递时已发过 thinking）
    await until(async () => (await cur()).wake?.hold === "standby");
  }
  test("同一回合重复的 Stop 不放行", async () => {
    await intoStandby();
    done();
    await settle();
    expect((await cur()).wake?.hold).toBe("standby");
  });
  test("Stop 之后才读到的本回合最后几行（reply 工具、最后一句话）不会重新点亮，随后的重复 done 不放行", async () => {
    await intoStandby();
    ev("tool_start", { name: "mcp__claudestra__reply", detail: "{}" });
    ev("reply_pending", {});
    ev("assistant_text", { text: "查完了，没有要推进的。" });
    done();
    await settle();
    expect((await cur()).wake?.hold).toBe("standby");
  });
  test("reconcile 补发的 done：生产里只在 thinking 卡住时补发（一个真实回合没收到 Stop），放行", async () => {
    await intoStandby();
    thinking(); // jsonl_activity：终端里直接开了个回合
    ev("agent_status", { status: "done", trigger: "reconcile" });
    await until(async () => (await cur()).wake?.hold === undefined);
  });
  test("人类消息之后的回合结束放行", async () => {
    await intoStandby();
    // 人类消息要严格晚于 lastRun.endedAt 才算「之后」：等时钟真走过它再发，同一毫秒发会偶发不放行（CI 超时）
    const endedAt = Date.parse((await cur()).lastRun!.endedAt);
    await until(() => Date.now() > endedAt);
    ev("chat_message", { direction: "in", srcKind: "user", text: "有新活了" });
    done();
    await until(async () => (await cur()).wake?.hold === undefined);
  });
  test("和 run 结束同一毫秒的人类消息不算之后，回合结束不放行", async () => {
    await intoStandby();
    const endedAt = Date.parse((await cur()).lastRun!.endedAt);
    const realNow = Date.now;
    Date.now = () => endedAt;
    try {
      ev("chat_message", { direction: "in", srcKind: "user", text: "有新活了" });
    } finally {
      Date.now = realNow;
    }
    done();
    await settle();
    expect((await cur()).wake?.hold).toBe("standby");
  });
  test("待命期间 watcher 缺位：人类消息挂在「?」名下，照样让位", async () => {
    await intoStandby();
    emitEvent({ agent: "?", chatId: "ctl", type: "chat_message", data: { direction: "in", srcKind: "user", text: "我来了" } });
    thinking();
    done();
    await until(async () => (await cur()).wake?.hold === undefined);
    await settle();
    expect(sent.length).toBe(1); // 放行了，但人刚说过话 → 让位，不立刻递
  });
  test("真实的新回合（有 thinking / 工具活动）结束放行", async () => {
    await intoStandby();
    thinking();
    ev("tool_start", { name: "Read" });
    done();
    await until(async () => (await cur()).wake?.hold === undefined);
  });
});

describe("T14f 第 1 轮审查补的流程用例", () => {
  test("run 结束后下一回合的 thinking 先到、本回合的撞额度后到：仍判 rate_limited，按额度挂起", async () => {
    await startAndNudge();
    done(); // run 的回合结束
    thinking(); // 押后的 agent 消息紧跟着开了新回合
    await sleep(5);
    ev("api_error_turn", { error: "rate_limit" });
    ev("assistant_text", { text: "You've hit your limit · resets 3am (Asia/Tokyo)" });
    await until(async () => !!(await cur()).lastRun);
    expect((await cur()).lastRun?.outcome).toBe("rate_limited");
    expect((await cur()).wake?.hold).toBe("rate_limit");
  });
});
