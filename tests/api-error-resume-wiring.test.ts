/**
 * NRT-1 第 2 轮：续跑计划落盘的取消 / 陈旧 / 等不回来，和黑洞式断网（每轮 10 分钟以上才失败）的升级。
 * 和 tests/quota-wall-resume-rearm.test.ts 一样把 bridge/quota-wall-wiring.ts 从 RESUME_LABEL 往后截出来、注入依赖跑真实事件处理；
 * 「重启」= 再起一份 wiring，从同一个状态文件（测试临时目录里的 RESUME_STATES_PATH）读回。
 */
import { afterAll, beforeEach, expect, spyOn, test } from "bun:test";
import { existsSync, readFileSync, rmSync } from "node:fs";
import * as rules from "../src/lib/api-error-resume.js";
import { isModelLimitHit } from "../src/lib/quota-wall-text.js";
import { HeldQueue } from "../src/bridge/held-queue.js";
import { countsAsWallActivity, isHumanSender } from "../src/lib/quota-wall.js";
import { TRANSIENT_BACKOFF_MS } from "../src/lib/transient-error.js";

const source = readFileSync(new URL("../src/bridge/quota-wall-wiring.ts", import.meta.url), "utf8");
const js = new Bun.Transpiler({ loader: "ts" }).transformSync(source.slice(source.indexOf("const RESUME_LABEL")).replace(/export /g, ""));
const drain = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };
const P = rules.RESUME_STATES_PATH;
const MSG = "Pi 回合失败：Connection error.";
let NOW = Date.parse("2026-10-16T16:36:00+08:00");
const clock = spyOn(Date, "now").mockImplementation(() => NOW);
afterAll(() => clock.mockRestore());
beforeEach(() => rmSync(P, { force: true }));

function wiring(connected: () => boolean = () => true) {
  let handler!: (e: unknown) => void, tick!: () => void, seq = 0;
  const sends: number[] = [];
  const notices: string[] = [];
  const w = { onExit: () => {}, noteApiError: async () => false, active: () => false, noteActivity: () => null, tick: async () => {} };
  const b = {
    held: new HeldQueue(null), calls: { values: () => [] }, clients: { get: () => (connected() ? { ws: {} } : undefined) }, flush: async () => {},
    deliver: async (e: unknown) => (sends.push(NOW), { envelope: e, outcome: { kind: "sent" } }), markAgentSource: () => {}, escalate: async () => {},
  };
  const deps: Record<string, unknown> = {
    ...rules, isModelLimitHit, countsAsWallActivity, isHumanSender, productionWall: () => w,
    subscribeEvents: (_: unknown, f: (e: unknown) => void) => { handler = f; }, recordMetric: () => {}, noteTurnCut: () => {},
    emitEvent: (e: { data?: { notice?: boolean; text?: string } }) => void (e.data?.notice && notices.push(String(e.data.text))),
    setInterval: (f: () => void) => { tick = f; }, newMessageId: () => `m${++seq}`, newThreadId: () => `t${++seq}`, TICK_MS: 15_000,
  };
  const mod = new Function(...Object.keys(deps), `let bridge, wall; const earlyExitListeners = [];\n${js}\nreturn { startQuotaWall };`)(...Object.values(deps));
  mod.startQuotaWall(b);
  const event = async (type: string, data: Record<string, unknown>) => {
    handler({ agent: "agent-net", chatId: "123456", ts: new Date(NOW).toISOString(), type, data });
    await drain();
  };
  const run = async (ms: number) => {
    for (const end = NOW + ms; NOW < end;) {
      NOW += 15_000;
      tick();
      await drain();
    }
  };
  /** 跑到下一次续跑发出（最多 maxMs） */
  const untilResume = async (maxMs = 20 * 60_000) => {
    const n = sends.length;
    for (const end = NOW + maxMs; sends.length === n && NOW < end;) await run(15_000);
    return sends.length > n;
  };
  return { sends, notices, event, run, untilResume, err: () => event("api_error_turn", { error: MSG, text: `API Error: ${MSG}` }) };
}

test("撞错后有人发消息取消了续跑，15 秒那拍落盘之前重启：不再注入「继续」", async () => {
  const before = wiring();
  await before.err();
  NOW += 20_000;
  await before.event("chat_message", { direction: "in", from: "owner", text: "停" });
  const after = wiring(); // 重启
  await after.run(5 * 60_000);
  expect(after.sends).toEqual([]);
});

test("bridge 停了 9 小时再开机：陈旧的续跑计划丢掉，不投", async () => {
  await wiring().err();
  NOW += 9 * 3600_000;
  const after = wiring();
  await after.run(5 * 60_000);
  expect(after.sends).toEqual([]);
  expect(JSON.parse(readFileSync(P, "utf8"))).toEqual({});
});

test("重启后 agent 过了几分钟才连回来：计划留着，连回来就续", async () => {
  await wiring().err();
  let up = false;
  const after = wiring(() => up);
  await after.run(5 * 60_000);
  expect(after.sends).toEqual([]);
  up = true;
  await after.run(30_000);
  expect(after.sends).toHaveLength(1);
});

test("重启后 agent 一直没连回来：撞错满半小时作废，频道报一次，不再静默删", async () => {
  await wiring().err();
  const after = wiring(() => false);
  await after.run(60 * 60_000);
  expect(after.sends).toEqual([]);
  expect(after.notices).toHaveLength(1);
  expect(after.notices[0]).toContain("一直没连上 bridge");
  expect(existsSync(P) && JSON.parse(readFileSync(P, "utf8"))).toEqual({});
});

test("黑洞式断网：每次续跑后要 11 分钟才失败，仍然续 4 次后第 5 次报一次", async () => {
  const f = wiring();
  await f.err();
  for (let i = 0; i < TRANSIENT_BACKOFF_MS.length; i++) {
    expect(await f.untilResume()).toBe(true);
    NOW += 11 * 60_000; // 续跑那一轮卡在超时上，11 分钟后才以错误结束
    await f.err();
  }
  expect(f.sends).toHaveLength(TRANSIENT_BACKOFF_MS.length);
  expect(f.notices).toHaveLength(1);
  expect(f.notices[0]).toContain(`连续 ${TRANSIENT_BACKOFF_MS.length + 1} 次网络类错误`);
  await f.run(30 * 60_000);
  expect(f.notices).toHaveLength(1);
});
