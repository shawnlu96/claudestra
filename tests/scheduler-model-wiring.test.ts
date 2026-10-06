/**
 * dispatch-recovery-MODELW · the auto tick's "turn failed" branch through MODEL (real ledger, synthetic worker, stand-in CFG).
 * Old red: before the wiring a reviewer's policy refusal escalated with no MODEL record at all; every test below asserts one.
 */
import { afterAll, afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { OWNER_PRINCIPAL_ID } from "../src/lib/devices.js";
import { answerAsk, openAsk } from "../src/lib/ledger-asks.js";
import { listEvents } from "../src/lib/ledger-store.js";
import { setModelOutcomeReader } from "../src/lib/scheduler-model-wiring.js";
import { autoFixture, H1, toBuild } from "./scheduler-auto-helpers.js";

const CYBER = "This request has been flagged for possible cybersecurity risk";
const dir = mkdtempSync(join(tmpdir(), "modelw-"));
type Hook = (project: string, mechanism: string) => unknown;
const g = globalThis as { __modelwPolicy?: Hook };
/** Stand-in CFG with the frozen export name; every read asks the hook afresh. */
const CFG = join(dir, "recovery-policy.ts");
writeFileSync(CFG, "export function recoveryPolicy(project, mechanism) { return globalThis.__modelwPolicy(project, mechanism); }\n");
const BROKEN = join(dir, "broken-policy.ts");
writeFileSync(BROKEN, "export const somethingElse = 1;\n");
const MISSING = join(dir, "nope", "recovery-policy.ts");
const mode = (m: string): Hook => () => ({ mode: m, manualAfterMs: null });

let f: ReturnType<typeof autoFixture>;
let errors: ReturnType<typeof spyOn>;
beforeEach(async () => {
  errors = spyOn(console, "error").mockImplementation(() => {});
  f = autoFixture();
  await toBuild(f);
  await f.tick();
  expect((await f.cli("agent-task-one", "deliver", "T1", "--from", "build", "--head", H1)).ok).toBe(true);
  await f.tick(); // reviewer session
  expect(await f.tick()).toMatchObject({ step: "sent" });
});
afterEach(() => { f.close(); errors.mockRestore(); setModelOutcomeReader(); delete g.__modelwPolicy; });
afterAll(() => rmSync(dir, { recursive: true, force: true }));

/** The reviewer's turn ends as a failed result with this host text (the real worker still sends; only observe changes). */
function failWith(message: string, kind: "error" | "quota" | "auth" = "error") {
  const real = f.tickDeps.worker;
  f.tickDeps.worker = (ref) => {
    const w = real(ref);
    return "manual" in w ? w : { ...w, observe: async () => ({ state: "result", outcome: "failed", failure: { kind, message } }) };
  };
}
function approve() {
  const ask = openAsk(f.db, { project: "p", source: "reply", kind: "decide", title: "Refusal rule", askKey: "policy-refusal-rule" }, 1000);
  answerAsk(f.db, ask.id, { choices: ["[button:policy_refusal_rule_go]"], labels: ["go"], text: "", principal: OWNER_PRINCIPAL_ID,
    owner: true, via: "web_card", at: 2000, final: true });
}
const outcomes = () => listEvents(f.db, { project: "p", target: "T1" }).filter((e) => String(e.data.op).startsWith("model_"));
/** The escalate exactly as the branch wrote it before the wiring. */
const today = (msg: string) => `[调度引擎] T1 退回人工，请接手：agent-rv-t1 回合失败：${msg}`;
const diags = () => errors.mock.calls.map((c: unknown[]) => String(c[0])).filter((l: string) => l.startsWith("[model-outcome]"));

describe("observe (default)", () => {
  test("reviewer cyberPolicy refusal, no owner approval, CFG not installed: MODEL records the safety hold, escalate text unchanged", async () => {
    setModelOutcomeReader(MISSING);
    failWith(CYBER);
    expect(await f.tick()).toMatchObject({ step: "manual", detail: `agent-rv-t1 回合失败：${CYBER}` });
    expect(f.notices.at(-1)).toBe(today(CYBER));
    const [e, ...rest] = outcomes();
    expect(rest).toEqual([]);
    expect(e).toMatchObject({ kind: "note", data: { op: "model_outcome", mode: "observe", cls: "safety", role: "reviewer", agent: "agent-rv-t1",
      family: "codex", machine: "local", evidence: CYBER, diag: "缺恢复策略 port，按 observe", plan: { kind: "manual", code: "model_safety_hold" } } });
    expect(e!.text.startsWith("[观察] ")).toBe(true);
  });

  test("owner approval + observe: records what on would do (retry_same, same placement, new session), then escalates as today", async () => {
    setModelOutcomeReader(CFG);
    g.__modelwPolicy = mode("observe");
    approve();
    failWith(CYBER);
    expect(await f.tick()).toMatchObject({ step: "manual" });
    expect(f.notices.at(-1)).toBe(today(CYBER));
    expect(outcomes()).toHaveLength(1);
    expect(outcomes()[0]).toMatchObject({ kind: "note", data: { op: "model_outcome", mode: "observe", session: "s-rv", attempt: 1,
      materialDigest: expect.stringMatching(/^sha256:[0-9a-f]{64}$/), plan: { kind: "retry_same", to: { family: "codex", machine: "local" } } } });
  });

  test("quota on the reviewer: classified capacity, observed, escalated with today's text", async () => {
    setModelOutcomeReader(MISSING);
    failWith("You've hit your usage limit", "quota");
    expect(await f.tick()).toMatchObject({ step: "manual", detail: "agent-rv-t1 撞额度：You've hit your usage limit" });
    expect(outcomes()).toMatchObject([{ data: { mode: "observe", cls: "capacity" } }]);
  });
});

describe("on", () => {
  test("approved first refusal: MODEL's retry decision on the ledger, escalated once with the plan for PM; later ticks never stall", async () => {
    setModelOutcomeReader(CFG);
    g.__modelwPolicy = mode("on");
    approve();
    failWith(CYBER);
    const before = f.notices.length, sends = f.intents().length;
    const { step, detail } = (await f.tick())!;
    expect(step).toBe("manual");
    expect(detail).toStartWith(`agent-rv-t1 回合失败：${CYBER}；MODEL 计划：retry_same（批准 `);
    expect(detail).toContain("retry_same");
    expect(detail).toContain("提供方安全拒绝保持暂停：不自动换会话 / 家族 / 提供方重试");
    expect(outcomes()).toMatchObject([{ kind: "note", data: { op: "model_refusal_retry", mode: "on" } }]);
    expect(f.notices.slice(before)).toHaveLength(1);
    expect(f.notices.at(-1)).toStartWith(today(CYBER));
    expect(f.notices.at(-1)).toContain("retry_same");
    // The card is PM's now: repeated ticks neither replay a "recovery" nor add records, notices or new orders.
    for (let n = 0; n < 4; n++) expect((await f.tick())?.step).not.toBe("recovery");
    expect(outcomes()).toHaveLength(1);
    expect(f.notices.slice(before)).toHaveLength(1);
    expect(f.intents()).toHaveLength(sends);
  });

  test("a long host message is shortened, never the plan: PM notice, fallback_manual and detail all keep kind, approval and the pause", async () => {
    setModelOutcomeReader(CFG);
    g.__modelwPolicy = mode("on");
    approve();
    const long = `${CYBER}. ${"Additional diagnostic context. ".repeat(20)}`;
    expect(long.length).toBeGreaterThan(560);
    failWith(long);
    const { step, detail } = (await f.tick())!;
    expect(step).toBe("manual");
    const fallback = listEvents(f.db, { project: "p", target: "T1" }).findLast((e) => e.data.op === "fallback_manual");
    for (const text of [detail, f.notices.at(-1)!, String(fallback?.data.reason)]) {
      expect(text).toContain(`agent-rv-t1 回合失败：${CYBER}`);
      expect(text).toMatch(/MODEL 计划：retry_same（批准 [^，]+，台账 #\d+）——提供方安全拒绝保持暂停/);
    }
    expect(detail.length).toBeLessThanOrEqual(560);
  });

  test("observe with a long host message: today's text and cut, untouched", async () => {
    setModelOutcomeReader(CFG);
    g.__modelwPolicy = mode("observe");
    approve();
    const long = `${CYBER}. ${"Additional diagnostic context. ".repeat(20)}`;
    failWith(long);
    const cut = `agent-rv-t1 回合失败：${long}`.trim().slice(0, 560);
    expect(await f.tick()).toMatchObject({ step: "manual", detail: cut });
    expect(f.notices.at(-1)).toBe(`[调度引擎] T1 退回人工，请接手：${cut}`);
  });

  test("no approval: MODEL's hold escalate plus today's manual fallback", async () => {
    setModelOutcomeReader(CFG);
    g.__modelwPolicy = mode("on");
    failWith(CYBER);
    expect(await f.tick()).toMatchObject({ step: "manual" });
    expect(f.notices.at(-1)).toBe(today(CYBER));
    expect(outcomes()).toMatchObject([{ kind: "escalate", data: { op: "model_safety_hold", plan: { kind: "manual", code: "model_safety_hold" } } }]);
  });
});

describe("a broken policy never strands the card", () => {
  test("CFG module without the export: one diagnostic, MODEL off (no record), escalate as today", async () => {
    setModelOutcomeReader(BROKEN);
    failWith(CYBER);
    expect(await f.tick()).toMatchObject({ step: "manual" });
    expect(f.notices.at(-1)).toBe(today(CYBER));
    expect(outcomes()).toEqual([]);
    expect(diags().join("\n")).toContain("没有导出函数 recoveryPolicy");
  });

  test("a policy read that throws: diagnostic, off, escalate as today", async () => {
    setModelOutcomeReader(CFG);
    g.__modelwPolicy = () => { throw new Error("config store unreadable"); };
    failWith(CYBER);
    expect(await f.tick()).toMatchObject({ step: "manual" });
    expect(f.notices.at(-1)).toBe(today(CYBER));
    expect(outcomes()).toEqual([]);
    expect(diags().join("\n")).toContain("config store unreadable");
  });
});
