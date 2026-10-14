import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeLedger, openLedger } from "../src/lib/ledger-store.js";
import { setMeta } from "../src/lib/ledger-write.js";
import { PmDigestStore } from "../src/lib/pm-digest-store.js";
import { PM_HOLD_LABEL, PmHoldStore, pmHoldBundle, pmHoldDue, pmHoldExempt, type PmHoldEntry } from "../src/lib/pm-hold.js";
import { PmDigest } from "../src/bridge/pm-digest.js";
import type { Delivery, Envelope, LocalEndpoint } from "../src/bridge/router.js";

const P = "proj", PM = "agent-pm", dirs: string[] = [], live: PmDigest[] = [];
afterEach(() => { for (const d of live.splice(0)) d.stop(); for (const d of dirs.splice(0)) { closeLedger(join(d, "ledger.sqlite")); rmSync(d, { recursive: true, force: true }); } });
const ws = { send: () => {} } as unknown as LocalEndpoint["ws"];
const pmTo: LocalEndpoint = { kind: "local", agentName: PM, channelId: "ch-pm", ws };
let seq = 0;
const env = (from: Envelope["from"], content: string, triggerKind: Envelope["meta"]["triggerKind"] = "agent_tool"): Envelope => ({
  from, to: pmTo, intent: "request", content,
  meta: { messageId: `m${++seq}`, threadId: `t${seq}`, ts: "2026-10-15T00:00:00Z", triggerKind, skipInterAgentWatchdog: true },
});
const sched = (text: string) => env({ kind: "local", agentName: "scheduler", channelId: "", ws }, text);
const owner = (text = "owner 问进度") => env({ kind: "user", userId: "u", channelId: "ch-pm" }, text, "user_discord");

function world(mode?: "hold" | "batch", everyMin = 60) {
  const dir = mkdtempSync(join(tmpdir(), "pm-hold-"));
  dirs.push(dir);
  const db = openLedger(join(dir, "ledger.sqlite"));
  setMeta(db, { actor: "owner" }, { project: P, key: "pms", value: [PM] });
  const store = new PmDigestStore(join(dir, "pm-digest.json"), join(dir, "pm-digest-mode.json"));
  const hold = new PmHoldStore(join(dir, "pm-hold-mode.json"), join(dir, "pm-hold.json"));
  if (mode) hold.setSetting(P, { mode, everyMin, since: 0 });
  let clock = 1_000_000;
  let outcome: Delivery["outcome"] = { kind: "sent" };
  const sent: Envelope[] = [];
  const raw = async (e: Envelope): Promise<Delivery> => {
    if (outcome.kind === "sent" && !outcome.note) sent.push({ ...e });
    return { envelope: e, outcome };
  };
  const digest = new PmDigest({ store, now: () => clock, db: () => db, hold, heldCarriers: () => new Set(),
    agents: () => [{ name: PM, projectId: P, channelId: "ch-pm" } as never] });
  const send = (e: Envelope) => digest.wrap(raw, db, P)(e, e.to as LocalEndpoint);
  live.push(digest);
  digest.start({ clients: new Map([["ch-pm", { ws }]]), deliver: (e) => send(e) }, false);
  return { hold, sent, send, tick: () => digest.tick(), advance: (ms: number) => { clock += ms; },
    setOutcome: (o: Delivery["outcome"]) => { outcome = o; } };
}

test("hold: scheduler pushes are stored in full and do not wake the PM; owner messages still go through at once", async () => {
  const w = world("hold");
  const r = await w.send(sched("[调度引擎] a-T1 退回人工，请接手：x"));
  expect(r.outcome).toEqual({ kind: "sent", note: "pm-hold" });
  await w.send(sched("[上线后待办] a-T2 已上线\n- 第二行要点"));
  expect(w.sent).toHaveLength(0);
  expect(w.hold.queue().map((e) => e.body)).toEqual(["[调度引擎] a-T1 退回人工，请接手：x", "[上线后待办] a-T2 已上线\n- 第二行要点"]);
  await w.send(owner());
  expect(w.sent.map((e) => e.content)).toEqual(["owner 问进度"]);
});

test("hold keeps everything until switched off, then one bundle carries every held body and empties the queue", async () => {
  const w = world("hold");
  await w.send(sched("[调度引擎] a-T1 退回人工"));
  await w.send(sched("【执行者提问】a-T3 要不要扩范围？"));
  w.advance(5 * 3600_000);
  await w.tick();
  expect(w.sent).toHaveLength(0);
  w.hold.setSetting(P, { mode: "off", everyMin: 60, since: 0 });
  await w.tick();
  expect(w.sent).toHaveLength(1);
  expect(w.sent[0].from).toEqual({ kind: "bridge", label: PM_HOLD_LABEL });
  expect(w.sent[0].content).toContain("攒了 2 条");
  expect(w.sent[0].content).toContain("a-T1 退回人工");
  expect(w.sent[0].content).toContain("要不要扩范围？");
  expect(w.hold.queue()).toHaveLength(0);
  await w.send(sched("[调度引擎] a-T4 关掉之后照常立即走"));
  expect(w.hold.queue()).toHaveLength(0);
});

test("batch sends one bundle once the oldest held push has waited everyMin; a failed send keeps the queue", async () => {
  const w = world("batch", 30);
  await w.send(sched("[调度引擎] a-T1 x"));
  w.advance(29 * 60_000);
  await w.tick();
  expect(w.sent).toHaveLength(0);
  w.advance(60_000);
  w.setOutcome({ kind: "dropped", reason: "PM 离线" });
  await w.tick();
  expect(w.hold.queue()).toHaveLength(1);
  w.setOutcome({ kind: "sent" });
  await w.tick();
  expect(w.sent).toHaveLength(1);
  expect(w.hold.queue()).toHaveLength(0);
});

test("off (default): nothing is stored, behaviour is unchanged", async () => {
  const w = world();
  await w.send(sched("[调度引擎] a-T1 退回人工，请接手：x"));
  expect(w.sent).toHaveLength(1);
  expect(w.hold.queue()).toHaveLength(0);
});

test("exemptions, due rule and bundle grouping", () => {
  expect(pmHoldExempt({ fromKind: "api", triggerKind: "agent_tool" })).toBe(true);
  expect(pmHoldExempt({ fromKind: "local", triggerKind: "ask_answer" })).toBe(true);
  expect(pmHoldExempt({ fromKind: "local", triggerKind: "peer_http" })).toBe(true);
  expect(pmHoldExempt({ fromKind: "bridge", triggerKind: "bridge_synth" }, PM_HOLD_LABEL)).toBe(true);
  expect(pmHoldExempt({ fromKind: "bridge", triggerKind: "bridge_synth" }, "ledger")).toBe(false);
  const e = (id: string, at: number, body: string, source = "scheduler"): PmHoldEntry => ({ id, project: P, at, source, body });
  const q = [e("a", 0, "同一条提醒"), e("b", 60_000, "别的"), e("c", 120_000, "同一条提醒")];
  expect(pmHoldDue({ mode: "batch", everyMin: 2, since: 0 }, q, 119_999)).toBe(false);
  expect(pmHoldDue({ mode: "batch", everyMin: 2, since: 0 }, q, 120_000)).toBe(true);
  expect(pmHoldDue({ mode: "hold", everyMin: 1, since: 0 }, q, 9e12)).toBe(false);
  expect(pmHoldDue({ mode: "off", everyMin: 60, since: 0 }, [], 0)).toBe(false);
  const b = pmHoldBundle(q);
  expect(b.ids).toEqual(new Set(["a", "b", "c"]));
  expect(b.text).toContain("重复 2 次");
  expect(b.text.split("同一条提醒")).toHaveLength(2);
  const big = Array.from({ length: 30 }, (_, i) => e(`x${i}`, i, `${i}`.padEnd(2900, "长")));
  const cut = pmHoldBundle(big);
  expect(cut.ids.size).toBeLessThan(30);
  expect(cut.text).toContain(`还有 ${30 - cut.ids.size} 条下一包送`);
});
