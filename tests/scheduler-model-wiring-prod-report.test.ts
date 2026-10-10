/**
 * dispatch-recovery-MODELXW 验收线 5：快照 / 模型结果 / epoch / inform 写失败，除了 stderr 一行，每卡每类一次进台账（audit note）并通知 PM
 * 「拒审接续在本卡不可用」；台账也写不进时照样通知 PM 一次。auto tick 读只读句柄（LedgerReader），写口是夹具的调度身份 CLI。
 */
import { afterEach, expect, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OWNER_PRINCIPAL_ID } from "../src/lib/devices.js";
import { answerAsk, openAsk } from "../src/lib/ledger-asks.js";
import { LedgerReader } from "../src/lib/ledger-read.js";
import { getEventByDedup, listEvents } from "../src/lib/ledger-store.js";
import { schedulerAutoTick, type AutoTickDeps } from "../src/lib/scheduler-auto-tick.js";
import { setModelOutcomeReader, snapshotKey, unavailableKey } from "../src/lib/scheduler-model-wiring.js";
import { autoFixture, H1, toBuild } from "./scheduler-auto-helpers.js";

const CYBER = "This request has been flagged for possible cybersecurity risk";
const UNAVAILABLE = "拒审接续在本卡不可用";
let cleanup: (() => void)[] = [];
afterEach(() => { for (const c of cleanup.splice(0).reverse()) c(); });

async function setup(failing: (sub: string) => boolean) {
  const errors = spyOn(console, "error").mockImplementation(() => {});
  const dir = mkdtempSync(join(tmpdir(), "modelxw-report-"));
  const cfg = join(dir, "recovery-policy.ts");
  writeFileSync(cfg, "export function recoveryPolicy() { return { mode: 'on', manualAfterMs: null }; }\n");
  setModelOutcomeReader(cfg);
  const f = autoFixture();
  const reader = new LedgerReader(join(f.dir, "ledger.sqlite"));
  cleanup.push(() => { reader.close(); f.close(); errors.mockRestore(); setModelOutcomeReader(); rmSync(dir, { recursive: true, force: true }); });
  writeFileSync(join(f.dir, "T1.md"), "# T1\n");
  f.db.run("UPDATE tasks SET spec = ? WHERE id = 'T1'", [join(f.dir, "T1.md")]);
  await toBuild(f);
  await f.tick();
  expect((await f.cli("agent-task-one", "deliver", "T1", "--from", "build", "--head", H1)).ok).toBe(true);
  await f.tick();
  let refusal = false;
  const real = f.tickDeps.worker;
  const deps: AutoTickDeps = { ...f.tickDeps,
    manager: async (...a) => failing(a[1]) ? { ok: false, code: "write_failed", error: "attempt to write a readonly database" } : f.tickDeps.manager(...a),
    worker: (ref) => {
      const w = real(ref);
      return !refusal || "manual" in w ? w : { ...w, observe: async () => ({ state: "result", outcome: "failed", failure: { kind: "error", message: CYBER } }) };
    } };
  const tick = async () => (await schedulerAutoTick(reader.get()!, { p: { maxActiveWorkers: 2 } }, deps)).cards[0];
  const told = () => f.notices.filter((n) => n.includes(UNAVAILABLE));
  const lines = () => errors.mock.calls.map((c: unknown[]) => String(c[0])).filter((l: string) => l.startsWith("[model-outcome]"));
  return { f, tick, told, lines, refuse: () => { refusal = true; } };
}

test("快照写失败：单照发，stderr 一行 + 台账 audit 一条 + PM 通知一次（不可用）", async () => {
  const s = await setup((sub) => sub === "scheduler-review-snapshot");
  expect(await s.tick()).toMatchObject({ step: "sent" });
  const first = s.f.intents().findLast((i) => i.action === "review")!;
  expect(getEventByDedup(s.f.db, snapshotKey(first.id))).toBeNull();
  expect(getEventByDedup(s.f.db, unavailableKey("T1", "snapshot"))).toMatchObject({ actor: "scheduler", target: "T1",
    data: { op: "refusal_wiring_unavailable", write: "snapshot", audience: "pm" } });
  expect(s.told()).toEqual([expect.stringContaining("T1 拒审接续在本卡不可用：审查单材料快照没写进台账")]);
  expect(s.lines().some((l) => l.includes("材料快照没记上"))).toBe(true);
});

test("模型结果写失败：照旧退人工，另报一次不可用；再失败不重复通知", async () => {
  const s = await setup((sub) => sub === "scheduler-model-outcome");
  expect(await s.tick()).toMatchObject({ step: "sent" });
  const ask = openAsk(s.f.db, { project: "p", source: "reply", kind: "decide", title: "Refusal rule", askKey: "policy-refusal-rule" }, 1999);
  answerAsk(s.f.db, ask.id, { choices: ["[button:policy_refusal_rule_go]"], labels: ["x"], text: "", principal: OWNER_PRINCIPAL_ID, owner: true, via: "web_card", at: 2000, final: true });
  s.refuse();
  expect(await s.tick()).toMatchObject({ step: "manual" });
  expect(s.told()).toHaveLength(1);
  expect(s.told()[0]).toContain("模型结果没写进台账");
  expect(getEventByDedup(s.f.db, unavailableKey("T1", "outcome"))).not.toBeNull();
  expect(s.lines().filter((l) => l.includes("记模型结果失败，照旧退人工"))).toHaveLength(1);
  // the card is manual now; a second failure of the same kind (e.g. after PM hands it back) does not tell PM again
  const { modelOutcomeStep } = await import("../src/lib/scheduler-model-wiring.js");
  const ro = new LedgerReader(join(s.f.dir, "ledger.sqlite"));
  cleanup.push(() => ro.close());
  const card = { db: ro.get()!, task: s.f.task(), opts: {}, deps: { now: () => Date.now(), notifyPm: s.f.tickDeps.notifyPm,
    manager: async () => ({ ok: false, code: "write_failed", error: "readonly" }) } };
  const sent = s.f.db.query("SELECT * FROM scheduler_intents WHERE action = 'review' ORDER BY eventSeq DESC LIMIT 1").get() as Parameters<typeof modelOutcomeStep>[1];
  expect(await modelOutcomeStep(card, sent, { taskId: "T1", role: "reviewer", agent: "agent-rv-t1", sessionId: "s-rv", family: "codex", transport: "acp" },
    { kind: "error", message: CYBER })).toBe("");
  expect(s.told()).toHaveLength(1);
});

test("epoch 与 inform 都写不进（台账写口整体坏了）：PM 仍收到不可用通知，每类一次", async () => {
  const s = await setup((sub) => sub === "scheduler-refusal-epoch" || sub === "scheduler-model-inform");
  expect(await s.tick()).toMatchObject({ step: "sent" });
  const ask = openAsk(s.f.db, { project: "p", source: "reply", kind: "decide", title: "Refusal rule", askKey: "policy-refusal-rule" }, 1999);
  answerAsk(s.f.db, ask.id, { choices: ["[button:policy_refusal_rule_go]"], labels: ["x"], text: "", principal: OWNER_PRINCIPAL_ID, owner: true, via: "web_card", at: 2000, final: true });
  s.refuse();
  expect(await s.tick()).toMatchObject({ step: "manual" });
  expect(s.told().map((t) => t.match(/：(.+?)没写进台账/)?.[1])).toEqual(["拒审接续 epoch", "owner 告知"]);
  expect(listEvents(s.f.db, { project: "p", target: "T1" }).filter((e) => e.data.op === "refusal_wiring_unavailable")).toEqual([]);
  expect(listEvents(s.f.db, { project: "p", target: "T1" }).filter((e) => e.data.op === "reviewer_swap")).toEqual([]);
});
