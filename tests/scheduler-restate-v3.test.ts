/**
 * i28-M4a: code v3 releases build on the executor's own restate record (no PM approval), PM can brake it with restate-hold,
 * v2 still waits for restate-approve, and ui / security have no v3 at all.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { getWorkflow } from "../src/lib/ledger-scheduler.js";
import { listEvents } from "../src/lib/ledger-store.js";
import { FLOW_TEMPLATES, nodeAt, templateFor } from "../src/lib/scheduler-template.js";
import { autoFixture } from "./scheduler-auto-helpers.js";

let f: ReturnType<typeof autoFixture>;
afterEach(() => f?.close());

const setVersion = (version: string, template = "code", actor = "pm") => {
  const w = getWorkflow(f.db, "T1")!;
  return f.cli(actor, "workflow-set", "T1", "--rev", String(f.task().rev), "--workflow-rev", String(w.rev), "--template", template,
    "--version", version, "--mode", "auto", "--author-family", "claude", "--fallback", "只报错不修");
};
const restate = (...text: string[]) => f.cli("agent-task-one", "stage", "T1", "--from", "spec", "--to", "restate", ...text);

/** v3 card with its restate order already sent. */
async function v3AtRestateOrder() {
  f = autoFixture();
  expect(await setVersion("3")).toMatchObject({ ok: true, workflow: { templateVersion: 3 } });
  await f.tick(); // ensure author session
  await f.tick(); // restate order
  expect(f.sent.at(-1)?.agent).toBe("agent-task-one");
}

describe("code v3 template", () => {
  test("v2 templates are untouched; only code has a v3 and it differs only at approve_restate", () => {
    expect(templateFor("code", 2)).toBe(FLOW_TEMPLATES.code);
    expect(templateFor("ui", 2)).toBe(FLOW_TEMPLATES.ui);
    expect(templateFor("security", 2)).toBe(FLOW_TEMPLATES.security);
    for (const t of ["code", "ui", "security"] as const) expect(nodeAt(FLOW_TEMPLATES[t], "restate")?.gate).toBe("pm_restate");
    expect(templateFor("ui", 3)).toBeNull();
    expect(templateFor("security", 3)).toBeNull();
    expect(templateFor("code", 4)).toBeNull();
    const v2 = FLOW_TEMPLATES.code, v3 = templateFor("code", 3)!;
    expect(v3.version).toBe(3);
    expect(v3.nodes.map((n) => n.id)).toEqual(v2.nodes.map((n) => n.id));
    expect(v3.nodes.filter((n, i) => JSON.stringify(n) !== JSON.stringify(v2.nodes[i])))
      .toEqual([{ id: "approve_restate", stage: "restate", action: "stage", next: "build", gate: "restate_recorded" }]);
  });

  test("workflow-set: code accepts 3; ui / security and unknown versions are refused", async () => {
    f = autoFixture();
    expect(await setVersion("3", "security")).toMatchObject({ ok: false, code: "invalid" });
    expect(await setVersion("3", "ui")).toMatchObject({ ok: false, code: "invalid" });
    expect(await setVersion("4")).toMatchObject({ ok: false, code: "invalid" });
    expect(await setVersion("3")).toMatchObject({ ok: true, workflow: { template: "code", templateVersion: 3 } });
  });

  test("v3: the executor's restate record moves restate → build with no PM approval, and the next order is write", async () => {
    await v3AtRestateOrder();
    expect(await restate("--text", "复述见 reviews/T1-restate.md")).toMatchObject({ ok: true });
    await f.tick(); // restate → build
    expect(f.task().stage).toBe("build");
    const moved = listEvents(f.db, { project: "p", target: "T1" }).findLast((e) => e.kind === "stage")!;
    expect(moved).toMatchObject({ actor: "scheduler", data: { from: "restate", to: "build" } });
    expect(listEvents(f.db, { project: "p", target: "T1" }).some((e) => e.data.op === "restate_approved")).toBe(false);
    await f.tick(); // write order
    expect(f.sent.at(-1)).toMatchObject({ agent: "agent-task-one" });
    expect(f.sent.at(-1)?.text).toContain("write");
  });

  test("v3: a restate with no text is not a record — the card never reaches build and goes back to PM", async () => {
    await v3AtRestateOrder();
    expect(await restate()).toMatchObject({ ok: true });
    await f.tick();
    expect(f.task().stage).toBe("restate");
    expect(getWorkflow(f.db, "T1")?.mode).toBe("manual");
    expect(f.notices.at(-1)).toContain("restate_missing");
  });

  test("v3: restate-hold stops the auto start until restate-approve releases it", async () => {
    await v3AtRestateOrder();
    expect(await f.cli("agent-task-one", "restate-hold", "T1", "--reason", "自己放自己")).toMatchObject({ ok: false, code: "forbidden" });
    expect(await f.cli("pm", "restate-hold", "T1", "--reason", "范围要再对一下")).toMatchObject({ ok: true });
    expect(await restate("--text", "复述")).toMatchObject({ ok: true });
    expect(await f.tick()).toMatchObject({ step: "waiting", detail: "PM 拦住了复述：范围要再对一下" });
    expect(f.task().stage).toBe("restate");
    expect(await f.cli("pm", "restate-approve", "T1")).toMatchObject({ ok: true });
    await f.tick();
    expect(f.task().stage).toBe("build");
    expect(await f.cli("pm", "restate-hold", "T1", "--reason", "晚了")).toMatchObject({ ok: false, code: "conflict" });
  });

  test("v2 is unchanged: a restate record alone still waits for PM, and restate-hold refuses v2 cards", async () => {
    f = autoFixture();
    await f.tick();
    await f.tick();
    expect(await f.cli("pm", "restate-hold", "T1", "--reason", "v2 不需要")).toMatchObject({ ok: false, code: "invalid" });
    expect(await restate("--text", "复述见 reviews/T1-restate.md")).toMatchObject({ ok: true });
    expect(await f.tick()).toMatchObject({ step: "waiting", detail: "等待 PM 放行复述" });
    expect(f.task().stage).toBe("restate");
    expect(await f.cli("pm", "restate-approve", "T1")).toMatchObject({ ok: true });
    await f.tick();
    expect(f.task().stage).toBe("build");
  });
});
