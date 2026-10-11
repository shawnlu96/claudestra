/**
 * team-project-N8B8：调度器代记（review-converge-followup.ts）的版本说明不再带报告路径；来源镜像 feature 在 dagWriteScrub = on
 * 下被外发检查拦了，换固定文字重试一次；仍被拦就照现有失败处理，并给 PM 记一条 note。
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DAG_WRITE_SCRUB_HINT } from "../src/lib/dag-write-scrub.js";
import { getDagVersion, getFeature } from "../src/lib/ledger-feature.js";
import { createFeature, initDag } from "../src/lib/ledger-feature-write.js";
import { closeLedger, getEventByDedup, getTask, listEvents, openLedger } from "../src/lib/ledger-store.js";
import { createTask, setMeta } from "../src/lib/ledger-write.js";
import { RECOVERY_POLICY_PATH, type RecoveryMode } from "../src/lib/recovery-policy.js";
import { convergeFollowUp, followUpKey } from "../src/lib/review-converge-followup.js";
import type { Downgrade } from "../src/lib/review-converge.js";
import { writeSharedLedgerMode } from "../src/lib/shared-ledger-mode.js";

const ctx = { actor: "owner", now: 1000 };
const PROJECT = "n8b8f", FEATURE = "n8bf-feat";
/** 编造的长串，形状同 v141 的那段路径：一段 32 位以上、有大写小写和数字、不带空格 */
const LONG = "demo-project-ZETAQK-r13-20270102";
const setPolicy = (mode: RecoveryMode) => {
  mkdirSync(dirname(RECOVERY_POLICY_PATH), { recursive: true });
  writeFileSync(RECOVERY_POLICY_PATH, JSON.stringify({ projects: { [PROJECT]: { keys: { dagWriteScrub: mode } } } }));
};
const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  rmSync(RECOVERY_POLICY_PATH, { force: true });
  for (const c of cleanups.splice(0).reverse()) await c();
});

/** 一张在子 DAG 里的卡 T1（节点 A），旁边一个计划节点 B；mirror = 这个 feature 是不是来源镜像 */
async function card(mirror: boolean, sibling = "sibling work") {
  const dir = mkdtempSync(join(tmpdir(), "n8b8-followup-")), path = join(dir, "ledger.sqlite"), db = openLedger(path);
  setMeta(db, ctx, { project: PROJECT, key: "pms", value: ["pm"] });
  setMeta(db, ctx, { project: PROJECT, key: "docsDir", value: join(dir, "docs") });
  createTask(db, ctx, { project: PROJECT, id: "T1", title: "task", kind: "code", pm: "pm" });
  db.query("INSERT OR REPLACE INTO ledger_instance (key, value) VALUES ('origin', 'n8bf')").run();
  const feature = createFeature(db, ctx, { project: PROJECT, slug: "feat", title: "feature" }).row;
  expect(feature.id).toBe(FEATURE);
  if (mirror) await writeSharedLedgerMode(FEATURE, { authorityMode: "source", sharedPlanning: true, mirror: true }, undefined, path);
  cleanups.push(async () => {
    if (mirror) await writeSharedLedgerMode(FEATURE, { authorityMode: "source", sharedPlanning: false }, undefined, path);
    closeLedger(path);
    rmSync(dir, { recursive: true, force: true });
  });
  setPolicy("off"); // 初版可以带推不出去的节点文字（复刻「旧版本里已经有」的情形）
  initDag(db, ctx, { id: FEATURE, rev: feature.rev, nodes: [{ key: "A", taskId: "T1", fileGlobs: ["src/old.ts"] }, { key: "B", oneLine: sibling }] });
  const report = join(dir, "reports", "T1-r3.md");
  mkdirSync(dirname(report), { recursive: true });
  writeFileSync(report, "# 审查\nF1: 问题\n");
  const downgrade = (findingId: string): Downgrade => ({ round: 3, head: "a".repeat(40), reportPath: report,
    items: [{ findingId, family: "other", probe: "src/old.ts:1", why: "no_basis" }] });
  const run = (d: Downgrade) => db.transaction(() => convergeFollowUp(db, ctx, getTask(db, "T1")!, d, undefined, () => true))();
  const notes = () => listEvents(db, { project: PROJECT, target: "T1" }).filter((e) => e.kind === "note" && e.data.op === "converge_dag_scrub");
  return { db, dir, report, downgrade, run, notes, reason: () => getDagVersion(db, FEATURE, getFeature(db, FEATURE)!.currentVersion)!.reasonText };
}

describe("调度器代记的版本说明", () => {
  test("[验收线 4] 新版本说明不含任何路径，findingId 照旧", async () => {
    for (const mirror of [false, true]) {
      const c = await card(mirror);
      setPolicy("on");
      c.run(c.downgrade("F1"));
      expect(getFeature(c.db, FEATURE)!.currentVersion).toBe(2);
      expect(c.reason()).toBe("调度器代记：T1 第 3 轮审查降级 「F1」；报告见本卡第 3 轮审查记录");
      expect(c.reason()).not.toContain(c.report);
      expect(c.reason()).not.toContain(c.dir);
      expect(c.reason()).not.toMatch(/[/\\]/);
      expect(c.notes()).toHaveLength(0);
      const event = getEventByDedup(c.db, followUpKey("T1", 3))!;
      expect(event.data).toMatchObject({ node: "Af3", followUpFailure: null, reportPath: c.report }); // 报告路径仍在本卡的降级事件里
      await cleanups.pop()!();
    }
  });

  test("[验收线 4] on：只有版本说明被拦（findingId 是长串）→ 固定文字重试一次后写入成功", async () => {
    const c = await card(true);
    setPolicy("on");
    c.run(c.downgrade(LONG));
    expect(getFeature(c.db, FEATURE)!.currentVersion).toBe(2);
    expect(c.reason()).toBe("调度器代记：T1 第 3 轮审查降级，详情见本卡审查记录");
    expect(getDagVersion(c.db, FEATURE, 2)!.nodes.map((n) => n.key)).toEqual(["A", "B", "Af3"]);
    expect(c.notes()).toHaveLength(0);
    const event = getEventByDedup(c.db, followUpKey("T1", 3))!;
    expect(event.data).toMatchObject({ node: "Af3", followUpFailure: null, findingIds: [LONG] }); // findingId 仍记在降级事件里
    const rewrites = listEvents(c.db, { project: PROJECT, target: FEATURE }).filter((e) => e.data.op === "dag-rewrite");
    expect(rewrites).toHaveLength(1);
    expect(rewrites[0]!.data).not.toHaveProperty("dagWriteScrub");
  });

  test("observe：同样的版本说明照常写入，事件带提示，不重试", async () => {
    const c = await card(true);
    setPolicy("observe");
    c.run(c.downgrade(LONG));
    expect(c.reason()).toContain(`「${LONG}」；报告见本卡第 3 轮审查记录`);
    const rewrites = listEvents(c.db, { project: PROJECT, target: FEATURE }).filter((e) => e.data.op === "dag-rewrite");
    expect(rewrites.map((e) => e.data.dagWriteScrub)).toEqual([`${DAG_WRITE_SCRUB_HINT}dag.reason`]);
    expect(c.notes()).toHaveLength(0);
  });

  test("[验收线 4] on：节点文字也被拦 → 重试仍被拦，不写版本，照现有失败返回，并给 PM 记一条 note", async () => {
    const c = await card(true, `see ${LONG}`);
    setPolicy("on");
    c.run(c.downgrade("F1"));
    c.run(c.downgrade("F1")); // 重放：不再写第二条
    expect(getFeature(c.db, FEATURE)!.currentVersion).toBe(1);
    const event = getEventByDedup(c.db, followUpKey("T1", 3))!;
    expect(event.data.node).toBeNull();
    expect(String(event.data.followUpFailure)).toStartWith(`后续节点没开成：${DAG_WRITE_SCRUB_HINT}dag.nodes[1].oneLine`);
    const notes = c.notes();
    expect(notes).toHaveLength(1);
    expect(notes[0]!.text).toContain("PM 处理");
    expect(notes[0]!.text).toContain("dag.nodes[1].oneLine");
    for (const text of [notes[0]!.text, event.text, String(event.data.followUpFailure)]) expect(text).not.toContain(LONG);
  });

  test("别的失败（不是外发检查）不重试、不记 note", async () => {
    const c = await card(true);
    setPolicy("on");
    c.db.query("UPDATE tasks SET pm = NULL WHERE id = 'T1'").run();
    setMeta(c.db, ctx, { project: PROJECT, key: "pms", value: [] });
    c.run(c.downgrade(LONG));
    expect(getFeature(c.db, FEATURE)!.currentVersion).toBe(1);
    expect(getEventByDedup(c.db, followUpKey("T1", 3))!.data.followUpFailure).toBe("卡上没有能代记的 PM，没开后续节点");
    expect(c.notes()).toHaveLength(0);
  });
});
