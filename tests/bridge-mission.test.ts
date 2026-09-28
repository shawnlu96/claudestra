/**
 * bridge/mission.ts：回合结束 → 落盘唤醒 → 宽限期后领成 run、递提醒；run 的回合结束按事件归类、写日志、按结果排下次；
 * 人在说话 / 画面忙 / 人刚发过消息就让位；到点递收尾并关闭；bridge 重启（落盘的 run / 唤醒）不丢不重。
 * 用 master（频道取 controlChannelId，不读真实 registry）+ 临时状态文件 + 缩短的宽限期；日志落在 preload 隔离的状态目录。
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initMission, reconcileMissions, setMissionTestHooks } from "../src/bridge/mission.js";
import { emitEvent, type BridgeEventType } from "../src/bridge/event-bus.js";
import { resetAutopilotEvidence } from "../src/bridge/autopilot-evidence.js";
import type { Envelope } from "../src/bridge/router.js";
import { readRunLog } from "../src/lib/autopilot-log.js";
import { newMission, readMissions, updateMissions, type Mission } from "../src/lib/missions.js";

const sent: Envelope[] = [];
const path = join(mkdtempSync(join(tmpdir(), "bridge-mission-")), "missions.json");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const ev = (type: BridgeEventType, data: Record<string, unknown>) => emitEvent({ agent: "master", chatId: "ctl", type, data });
const done = () => ev("agent_status", { status: "done" });
const thinking = () => ev("agent_status", { status: "thinking" });
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
  done();
  await until(async () => sent.length === 1 && !!(await cur()).run?.deliveredAt);
  return m;
}

let paneBusy = false;
beforeAll(() => {
  setMissionTestHooks({ path, graceMs: 50, reconcileDelayMs: 20, turnBusy: async () => paneBusy });
  initMission({
    clients: new Map([["ctl", { ws: {} as never, channelId: "ctl", cwd: "/tmp" }]]),
    deliver: async (env) => void sent.push(env),
    lastMessageSource: { set: () => undefined },
    controlChannelId: "ctl",
  });
});
beforeEach(async () => {
  paneBusy = false;
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
    done();
    thinking();
    await settle();
    expect(sent.length).toBe(0);
  });
  test("画面还在忙（bridge 刚重启、状态表是空的）→ 不递，唤醒留在队列里", async () => {
    await put();
    paneBusy = true;
    done();
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
    done();
    await until(() => sent.length === 1);
    expect(sent[0].content).toContain("Autopilot 已关闭");
    expect((await cur()).status).toBe("expired");
  });
  test("到点时 agent 正忙：照样立刻 expired（不再续跑），收尾那句等它这一轮结束再递", async () => {
    await put({ until: new Date(Date.now() - 1000).toISOString() });
    paneBusy = true;
    done();
    await settle();
    expect(sent.length).toBe(0);
    expect((await cur()).status).toBe("expired");
    paneBusy = false;
    done();
    await until(() => sent.length === 1);
    expect(sent[0].content).toContain("Autopilot 已关闭");
  });
  test("不在进行中的不管", async () => {
    await put({ status: "done" });
    done();
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
