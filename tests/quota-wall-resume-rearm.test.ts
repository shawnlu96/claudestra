/**
 * 撞额度撤续跑之后，外人回合的 Stop（stop-settle 调 rearmResume）不能把旧计划挂回来（T52 Codex 复审 #208 第 5 轮 P2-2）。
 * 按 Codex 复审给的做法：把 bridge/quota-wall-wiring.ts 从 RESUME_LABEL 往后截出来、注入依赖，跑真实的 startQuotaWall 事件处理
 * （生产的额度闸要读写状态文件、抓屏，这里换成空壳）。截取点或依赖名变了这里会直接报错，照着改就行。
 */
import { expect, spyOn, test } from "bun:test";
import { readFileSync } from "node:fs";
import * as rules from "../src/lib/api-error-resume.js";
import { isModelLimitHit } from "../src/lib/quota-wall-text.js";
import { HeldQueue } from "../src/bridge/held-queue.js";
import { countsAsWallActivity, isHumanSender } from "../src/lib/quota-wall.js";

const source = readFileSync(new URL("../src/bridge/quota-wall-wiring.ts", import.meta.url), "utf8");
const js = new Bun.Transpiler({ loader: "ts" }).transformSync(source.slice(source.indexOf("const RESUME_LABEL")).replace(/export /g, ""));
const drain = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };

function fixture() {
  let now = 100_000, handler!: (e: unknown) => void, tick!: () => void, seq = 0;
  const sends: { content: string }[] = [];
  const w = { onExit: () => {}, noteApiError: async () => false, active: () => false, noteActivity: () => null, tick: async () => {} };
  const b = {
    held: new HeldQueue(null), calls: { values: () => [] }, clients: { get: () => ({ ws: {} }) }, flush: async () => {},
    deliver: async (e: { content: string }) => (sends.push(e), { envelope: e, outcome: { kind: "sent" } }),
    markAgentSource: () => {}, escalate: async () => {},
  };
  const deps: Record<string, unknown> = {
    ...rules, isModelLimitHit, countsAsWallActivity, isHumanSender, productionWall: () => w,
    subscribeEvents: (_: unknown, f: (e: unknown) => void) => { handler = f; }, recordMetric: () => {}, emitEvent: () => {}, noteTurnCut: () => {},
    setInterval: (f: () => void) => { tick = f; }, newMessageId: () => `m${++seq}`, newThreadId: () => `t${++seq}`, TICK_MS: 15_000,
  };
  const mod = new Function(...Object.keys(deps), `let bridge, wall; const earlyExitListeners = [];\n${js}\nreturn { startQuotaWall, rearmResume };`)(...Object.values(deps));
  const clock = spyOn(Date, "now").mockImplementation(() => now);
  mod.startQuotaWall(b);
  const event = (type: string, data: Record<string, unknown>) => handler({ agent: "agent-cx", chatId: "ch", ts: new Date(now).toISOString(), type, data });
  return { sends, event, rearm: mod.rearmResume as (cid: string) => void, tick: () => tick(), advance: (n: number) => { now += n; }, done: () => clock.mockRestore() };
}

test("server_error → 外人消息开了新回合（计划挪去待 rearm）→ 这一轮撞 Codex 额度 → 外人回合 Stop 调 rearm：旧计划不复活，61 秒后不投「继续」", async () => {
  const f = fixture();
  try {
    f.event("api_error_turn", { error: "server_error" });
    await drain();
    f.advance(5_000);
    f.event("tool_start", { toolId: "x1", name: "Bash" }); // 外人消息开的回合在动
    f.advance(1_000);
    f.event("assistant_text", { text: "You've hit your usage limit. Try again at 8:41 AM.", rateLimited: true });
    await drain();
    f.rearm("ch");
    f.advance(61_000);
    f.tick();
    await drain();
    expect(f.sends).toHaveLength(0);
  } finally {
    f.done();
  }
});

test("对照：没撞额度时，外人回合 Stop 照常把续跑挂回来", async () => {
  const f = fixture();
  try {
    f.event("api_error_turn", { error: "server_error" });
    await drain();
    f.advance(5_000);
    f.event("tool_start", { toolId: "x1", name: "Bash" });
    f.rearm("ch");
    f.advance(61_000);
    f.tick();
    await drain();
    expect(f.sends.map((s) => s.content.includes("server_error"))).toEqual([true]);
  } finally {
    f.done();
  }
});
