/**
 * NRT-1 第 2 轮：续跑计划落盘的取消 / 陈旧 / 等不回来，和黑洞式断网（每轮 10 分钟以上才失败）的升级。
 * 和 tests/quota-wall-resume-rearm.test.ts 一样把 bridge/quota-wall-wiring.ts 从 RESUME_LABEL 往后截出来、注入依赖跑真实事件处理；
 * 「重启」= 再起一份 wiring，从同一个状态文件（测试临时目录里的 RESUME_STATES_PATH）读回。
 */
import { afterAll, beforeEach, expect, spyOn, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import * as rules from "../src/lib/api-error-resume.js";
import { isModelLimitHit } from "../src/lib/quota-wall-text.js";
import { HeldQueue } from "../src/bridge/held-queue.js";
import { readRegistryAgentsSync, REGISTRY_PATH } from "../src/lib/registry.js";
import { countsAsWallActivity, isHumanSender } from "../src/lib/quota-wall.js";
import { TRANSIENT_BACKOFF_MS } from "../src/lib/transient-error.js";

const source = readFileSync(new URL("../src/bridge/quota-wall-wiring.ts", import.meta.url), "utf8");
const js = new Bun.Transpiler({ loader: "ts" }).transformSync(source.slice(source.indexOf("const RESUME_LABEL")).replace(/export /g, ""));
const drain = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };
const P = rules.RESUME_STATES_PATH;
const MSG = "Pi 回合失败：Connection error.";
let NOW = Date.parse("2026-10-16T16:36:00+08:00");
const clock = spyOn(Date, "now").mockImplementation(() => NOW);
const REG_BEFORE = existsSync(REGISTRY_PATH) ? readFileSync(REGISTRY_PATH, "utf8") : null;
afterAll(() => {
  clock.mockRestore();
  // registry 在同一 bun 进程的各测试文件间共享：不还原，同分片后跑的 tests/fleet-routes.test.ts 会多出 agent-net
  if (REG_BEFORE === null) rmSync(REGISTRY_PATH, { force: true });
  else writeFileSync(REGISTRY_PATH, REG_BEFORE);
});
/** 测试状态目录里的 registry：agentKept 用真实判定读它 */
function registry(status: string | null) {
  mkdirSync(dirname(REGISTRY_PATH), { recursive: true });
  writeFileSync(REGISTRY_PATH, JSON.stringify({ agents: status ? { "agent-net": { status, channelId: "123456", cwd: "/x" } } : {} }));
}
beforeEach(() => {
  rmSync(P, { force: true });
  registry("active");
});

function wiring(connected: () => boolean = () => true) {
  let handler!: (e: unknown) => void, tick!: () => void, seq = 0;
  const sends: number[] = [];
  const notices: string[] = [];
  const escalated: string[] = [];
  const w = { onExit: () => {}, noteApiError: async () => false, active: () => false, noteActivity: () => null, tick: async () => {} };
  const b = {
    held: new HeldQueue(null), calls: { values: () => [] }, clients: { get: () => (connected() ? { ws: {} } : undefined) }, flush: async () => {},
    deliver: async (e: unknown) => (sends.push(NOW), { envelope: e, outcome: { kind: "sent" } }), markAgentSource: () => {}, escalate: async (_: string, t: string) => void escalated.push(t),
  };
  const deps: Record<string, unknown> = {
    ...rules, isModelLimitHit, countsAsWallActivity, isHumanSender, productionWall: () => w,
    subscribeEvents: (_: unknown, f: (e: unknown) => void) => { handler = f; }, recordMetric: () => {}, noteTurnCut: () => {},
    emitEvent: (e: { data?: { notice?: boolean; text?: string } }) => void (e.data?.notice && notices.push(String(e.data.text))),
    setInterval: (f: () => void) => { tick = f; }, newMessageId: () => `m${++seq}`, newThreadId: () => `t${++seq}`, TICK_MS: 15_000,
    readRegistryAgentsSync,
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
  return { sends, notices, escalated, event, run, untilResume, err: (error = MSG) => event("api_error_turn", { error, text: `API Error: ${error}` }) };
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

// ── NRT-2 ──

test("turn-ok-depends-on-card-close：孤立的网络错误隔 40 分钟各撞一次，每次续跑后正常结束（stop-settle → channelTurnOk，不经关卡）→ 每次都 60 秒续、不报", async () => {
  const f = wiring();
  for (let i = 0; i < 5; i++) {
    await f.err();
    const at = NOW;
    expect(await f.untilResume()).toBe(true);
    expect(f.sends.at(-1)! - at).toBeLessThanOrEqual(TRANSIENT_BACKOFF_MS[0] + 15_000);
    NOW += 30_000;
    rules.channelTurnOk("123456", NOW); // 续跑那一轮正常结束
    NOW += 40 * 60_000;
  }
  expect(f.sends).toHaveLength(5);
  expect(f.notices).toEqual([]);
});

test("stale-resume-after-sleep：同一进程里机器睡了 9 小时醒来，到期的续跑不投、不报", async () => {
  const f = wiring();
  await f.err();
  NOW += 9 * 3600_000;
  await f.run(60_000);
  expect(f.sends).toEqual([]);
  expect(f.notices).toEqual([]);
  expect(JSON.parse(readFileSync(P, "utf8"))).toEqual({});
});

test("offline-drop-noise：到点没连着、agent 已被 remove（registry 没这一行）→ 当场丢，不往频道报", async () => {
  registry(null);
  const f = wiring(() => false);
  await f.err();
  await f.run(60 * 60_000);
  expect(f.sends).toEqual([]);
  expect(f.notices).toEqual([]);
  expect(f.escalated).toEqual([]);
  expect(JSON.parse(readFileSync(P, "utf8"))).toEqual({});
});

test("offline-drop-noise（W2）：agent 被 kill（registry 条目置 stopped、channelId 留着）→ 不等半小时、不往频道报", async () => {
  const f = wiring(() => false);
  await f.err();
  registry("stopped");
  await f.run(60 * 60_000);
  expect(f.notices).toEqual([]);
  expect(f.escalated).toEqual([]);
  expect(JSON.parse(readFileSync(P, "utf8"))).toEqual({});
});

test("非网络类到点没连着：静默等几分钟，过了只记日志、不报", async () => {
  const f = wiring(() => false);
  await f.err("Prompt is too long");
  await f.run(2 * 60_000);
  expect(Object.keys(JSON.parse(readFileSync(P, "utf8")))).toEqual(["123456"]); // 宽限内留着
  await f.run(60 * 60_000);
  expect(JSON.parse(readFileSync(P, "utf8"))).toEqual({});
  expect(f.notices).toEqual([]);
  expect(f.escalated).toEqual([]);
});

test("W3：非网络类错误后 50 秒 bridge 重启，agent 20 秒后才连回 → 照样续跑一次", async () => {
  await wiring().err("API Error: 400 invalid_request_error tool_use ids must be unique");
  NOW += 50_000;
  let up = false;
  const after = wiring(() => up);
  await after.run(15_000);
  up = true;
  await after.run(2 * 60_000);
  expect(after.sends).toHaveLength(1);
  expect(after.notices).toEqual([]);
});

test("W1：bridge 停机 9 小时后开机，agent 第一拍还没连回来 → 陈旧计划只记日志，不报「一直没连上」", async () => {
  await wiring().err();
  NOW += 9 * 3600_000;
  let up = false;
  const after = wiring(() => up);
  await after.run(15_000);
  up = true;
  await after.run(5 * 60_000);
  expect(after.sends).toEqual([]);
  expect(after.notices).toEqual([]);
  expect(after.escalated).toEqual([]);
});

for (const down of [5, 10]) {
  test(`W4：非网络类错误后 bridge 停 ${down} 分钟，开机后 agent 20 秒才连回 → 宽限从本进程看到它没连着起算，照样续跑`, async () => {
    await wiring().err("API Error: 400 invalid_request_error tool_use ids must be unique");
    NOW += down * 60_000;
    let up = false;
    const after = wiring(() => up);
    await after.run(15_000);
    NOW += 5_000;
    up = true;
    await after.run(2 * 60_000);
    expect(after.sends).toHaveLength(1);
    expect(after.notices).toEqual([]);
  });
}
