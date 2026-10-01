import { expect, test } from "bun:test";
import { writeFileSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { getWorkflow } from "../src/lib/ledger-scheduler.js";
import { listEvents } from "../src/lib/ledger-store.js";
import { createFeature, initDag } from "../src/lib/ledger-feature-write.js";
import { getDagVersion, getFeature } from "../src/lib/ledger-feature.js";
import { takeReview } from "../src/lib/review-order.js";
import { roundCapNotice, p1Summary, roundCapText } from "../src/lib/review-converge-notice.js";
import { MAX_REVIEW_ROUND } from "../src/lib/review-converge.js";
import { autoFixture, H1, toBuild } from "./scheduler-auto-helpers.js";

async function ready(f: ReturnType<typeof autoFixture>) {
  await toBuild(f);
  await f.tick();
  expect(await f.cli("agent-task-one", "deliver", "T1", "--from", "build", "--head", H1)).toMatchObject({ ok: true });
  await f.tick(); await f.tick();
}

test("P1 without basis advances into merge and through the real merge-intent gate, with an idempotent follow-up", async () => {
  const f = autoFixture();
  try {
    expect(await f.cli("owner", "meta", "--project", "p", "--docs-dir", f.dir)).toMatchObject({ ok: true });
    f.db.query("INSERT OR REPLACE INTO ledger_instance (key, value) VALUES ('origin', 'abcd')").run();
    f.db.query("UPDATE tasks SET pm = 'pm' WHERE id = 'T1'").run();
    const feature = createFeature(f.db, f.at("pm"), { project: "p", slug: "converge", title: "converge" }).row;
    initDag(f.db, f.at("pm"), { id: feature.id, rev: feature.rev, nodes: [{ key: "A", taskId: "T1", fileGlobs: ["src/lib/x.ts"] }] });
    await ready(f);
    const path = join(f.dir, "report.md");
    writeFileSync(path, "# 不挡合并\n没有验收线的改进\n");
    expect(await f.review("changes", H1, [{ findingId: "cleanup", family: "cleanup", severity: "P1", probe: "src/lib/x.ts:1" }], ["--path", path]))
      .toMatchObject({ ok: true });
    expect(await f.tick()).toMatchObject({ step: "stage", detail: "review→merge" });
    expect(await f.tick()).toMatchObject({ step: "merge_queue" });
    await f.tick();
    expect(getFeature(f.db, feature.id)?.currentVersion).toBe(2);
    expect(getDagVersion(f.db, feature.id, 2)?.nodes.find((n) => n.key === "Af1")?.taskId).toBeNull();
    expect(readFileSync(join(f.dir, "tasks", "drafts", "T1f1.md"), "utf8")).toContain("没有验收线的改进");
    expect(listEvents(f.db, { project: "p", target: "T1" }).filter((e) => e.data.op === "review_downgrade")).toHaveLength(1);
    expect(getWorkflow(f.db, "T1")?.mode).toBe("auto");
  } finally { f.close(); }
});

test("different P1s fix past round four, round eight holds without dispatch, sends once and survives notification restart", async () => {
  const f = autoFixture();
  try {
    expect(await f.cli("owner", "meta", "--project", "p", "--docs-dir", f.dir)).toMatchObject({ ok: true });
    await ready(f);
    for (let round = 1; round <= MAX_REVIEW_ROUND; round++) {
      const head = round.toString(16).repeat(40);
      const taken = takeReview(f.db, { agent: "agent-rv-t1", sessionId: "s-rv", family: "codex", verified: true });
      expect(taken.ok).toBe(true);
      if (round >= 3 && taken.ok) expect(taken.orders[0].inputs.join("\n")).toContain("只审修复");
      const rows: object[] = [{ findingId: `issue${round}`, family: `family${round}`, severity: "P1", basis: "regression", probe: "src/lib/x.ts:1" }];
      if (round === MAX_REVIEW_ROUND) rows.push({ findingId: "deferred", family: "cleanup", severity: "P1", probe: "src/lib/other.ts:1" });
      expect(await f.review("changes", head, rows))
        .toMatchObject({ ok: true });
      if (round === MAX_REVIEW_ROUND) break;
      expect(await f.tick()).toMatchObject({ step: "stage", detail: "review→fix" });
      await f.tick();
      expect(await f.cli("agent-task-one", "deliver", "T1", "--from", "fix", "--head", (round + 1).toString(16).repeat(40))).toMatchObject({ ok: true });
      await f.tick();
    }
    const intents = f.intents().length;
    const notify = f.tickDeps.notifyPm;
    f.tickDeps.notifyPm = async () => { throw new Error("bridge offline"); };
    expect(await f.tick()).toMatchObject({ step: "held", detail: expect.stringContaining("下个 tick 重发") });
    f.tickDeps.notifyPm = notify;
    expect(await f.tick()).toMatchObject({ step: "held", detail: expect.stringContaining("已通知 PM") });
    await f.tick();
    await roundCapNotice(f.db, f.task(), async () => { throw new Error("receipt must suppress another send"); });
    expect(f.notices.filter((s) => s.includes("上限 8 轮"))).toHaveLength(1);
    expect(f.intents()).toHaveLength(intents);
    expect(getWorkflow(f.db, "T1")?.mode).toBe("auto");
    const events = listEvents(f.db, { project: "p", target: "T1" });
    expect(p1Summary(events, 8)).toHaveLength(8);
    expect(p1Summary(events, 8)[7]).not.toContain("deferred");
    expect(readFileSync(join(f.dir, "tasks", "drafts", "T1f8.md"), "utf8")).toContain("deferred");
    expect(roundCapText(f.task(), events)).toContain("issue1");
    expect(events.filter((e) => e.data.op === "review_round_hold")).toHaveLength(1);
    // PM changes the spec before workflow-resume, as the hold notice instructs.
    expect(await f.cli("pm", "stage", "T1", "--from", "review", "--to", "spec")).toMatchObject({ ok: true });
    const spec = join(f.dir, "new-spec.md"); writeFileSync(spec, "# 收窄规格\n");
    expect(await f.cli("pm", "task-set", "T1", "--rev", String(f.task().rev), "--spec", spec)).toMatchObject({ ok: true });
    expect(await f.cli("pm", "workflow-resume", "T1", "--rev", String(f.task().rev), "--workflow-rev", String(getWorkflow(f.db, "T1")!.rev),
      "--reason", "已收窄规格")).toMatchObject({ ok: true });
    expect(await f.tick()).toMatchObject({ step: "sent" });
    expect(getWorkflow(f.db, "T1")?.mode).toBe("auto");
  } finally { f.close(); }
});

test.each(["three_p1_rounds", "review_block"])("%s persists mixed demotions before manual fallback without duplicates", async (code) => {
  const f = autoFixture();
  try {
    expect(await f.cli("owner", "meta", "--project", "p", "--docs-dir", f.dir)).toMatchObject({ ok: true });
    f.db.query("INSERT OR REPLACE INTO ledger_instance (key, value) VALUES ('origin', 'abcd')").run();
    f.db.query("UPDATE tasks SET pm = 'pm' WHERE id = 'T1'").run();
    const feature = createFeature(f.db, f.at("pm"), { project: "p", slug: "manual", title: "manual" }).row;
    initDag(f.db, f.at("pm"), { id: feature.id, rev: feature.rev, nodes: [{ key: "A", taskId: "T1", fileGlobs: ["src/a.ts"] }] });
    await ready(f);
    const round = code === "three_p1_rounds" ? 3 : 1;
    for (let r = 1; r <= round; r++) {
      const head = String(r).repeat(40);
      const rows = [{ findingId: "persistent", family: "logic", severity: code === "review_block" ? "P0" : "P1",
        basis: "acceptance:1", probe: "src/a.ts" },
      ...(r === round ? [{ findingId: "cleanup", family: "cleanup", severity: "P1", probe: "src/a.ts" }] : [])];
      const report = join(f.dir, `report-${r}.md`); writeFileSync(report, "# Findings\ncleanup: deferred improvement\n");
      const file = join(f.dir, `findings-${r}.json`); writeFileSync(file, JSON.stringify(rows));
      expect(await f.cli("agent-rv-t1", "review", "T1", "--reviewer", "agent-rv-t1", "--verdict", code === "review_block" ? "block" : "changes",
        "--p0", code === "review_block" ? "1" : "0", "--p1", String(rows.filter((x) => x.severity === "P1").length), "--p2", "0",
        "--head", head, "--session", "s-rv", "--family", "codex", "--findings", file, "--path", report)).toMatchObject({ ok: true });
      if (r === round) break;
      expect(await f.tick()).toMatchObject({ step: "stage", detail: "review→fix" });
      await f.tick();
      expect(await f.cli("agent-task-one", "deliver", "T1", "--from", "fix", "--head", String(r + 1).repeat(40))).toMatchObject({ ok: true });
      await f.tick();
    }
    expect(await f.tick()).toMatchObject({ step: "manual", detail: expect.stringContaining(code) });
    await f.tick(); await f.tick();
    expect(getWorkflow(f.db, "T1")?.mode).toBe("manual");
    expect(listEvents(f.db, { target: "T1" }).filter((e) => e.data.op === "review_downgrade")).toHaveLength(1);
    expect(getFeature(f.db, feature.id)?.currentVersion).toBe(2);
    const nodes = getDagVersion(f.db, feature.id, 2)!.nodes;
    expect(nodes).toHaveLength(2);
    expect(nodes.find((n) => n.key === `Af${round}`)?.deps).toEqual(["A"]);
    expect(existsSync(join(f.dir, "tasks", "drafts", `T1f${round}.md`))).toBe(true);
  } finally { f.close(); }
});
