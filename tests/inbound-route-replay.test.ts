/**
 * 回放夹具（JRT 验收 4）：调研的 12 + 4 个合成例，Jev 的答案是录好的（tests/fixtures/inbound-route/cases.json），CI 不打外网。
 * 走的是真的运行时路径（routeInbound → 该不该问 → decideRoute → 代码兜底），最后的投法和预期一致：peer 喊停那例录到的是
 * interrupt 0.97，由代码兜底改成排队。agent→agent 的例按目标插得进（steer）回放。重录没有答案的例：TYPESAFE_API_KEY=… INBOUND_ROUTE_RECORD=1 bun test tests/inbound-route-replay.test.ts
 * （INBOUND_ROUTE_RECORD=all 全部重录）
 */
import { afterAll, describe, expect, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { configureInboundRoute, routeAdmitsWhileBusy, routeInbound } from "../src/bridge/inbound-route.js";
import type { HeldItem } from "../src/bridge/held-queue.js";
import { isHumanRequest, type Envelope, type LocalEndpoint } from "../src/bridge/router.js";
import { jevAsk } from "../src/lib/jev.js";
import { ruleAction } from "../src/lib/inbound-route.js";

interface Case {
  name: string; expect: "interrupt" | "insert" | "queue" | "merge"; current: string;
  queued: { from: string; text: string }[]; incoming: { from: string; text: string }; answers: Record<string, unknown>;
}
const FIXTURE = join(import.meta.dir, "fixtures/inbound-route/cases.json");
const fixture = JSON.parse(readFileSync(FIXTURE, "utf8")) as { model: string; cases: Case[] };
const RECORD_ALL = process.env.INBOUND_ROUTE_RECORD === "all";
const RECORD = process.env.INBOUND_ROUTE_RECORD === "1" || RECORD_ALL;

const to = { kind: "local", channelId: "ch1", agentName: "agent-dev", ws: { send() {} } } as unknown as LocalEndpoint;
/** 夹具里的发送人 → bridge 认证过的身份：owner = Discord 用户，peer:X = HTTP peer，其余是本机 agent（调度器也是） */
function fromOf(who: string): Envelope["from"] {
  if (who === "owner") return { kind: "user", userId: "u-owner", username: "owner", channelId: "c-owner" };
  if (who.startsWith("peer:")) return { kind: "api", tokenId: "tok-peer", name: who.slice(5), peer: who.slice(5) };
  return { kind: "local", channelId: `c-${who}`, agentName: who } as Envelope["from"];
}
let n = 0;
const envOf = (m: { from: string; text: string }): Envelope => {
  const from = fromOf(m.from);
  const meta = { messageId: `r${++n}`, threadId: `t${n}`, ts: "2026-10-16T00:00:00Z", triggerKind: from.kind === "api" ? "peer_http" : "user_discord" };
  return { from, to, intent: "request", content: m.text, meta } as Envelope;
};

afterAll(() => {
  configureInboundRoute({ ask: jevAsk, readMode: () => "off", log: () => {}, now: () => Date.now() });
  if (RECORD) writeFileSync(FIXTURE, `${JSON.stringify(fixture, null, 1)}\n`);
});

describe("回放：合成例（调研 12 + 4，JRT-3 加 6 例 agent→agent）", () => {
  for (const c of fixture.cases) {
    test(`${c.name} → ${c.expect}`, async () => {
      const queue: HeldItem[] = c.queued.map((m) => ({ env: envOf(m), to, heldAt: 1 }));
      configureInboundRoute({
        readMode: () => "on", probe: async () => ({ main: "busy", bg: false }), queue: () => queue, doing: async () => c.current, log: () => {}, now: () => 0,
        insertDecl: async () => "steer",
        ask: (async (state: unknown, questions: Record<string, unknown>, opts: unknown) => {
          const replay = !RECORD || (!RECORD_ALL && Object.keys(c.answers).length > 0);
          if (replay) return { model: fixture.model, answers: c.answers, usage: { input_tokens: 0, output_tokens: 0 }, latencyMs: 0, costUsd: 0 };
          const r = await jevAsk(state as never, questions as never, { ...(opts as object), timeoutMs: 20_000 });
          c.answers = r.answers as Record<string, unknown>;
          fixture.model = r.model;
          return r;
        }) as unknown as typeof jevAsk,
      });
      const e = envOf(c.incoming);
      await routeInbound(e, to, "agent-dev");
      // 没判（停字直接打断 / 拿不准）= 现有规则
      const got = e.meta.inboundRoute?.action ?? ruleAction(isHumanRequest(e), e.from.kind === "local");
      expect(got).toBe(c.expect);
      if (c.expect === "merge") expect(e.meta.inboundRoute?.mergeWith).toBe(queue[0].env.meta.messageId);
      if (e.from.kind !== "user") expect(routeAdmitsWhileBusy(e)).toBe(false); // 非 owner 一律不打断
    });
  }
});
