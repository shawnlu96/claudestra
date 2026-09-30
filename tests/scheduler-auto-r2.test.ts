/** T68f r2 regressions (T68f-r2-adv.md): a dirty review checkout, and a forged reviewer identity recorded as evidence. */
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { witnessMismatch, type CallerWitness } from "../src/lib/caller-witness.js";
import { auditLedger } from "../src/lib/ledger-audit.js";
import { getWorkflow } from "../src/lib/ledger-scheduler.js";
import { listEvents } from "../src/lib/ledger-store.js";
import { autoFixture, H1, toBuild } from "./scheduler-auto-helpers.js";

type F = ReturnType<typeof autoFixture>;

async function atReview(): Promise<F> {
  const f = autoFixture();
  await toBuild(f);
  await f.tick();
  await f.cli("agent-task-one", "deliver", "T1", "--from", "build", "--head", H1);
  await f.tick();
  await f.tick();
  return f;
}

function passArgs(f: F): string[] {
  const findings = join(f.dir, "none.json");
  writeFileSync(findings, "[]");
  return ["review", "T1", "--reviewer", "agent-rv-t1", "--verdict", "pass", "--p0", "0", "--p1", "0", "--p2", "0",
    "--head", H1, "--session", "s-rv", "--family", "codex", "--findings", findings, "--path", "reviews/T1-r1/report.md"];
}

const lastReview = (f: F) => listEvents(f.db, { project: "p", target: "T1" }).findLast((e) => e.kind === "review");
const audit = (f: F) => auditLedger({ project: "p", pms: ["pm"], tasks: [{ task: f.task(), events: listEvents(f.db, { project: "p", target: "T1" }) }],
  agents: null, reviewers: null, held: null, ownerInbox: null }, Date.now()).findings.filter((x) => x.rule === "review_witness_mismatch");

describe("P1-2 a verdict is about the commit, not an edited checkout on it", () => {
  test("uncommitted tracked edits in the review checkout refuse the verdict, and the tick hands the card to PM", async () => {
    const f = await atReview();
    try {
      f.dirtyReviewer("M target.ts");
      expect(await f.cli("agent-rv-t1", ...passArgs(f))).toMatchObject({ ok: false, code: "forbidden", error: expect.stringContaining("未提交的改动（M target.ts）") });
      expect(lastReview(f)).toBeUndefined();
      expect(await f.tick()).toMatchObject({ step: "manual", detail: expect.stringContaining("审查目录有未提交改动") });
      expect(getWorkflow(f.db, "T1")?.mode).toBe("manual");
      expect(f.notices.filter((n) => n.includes("退回人工"))).toHaveLength(1);
      expect(f.task().stage).toBe("review");
    } finally { f.close(); }
  });

  test("a clean checkout on the head still writes the verdict", async () => {
    const f = await atReview();
    try {
      expect(await f.cli("agent-rv-t1", ...passArgs(f))).toMatchObject({ ok: true });
    } finally { f.close(); }
  });
});

describe("P1-1 forging the reviewer's environment is not refused, it is recorded and flagged (threat model: misrouting, not forgery)", () => {
  const author: CallerWitness = { cwd: "/work/author", tmuxWindow: "agent-task-one", procs: ["zsh", "claude", "tmux"] };
  const reviewer = (f: F): CallerWitness => ({ cwd: join(f.dir, "rv-t1", "src"), tmuxWindow: null, procs: ["bash", "codex", "codex-acp", "bun"] });

  test("the author changing only its session id is still refused", async () => {
    const f = await atReview();
    try {
      f.witnessAs(author);
      expect(await f.cliWith({ callerSession: "s-rv" }, "agent-task-one", ...passArgs(f))).toMatchObject({ ok: false, code: "forbidden",
        error: expect.stringContaining("结论只由台账绑定的审查员 agent-rv-t1 写") });
    } finally { f.close(); }
  });

  test("the author faking both channel and session writes, but the event carries the mismatch and the audit flags it", async () => {
    const f = await atReview();
    try {
      f.witnessAs(author);
      expect(await f.cli("agent-rv-t1", ...passArgs(f))).toMatchObject({ ok: true });
      const mismatch = (lastReview(f)?.data.witness as { mismatch: string[] }).mismatch;
      expect(mismatch).toEqual([expect.stringContaining("tmux 窗口是 agent-task-one"), expect.stringContaining("cwd 在 /work/author"),
        expect.stringContaining("父进程链里没有 codex")]);
      expect(audit(f)).toEqual([expect.objectContaining({ taskId: "T1", notify: "pm", detail: expect.stringContaining("旁证对不上") })]);
    } finally { f.close(); }
  });

  test("the real reviewer (ACP-hosted Codex, inside its checkout) records a consistent witness and nothing is flagged", async () => {
    const f = await atReview();
    try {
      f.witnessAs(reviewer(f));
      expect(await f.cli("agent-rv-t1", ...passArgs(f))).toMatchObject({ ok: true });
      expect(lastReview(f)?.data.witness).toMatchObject({ tmuxWindow: null, mismatch: [] });
      expect(audit(f)).toEqual([]);
    } finally { f.close(); }
  });

  test("family process names: Claude Code runs as `claude`, Codex as `codex` / `codex-acp`; the manager's own path never counts", () => {
    const w = (procs: string[]): CallerWitness => ({ cwd: "/r", tmuxWindow: "agent-rv", procs });
    expect(witnessMismatch(w(["zsh", "claude"]), { agent: "agent-rv", family: "claude", dir: "/r" })).toEqual([]);
    expect(witnessMismatch(w(["zsh", "codex-acp"]), { agent: "agent-rv", family: "codex", dir: "/r" })).toEqual([]);
    expect(witnessMismatch(w(["zsh", "claude"]), { agent: "agent-rv", family: "codex", dir: "/r" })).toHaveLength(1);
    expect(witnessMismatch(w(["bun", "zsh"]), { agent: "agent-rv", family: "claude", dir: "/r" })).toHaveLength(1);
  });
});
