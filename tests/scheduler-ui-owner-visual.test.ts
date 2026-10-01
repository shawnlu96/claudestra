/**
 * i28-U1: 规格卡首「owner 看截图：是」→ 自动开卡的 claim 带 --owner-visual → 建卡时 extra.ownerVisual = true（调度身份写的，
 * 闸认它）。没写这一行的卡缺省由 PM 验收截图。临时台账，命令经进程内 runLedger。
 */
import type { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFeature, initDag } from "../src/lib/ledger-feature-write.js";
import { closeLedger, getTask, listEvents, openLedger } from "../src/lib/ledger-store.js";
import { setMeta } from "../src/lib/ledger-write.js";
import { parseSpecHead } from "../src/lib/scheduler-autostart.js";
import { ownerVisualOf } from "../src/lib/scheduler-ui-gate.js";
import { runLedger } from "../src/manager/ledger.js";

const P = "claude-orchestrator", FID = "ab12-u1", ARM = "00112233445566aa";
let dir: string, db: Database, now: number;

const asScheduler = (...args: string[]) => runLedger(args, {
  db, actor: "scheduler", projectIds: [P], loadRegistry: async () => ({}) as never, saveRegistry: async () => {}, now: () => now++,
  autoDispatch: () => true, autoProjects: () => [P],
}) as Promise<Record<string, any>>;

/** claim the node (optionally with --owner-visual), then the claim's own task-new step: the card the scheduler would open. */
async function openCard(key: string, ownerVisual: boolean): Promise<string> {
  const c = await asScheduler("scheduler-autostart", "claim", FID, key, "--arm", ARM, "--template", "ui", "--max-workers", "3",
    ...(ownerVisual ? ["--owner-visual"] : []));
  expect(c).toMatchObject({ ok: true, claim: { template: "ui", ownerVisual } });
  const id = c.claim.taskId as string;
  expect(await asScheduler("scheduler-autostart", "step", String(c.claim.seq), "task-new", id, "--title=x", "--kind=code")).toMatchObject({ ok: true });
  return id;
}

beforeEach(() => {
  now = 1_000;
  dir = mkdtempSync(join(tmpdir(), "i28-u1-owner-visual-"));
  db = openLedger(join(dir, "ledger.sqlite"));
  db.prepare("INSERT INTO ledger_instance (key, value) VALUES ('origin', 'ab12')").run();
  setMeta(db, { actor: "owner", now: 500 }, { project: P, key: "pms", value: ["agent-pm"] });
  createFeature(db, { actor: "agent-pm", now: now++ }, { project: P, slug: "u1", title: "截图闸" });
  initDag(db, { actor: "agent-pm", now: now++ }, { id: FID, rev: 1, nodes: [
    { key: "look", oneLine: "全局配色", fileGlobs: ["web/app/theme.css"] }, { key: "btn", oneLine: "一个按钮", fileGlobs: ["web/app/btn.tsx"] },
  ] });
});
afterEach(() => {
  closeLedger(join(dir, "ledger.sqlite"));
  rmSync(dir, { recursive: true, force: true });
});

describe("spec head「owner 看截图：是」", () => {
  test("parses only inside the card head, either colon, and nothing else turns it on", () => {
    expect(parseSpecHead("# T\n模板：ui\nowner 看截图：是\n## 目标\n").ownerVisual).toBe(true);
    expect(parseSpecHead("# T\nOwner 看截图: 是\n").ownerVisual).toBe(true);
    expect(parseSpecHead("# T\n模板：ui\n## 目标\nowner 看截图：是\n").ownerVisual).toBe(false);
    expect(parseSpecHead("# T\nowner 看截图：否\n").ownerVisual).toBe(false);
    expect(parseSpecHead("# T\n模板：ui\n").ownerVisual).toBe(false);
  });

  test("the claim carries it into the new card's extra, and the gate reads it from the scheduler's own write", async () => {
    const look = await openCard("look", true);
    const btn = await openCard("btn", false);
    expect(getTask(db, look)?.extra.ownerVisual).toBe(true);
    expect(getTask(db, btn)?.extra.ownerVisual).toBeUndefined();
    for (const [id, want] of [[look, true], [btn, false]] as const) {
      const t = getTask(db, id)!;
      expect(ownerVisualOf(db, t, listEvents(db, { project: P, target: id }))).toBe(want);
    }
  });
});
