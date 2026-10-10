import { afterEach, expect, test } from "bun:test";
import { PM_DIGEST_WINDOW_MS } from "../src/lib/pm-digest.js";
import { deliverPmLocal } from "../src/bridge/local-api/project-pm-delivery.js";
import { AgentCallBook } from "../src/bridge/agent-calls.js";
import { pmDigest } from "../src/bridge/pm-digest.js";
import { switchProjectPm } from "../src/lib/pm-role-switch.js";
import { PmDigestStore } from "../src/lib/pm-digest-store.js";
import type { Delivery, Envelope, LocalEndpoint } from "../src/bridge/router.js";
import { A, B, P, pmFixture } from "./pm-role-fixture.test.js";

const fixtures: ReturnType<typeof pmFixture>[] = [];
const defaults = { ...pmDigest.deps };
afterEach(() => { for (const f of fixtures.splice(0)) f.close(); new PmDigestStore().setMode(P, "observe"); pmDigest.stop(); Object.assign(pmDigest.deps, defaults); });
const ws = { send: () => {} } as unknown as LocalEndpoint["ws"];
const toA: LocalEndpoint = { kind: "local", agentName: A, channelId: "channel-a", ws };
let seq = 0;
const env = (from: Envelope["from"], content: string, oneShot: boolean): Envelope => ({ from, to: toA, intent: "request", content,
  meta: { messageId: `dd${++seq}`, threadId: `t${seq}`, ts: "2026-10-10T00:00:00Z", triggerKind: "agent_tool", ...(oneShot ? { skipInterAgentWatchdog: true } : {}) } });

async function world(mode: "on" | "observe") {
  const f = pmFixture();
  fixtures.push(f);
  await switchProjectPm(f.db, P, B, { actor: "owner" }, f.deps);
  new PmDigestStore().setMode(P, mode);
  const state = await f.deps.read(), book = new AgentCallBook(null), receipts = new Map();
  const clients = new Map([["channel-b", { ws }]]), sent: { to: string; content: string }[] = [];
  const send = async (e: Envelope, t: LocalEndpoint): Promise<Delivery> => { sent.push({ to: t.agentName ?? "", content: e.content }); return { envelope: e, outcome: { kind: "sent" } }; };
  const deliver = (e: Envelope) => deliverPmLocal(e, e.to as LocalEndpoint, clients, book, receipts, send, { db: f.db, agents: state.agents });
  return { f, state, clients, sent, deliver };
}

test("reminder addressed to the former PM is redirected, held in the active PM's digest and rides in front of the next executor delivery", async () => {
  const w = await world("on");
  const r = await w.deliver(env({ kind: "local", agentName: "scheduler", channelId: "", ws }, "[上线后待办] T1 已上线，规格要求 PM 接着做：", true));
  expect(r.outcome).toEqual({ kind: "sent", note: "digest" });
  expect(w.sent).toEqual([]);
  await w.deliver(env({ kind: "local", agentName: "agent-task-1", channelId: "ch-t", ws }, "执行者交付 PR #3", false));
  expect(w.sent).toHaveLength(1);
  const [head, ...rest] = w.sent[0]!.content.split("\n");
  expect(w.sent[0]!.to).toBe(B);
  expect(head).toContain(`原收件人 ${A}`);
  expect(rest[0]).toContain("[📨 PM 摘要] 1 条");
  expect(rest[1]).toContain("scheduler · T1 · ");
  expect(rest.at(-1)).toBe("执行者交付 PR #3");
});

test("observe through deliverPmLocal: same deliveries as before, one per message", async () => {
  const w = await world("observe");
  await w.deliver(env({ kind: "local", agentName: "scheduler", channelId: "", ws }, "[上线后待办] T1 已上线", true));
  await w.deliver(env({ kind: "local", agentName: "agent-task-1", channelId: "ch-t", ws }, "执行者交付 PR #3", false));
  expect(w.sent.map((s) => s.to)).toEqual([B, B]);
  expect(w.sent[0]!.content.endsWith("[上线后待办] T1 已上线")).toBe(true);
  expect(w.sent[1]!.content.endsWith("\n执行者交付 PR #3")).toBe(true);
  expect(w.sent.some((s) => s.content.includes("PM 摘要"))).toBe(false);
});

test("window digest sent through the startup router deliver (→ deliverPmLocal) is immediate and never re-queued", async () => {
  const w = await world("on");
  let clock = 1_000_000;
  Object.assign(pmDigest.deps, { now: () => clock, db: () => w.f.db, agents: () => w.state.agents });
  pmDigest.start({ clients: w.clients, deliver: w.deliver }, false);
  await w.deliver(env({ kind: "local", agentName: "scheduler", channelId: "", ws }, "[上线后待办] T1 已上线", true));
  const before = new PmDigestStore().read().log.length;
  clock += PM_DIGEST_WINDOW_MS;
  await pmDigest.tick();
  await pmDigest.tick();
  expect(w.sent).toHaveLength(1);
  expect(w.sent[0]!.to).toBe(B);
  expect(w.sent[0]!.content).toContain("[📨 PM 摘要] 1 条");
  expect(new PmDigestStore().queued(P)).toEqual([]);
  expect(new PmDigestStore().read().log.length).toBe(before); // 摘要信封本身不记归类、不入队
});
