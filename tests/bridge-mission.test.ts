/**
 * bridge/mission.ts：回合结束 → 宽限期后递提醒；人在说话（忙）就让位；空转两次开始退避；到点递收尾并关闭。
 * 用 master（频道取 controlChannelId，不读真实 registry）+ 临时状态文件 + 缩短的宽限期。
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initMission, setMissionTestHooks } from "../src/bridge/mission.js";
import { emitEvent } from "../src/bridge/event-bus.js";
import type { Envelope } from "../src/bridge/router.js";
import { readMissions, updateMissions, type Mission } from "../src/lib/missions.js";

const sent: Envelope[] = [];
const path = join(mkdtempSync(join(tmpdir(), "bridge-mission-")), "missions.json");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const done = () => emitEvent({ agent: "master", chatId: "ctl", type: "agent_status", data: { status: "done" } });
const thinking = () => emitEvent({ agent: "master", chatId: "ctl", type: "agent_status", data: { status: "thinking" } });

async function put(over: Partial<Mission>): Promise<void> {
  const m: Mission = {
    agent: "master", goal: "按台账推进", until: new Date(Date.now() + 3_600_000).toISOString(), createdAt: new Date().toISOString(),
    status: "active", nudges: 0, fastTurns: 0, ...over,
  };
  await updateMissions((all) => void (all.master = m), path);
}

let paneBusy = false;
beforeAll(() => {
  setMissionTestHooks({ path, graceMs: 50, paneBusy: async () => paneBusy });
  initMission({
    clients: new Map([["ctl", { ws: {} as never, channelId: "ctl", cwd: "/tmp" }]]),
    deliver: async (env) => void sent.push(env),
    lastMessageSource: { set: () => undefined },
    controlChannelId: "ctl",
  });
});
afterAll(() => updateMissions((all) => void delete all.master, path));

describe("值守推进", () => {
  test("回合结束 → 宽限期后递一句 continue；计数 +1", async () => {
    await put({});
    done();
    await sleep(250);
    expect(sent.length).toBe(1);
    expect(sent[0].from).toEqual({ kind: "bridge", label: "mission" });
    expect(sent[0].content).toContain("[⏱ 值守] 目标：按台账推进");
    expect((await readMissions(path)).master.nudges).toBe(1);
  });
  test("宽限期里人来说话（转忙）→ 不递", async () => {
    sent.length = 0;
    await put({ lastNudgeAt: new Date(Date.now() - 600_000).toISOString() });
    done();
    thinking();
    await sleep(250);
    expect(sent.length).toBe(0);
  });
  test("画面还在忙（bridge 刚重启、状态表是空的）→ 不递，等它这一轮结束", async () => {
    sent.length = 0;
    await put({ lastNudgeAt: new Date(Date.now() - 600_000).toISOString() });
    paneBusy = true;
    done();
    await sleep(250);
    paneBusy = false;
    expect(sent.length).toBe(0);
  });
  test("提醒后很快又结束两次 → 进入退避（resumeAt 约 5 分钟后），这次不递", async () => {
    sent.length = 0;
    await put({ lastNudgeAt: new Date().toISOString(), fastTurns: 1 });
    done();
    await sleep(250);
    const m = (await readMissions(path)).master;
    expect(m.fastTurns).toBe(2);
    expect(Date.parse(m.resumeAt!) - Date.now()).toBeGreaterThan(4 * 60_000);
    expect(sent.length).toBe(0);
  });
  test("过了截止时间 → 递收尾、值守变 expired", async () => {
    sent.length = 0;
    await put({ until: new Date(Date.now() - 1000).toISOString() });
    done();
    await sleep(250);
    expect(sent.length).toBe(1);
    expect(sent[0].content).toContain("值守已关闭");
    expect((await readMissions(path)).master.status).toBe("expired");
  });
  test("不在进行中的值守不管", async () => {
    sent.length = 0;
    await put({ status: "done" });
    done();
    await sleep(250);
    expect(sent.length).toBe(0);
  });
});
