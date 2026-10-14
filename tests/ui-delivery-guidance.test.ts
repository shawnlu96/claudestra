import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { renderExecPrompt, type PromptVars } from "../src/lib/dag-tools-prompt.js";
import { convergenceOrderLines } from "../src/lib/fix-strategy-order.js";
import { fixSwapStep } from "../src/lib/fix-strategy-runtime.js";
import type { SchedulerIntent } from "../src/lib/ledger-scheduler.js";
import { closeLedger, getTask, openLedger } from "../src/lib/ledger-store.js";
import { createTask } from "../src/lib/ledger-write.js";
import { orderWireFor, takeOrderResult } from "../src/lib/order-take.js";
import { workOrderFor } from "../src/lib/scheduler-work-order.js";
import { getSchedulerSession } from "../src/lib/scheduler-sessions.js";
import type { SessionRef } from "../src/lib/worker-session.js";
import { convergenceProbe, repeatedFix } from "./fix-strategy-helpers.js";

const vars: PromptVars = { task: "U1", title: "UI", pm: "agent-pm", branch: "feat/u1", base: "origin/main",
  worktree: "/worktree", spec: "/spec.md", ledgerDir: "/ledger", template: "ui" };
const reminder = "本卡是 ui 卡：本轮交付（含换作者修复）仍须带正规 uiEvidence／CLI `--ui-evidence`；" +
  "代码改过重拍 after、重核前后配对与逐图摘要，清单绑定本次 head、specRev 和目标审查轮次，不能沿用上一轮清单。";
let db: Database;
beforeEach(() => {
  db = openLedger(":memory:");
  createTask(db, { actor: "owner", now: 1 }, { id: "U1", project: "p", title: "UI", kind: "code", agent: "agent-author" });
  db.run(`INSERT INTO task_workflows (taskId, project, template, templateVersion, mode, authorFamily, fallback, specRev, createdAt, updatedAt)
    VALUES ('U1', 'p', 'ui', 3, 'manual', 'codex', '', 1, 1, 1)`);
});
afterEach(() => closeLedger(":memory:"));

describe("UI delivery instructions at author boundaries", () => {
  test("initial and custom author prompts teach every-round strict delivery and manifest conversion", () => {
    for (const template of [undefined, "自定义 {TASK}"]) {
      const prompt = renderExecPrompt(vars, template);
      for (const s of ["每轮交付", "首次 build", "普通 fix", "fix-swap", "uiEvidence", "--ui-evidence", "重拍 after",
        "uiEvidenceDigest", "readUiEvidence", "card", "taskId", "file", "ref", "web", "source=local", "specRev",
        "round + 1", "当前 round", "r2/after-home-390x844.png", "headless", "ui-approve"]) expect(prompt).toContain(s);
      expect(prompt).not.toContain("task-set");
      expect(prompt).not.toContain("extra.screenshots");
    }
  });

  test.each(["build", "fix"] as const)("%s and replacement authors get the identical line through take_order and scheduler brief", (stage) => {
    db.run("UPDATE tasks SET stage = ?, round = 2 WHERE id = 'U1'", [stage]);
    for (const author of ["agent-author", "agent-replacement"]) {
      db.run("UPDATE tasks SET agent = ? WHERE id = 'U1'", [author]);
      const task = getTask(db, "U1")!, step = stage === "build" ? "write" : "fix";
      const wire = orderWireFor(db, { task, stage, step, orderId: `U1:${step}:r2`, intent: null });
      expect(wire.ok).toBe(true);
      if (!wire.ok) throw new Error(wire.error);
      const intent = { id: `U1:${step}:r2`, node: step, head: null, specRev: 1 } as SchedulerIntent;
      const ref: SessionRef = { taskId: "U1", role: "author", agent: author, sessionId: "fresh-session", family: "codex", transport: "acp" };
      const brief = workOrderFor(task, intent, null, ref, undefined, db)!;
      expect(wire.order.inputs.filter((s) => s === reminder)).toHaveLength(1);
      expect(brief.inputs.filter((s) => s === reminder)).toHaveLength(1);
    }
  });

  test("code/security/missing workflow and review stages get no UI author reminder", () => {
    for (const template of ["code", "security", "ui"]) {
      db.run("UPDATE task_workflows SET template = ? WHERE taskId = 'U1'", [template]);
      for (const stage of ["build", "fix", "review", "restate"]) {
        db.run("UPDATE tasks SET stage = ? WHERE id = 'U1'", [stage]);
        const lines = convergenceOrderLines(db, getTask(db, "U1")!);
        expect(lines.includes(reminder)).toBe(template === "ui" && (stage === "build" || stage === "fix"));
      }
    }
    db.run("DELETE FROM task_workflows");
    expect(convergenceOrderLines(db, getTask(db, "U1")!)).not.toContain(reminder);
    expect(renderExecPrompt({ ...vars, template: "code" })).toBe(renderExecPrompt({ ...vars, template: "security" }));
  });

  test("actual fix-swap binds a fresh author who receives the UI instruction without previous context", async () => {
    const f = await repeatedFix();
    try {
      f.db.run("UPDATE task_workflows SET template = 'ui' WHERE taskId = 'T1'");
      const p = convergenceProbe(f), intent = p.plan();
      expect(intent.action).toBe("fix_swap");
      expect(await fixSwapStep(f.db, f.at("scheduler"), intent.id, p.deps)).toMatchObject({ step: "waiting" });
      expect(await fixSwapStep(f.db, f.at("scheduler"), intent.id, p.deps)).toMatchObject({ step: "session" });
      const author = getSchedulerSession(f.db, "T1", "author")!;
      expect(author.sessionId).not.toBe("s-one");
      const result = takeOrderResult(f.db, { agent: author.agent, sessionId: author.sessionId!, family: "claude-code", channelId: "fresh-channel" });
      expect(result.ok && result.order?.inputs).toContain(reminder);
      expect(workOrderFor(f.task(), intent, null, author as SessionRef, undefined, f.db)?.inputs).toContain(reminder);
    } finally { f.close(); }
  });
});
