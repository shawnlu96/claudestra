/** PMR-2 开关读法（lib/pm-rails-policy.ts）与标记函数的边界（lib/pm-rails.ts markIntervention） */
import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeLedger, openLedger } from "../src/lib/ledger-store.js";
import { createTask, setMeta } from "../src/lib/ledger-write.js";
import { setWorkflow } from "../src/lib/ledger-scheduler-write.js";
import { markIntervention, pmRailsScope, workflowModes, type PmRailsMode } from "../src/lib/pm-rails.js";
import { cachedPmRailsMode, pmRailsMode } from "../src/lib/pm-rails-policy.js";

const dir = mkdtempSync(join(tmpdir(), "pm-rails-policy-"));
afterEach(() => closeLedger(join(dir, "l.sqlite")));

test("[验收线 6、9] keys.pmRails 按项目生效；没设 = observe，不继承项目 mode；文件坏 = off", () => {
  const f = join(dir, "policy.json");
  expect(pmRailsMode("p", join(dir, "missing.json"))).toBe("observe");
  writeFileSync(f, JSON.stringify({ projects: { p: { keys: { pmRails: "on" } }, q: { keys: { pmRails: "off" } }, r: { mode: "on" } } }));
  expect([pmRailsMode("p", f), pmRailsMode("q", f), pmRailsMode("r", f), pmRailsMode("zz", f)]).toEqual(["on", "off", "observe", "observe"]);
  writeFileSync(f, "{bad");
  expect(pmRailsMode("p", f)).toBe("off");
  let reads = 0;
  const m = cachedPmRailsMode(() => (reads++, "on"));
  m("p"); m("p"); m("q");
  expect(reads).toBe(2);
});

test("[验收线 2、6] peer / 执行者 / 没作用域不标；off 原样返回同一个对象", () => {
  const db = openLedger(join(dir, "l.sqlite"));
  setMeta(db, { actor: "owner", now: 1 }, { project: "p", key: "pms", value: ["agent-pm"] });
  createTask(db, { actor: "owner", now: 2 }, { project: "p", id: "A", title: "a", kind: "code", agent: "agent-x" });
  setWorkflow(db, { actor: "owner", now: 3 }, { taskId: "A", taskRev: 1, template: "code", templateVersion: 2, mode: "auto", authorFamily: "claude", fallback: "x" });
  const e = { project: "p", target: "A", kind: "stage" as const, data: { from: "build", to: "blocked" } };
  const inScope = (mode: PmRailsMode, actor: string) =>
    pmRailsScope.run({ cmd: "stage", mode: () => mode, modesAtStart: workflowModes(db) }, () => markIntervention(db, actor, e));
  expect(markIntervention(db, "agent-pm", e)).toBe(e.data);
  expect(inScope("off", "agent-pm")).toBe(e.data);
  expect(inScope("observe", "peer:shawn")).toBe(e.data);
  expect(inScope("observe", "agent-x")).toBe(e.data);
  expect(inScope("observe", "owner")).toBe(e.data);
  expect(inScope("on", "agent-pm")).toEqual({ ...e.data, manual: true, intervention: { cmd: "stage", by: "agent-pm", role: "pm", mode: "on" } });
  rmSync(dir, { recursive: true, force: true });
});

test("[验收线 2] 低水位只推过「从头连续都推过」的那段：别的卡还没推，后面推过的卡也不重推", async () => {
  const { advanceLowWater, cardPushes } = await import("../src/lib/pm-rails-notice.js");
  const ev = (seq: number, target: string, ts: number) => ({ seq, ts, actor: "agent-pm", project: "p", target, kind: "stage" as const, text: "",
    data: { intervention: { cmd: "stage", by: "agent-pm", mode: "on" } }, dedupKey: null }) as never;
  const MIN = 60_000, events = [ev(1, "A", 0), ev(2, "B", 9 * MIN), ev(3, "A", 1 * MIN)];
  let st = { after: 0, cards: {} as Record<string, number>, stalls: [] as string[] };
  const first = cardPushes("p", events, st, 12 * MIN);
  expect(first.map((p) => [p.card, p.lastSeq])).toEqual([["A", 3]]); // B 还没满 10 分钟
  st = advanceLowWater(events, { ...st, cards: { A: 3 } });
  expect(st).toMatchObject({ after: 1, cards: { A: 3 } });
  expect(cardPushes("p", events.filter((e: { seq: number }) => e.seq > st.after), st, 20 * MIN).map((p) => [p.card, p.lastSeq])).toEqual([["B", 2]]);
  expect(advanceLowWater(events, { ...st, cards: { A: 3, B: 2 } })).toMatchObject({ after: 3, cards: {} });
});
