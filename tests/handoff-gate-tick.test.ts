/**
 * HDG-1 at the auto tick of a mergeHandoff project: the handoff hold CLI and the feature batch keep a reviewed card in `merge`
 * (no handoff record), lift on the next tick, put the batch in the evidence, and a sibling that falls back after part of the
 * batch went out raises one PM escalation. Pure planner side: handoff-gate-plan.test.ts.
 */
import { describe, expect, test } from "bun:test";
import { createFeature, initDag } from "../src/lib/ledger-feature-write.js";
import { getDagVersion, getFeature } from "../src/lib/ledger-feature.js";
import { rewriteDag } from "../src/lib/ledger-dag-write.js";
import { getMeta, listEvents } from "../src/lib/ledger-store.js";
import { insertEvent } from "../src/lib/ledger-tx.js";
import { createTask } from "../src/lib/ledger-write.js";
import { schedulerAutoTick } from "../src/lib/scheduler-auto-tick.js";
import { HANDOFF_POLL_MS, type HandoffPr } from "../src/lib/scheduler-merge-handoff-tick.js";
import { autoFixture, H1, H2, P2, toBuild } from "./scheduler-auto-helpers.js";

const PR = "https://github.com/example/repo/pull/7";

async function inMerge() {
  const f = autoFixture();
  await toBuild(f);
  await f.tick();
  await f.cli("agent-task-one", "deliver", "T1", "--from", "build", "--head", H1, "--pr", PR);
  await f.tick();
  await f.tick();
  await f.review("pass", H1, [P2]);
  expect(await f.tick()).toMatchObject({ step: "stage", detail: "review→merge" });
  const pr: HandoffPr = { state: "OPEN", head: H1, mergeSha: null };
  const hand = async () => {
    const r = await schedulerAutoTick(f.db, { p: { maxActiveWorkers: 2, mergeHandoff: true } }, { ...f.tickDeps, prState: async () => pr });
    if (r.failed.length) throw new Error(JSON.stringify(r.failed));
    return r.cards.find((c) => (c as { taskId?: string }).taskId === "T1") ?? r.cards[0];
  };
  const handoffs = () => listEvents(f.db, { project: "p", target: "T1" }).filter((e) => e.data.op === "merge_handoff");
  return { f, hand, handoffs };
}

/** T1 on node A, a manual card T2 on node B of the same feature (no dependency between them); `single` = a one-node DAG. */
function bindFeature(f: ReturnType<typeof autoFixture>, single = false) {
  createTask(f.db, f.at("owner"), { project: "p", id: "T2", title: "sibling", kind: "code" });
  const id = createFeature(f.db, f.at("owner"), { project: "p", slug: "HDG", title: "HDG" }).row.id;
  initDag(f.db, f.at("owner"), { id, rev: 1,
    nodes: [{ key: "A", taskId: "T1", fileGlobs: ["src/lib/x.ts"] }, ...(single ? [] : [{ key: "B", taskId: "T2", fileGlobs: ["src/lib/y.ts"] }])] });
  return id;
}
const sibling = (f: ReturnType<typeof autoFixture>, stage: string, round = 1) =>
  f.db.query("UPDATE tasks SET stage = ?, round = ?, headSHA = ? WHERE id = 'T2'").run(stage, round, H2);
/** A structured pass for T2 at H2 in its current round (a manual card: the verdict itself is the proof). */
const siblingPass = (f: ReturnType<typeof autoFixture>, round = 1) => insertEvent(f.db, f.at("pm"), { project: "p", target: "T2", kind: "review",
  data: { round, head: H2, reviewer: "agent-rv-t2", reviewerSessionId: "s-rv2", reviewerFamily: "codex", path: "r2.md", verdict: "pass", findings: [], p0: 0, p1: 0, p2: 0 } }, false);

describe("A. handoff hold at the tick", () => {
  test("#1–#3 PM turns it on (who / when / why in meta, ledger show), the card waits in merge; off hands it over on the next tick", async () => {
    const { f, hand, handoffs } = await inMerge();
    try {
      expect(await f.cli("agent-task-one", "handoff-hold", "p", "on", "--reason", "x")).toMatchObject({ ok: false });
      expect(await f.cli("pm", "handoff-hold", "p", "on")).toMatchObject({ ok: false });
      expect(await f.cli("pm", "handoff-hold", "p", "on", "--reason", "本地继续做，交接排队")).toMatchObject({ ok: true, handoffHold: { on: true, by: "pm" } });
      expect(getMeta(f.db, "p").handoffHold).toMatchObject({ on: true, reason: "本地继续做，交接排队", by: "pm" });
      expect(await f.cli("pm", "show", "--project", "p")).toMatchObject({ meta: { handoffHold: { on: true, reason: "本地继续做，交接排队" } } });

      expect(await hand()).toMatchObject({ step: "waiting", detail: "项目暂停交接（pm）：本地继续做，交接排队" });
      expect(await hand()).toMatchObject({ step: "waiting" });
      expect(handoffs()).toEqual([]);
      expect(f.task().stage).toBe("merge");
      // the scheduler's own write refuses too while the hold is on
      expect(await f.cli("scheduler", "scheduler-merge-handoff", "T1", "--head", H1, "--pr", PR)).toMatchObject({ ok: false });

      expect(await f.cli("pm", "handoff-hold", "p", "off")).toMatchObject({ ok: true, handoffHold: { on: false } });
      expect(await hand()).toMatchObject({ step: "handoff" });
      expect(handoffs()).toHaveLength(1);
    } finally { f.close(); }
  });

  test("#4 turning the hold on after the handoff does not recall it: the PR is still followed to live", async () => {
    const { f, hand, handoffs } = await inMerge();
    try {
      expect(await hand()).toMatchObject({ step: "handoff" });
      await f.cli("pm", "handoff-hold", "p", "on", "--reason", "晚了");
      f.advance(HANDOFF_POLL_MS);
      expect(await hand()).toMatchObject({ step: "waiting", detail: "已交仓库方合并，等 PR 结果" });
      expect(handoffs()).toHaveLength(1);
    } finally { f.close(); }
  });
});

describe("B. feature batch at the tick", () => {
  test("#5 a sibling in build / fix / review holds the card; reviewed at its head it goes, the evidence carries the batch", async () => {
    const { f, hand, handoffs } = await inMerge();
    try {
      const id = bindFeature(f);
      for (const stage of ["build", "fix", "review"]) {
        sibling(f, stage);
        expect(await hand()).toMatchObject({ step: "waiting", detail: `feature ${id} v1 同批还有节点没审过：B（T2 ${stage}）` });
      }
      sibling(f, "merge");
      expect(await hand()).toMatchObject({ step: "waiting", detail: `feature ${id} v1 同批还有节点没审过：B（T2 merge）` });
      expect(handoffs()).toEqual([]);
      siblingPass(f);
      expect(await hand()).toMatchObject({ step: "handoff" });
      expect(handoffs()[0]!.data.evidence).toMatchObject({ head: H1, feature: { id, version: 1, batch: [`T1@${H1}`, `T2@${H2}`] } });
    } finally { f.close(); }
  });

  test("#7 part of the batch out, then a sibling falls back to fix: PM hears once, the handoff stays", async () => {
    const { f, hand, handoffs } = await inMerge();
    try {
      const id = bindFeature(f);
      sibling(f, "merge");
      siblingPass(f);
      expect(await hand()).toMatchObject({ step: "handoff" });
      sibling(f, "fix", 2);
      f.advance(HANDOFF_POLL_MS);
      expect(await hand()).toMatchObject({ step: "waiting" });
      const esc = () => listEvents(f.db, { project: "p" }).filter((e) => e.kind === "escalate");
      expect(esc()).toHaveLength(1);
      expect(esc()[0]).toMatchObject({ actor: "scheduler", target: "T1", data: { to: "pm", auto: true, op: "feature_handoff_regress", featureId: id,
        handed: [`T1@${H1}`], pending: ["T2"] } });
      expect(f.notices.at(-1)).toContain("已交出 T1@");
      expect(f.notices.at(-1)).toContain("T2（fix）");
      const told = f.notices.length;
      f.advance(HANDOFF_POLL_MS);
      await hand();
      expect(esc()).toHaveLength(1);
      expect(f.notices).toHaveLength(told);
      expect(handoffs()).toHaveLength(1);
      // the next regression of the same sibling (another round) is news again
      sibling(f, "review", 3);
      await hand();
      expect(esc()).toHaveLength(2);
    } finally { f.close(); }
  });

  test("#7 the notice follows the batch the handoff recorded, not the DAG as rewritten since", async () => {
    const { f, hand } = await inMerge();
    try {
      const id = bindFeature(f);
      sibling(f, "merge");
      siblingPass(f);
      expect(await hand()).toMatchObject({ step: "handoff" });
      // a new node C now depends on A: batched today, A would go alone and B would no longer be its sibling
      const cur = getFeature(f.db, id)!, nodes = getDagVersion(f.db, id, cur.currentVersion)!.nodes;
      rewriteDag(f.db, f.at("owner"), { id, rev: cur.rev, nodes: [...nodes, { key: "C", oneLine: "C", deps: ["A"], fileGlobs: ["src/lib/z.ts"] }],
        reasonKind: "new_issue", reasonText: "Add a successor of A after the handoff", cancel: new Map(), scopeChange: false, askFrom: { agent: "pm", channelId: null } });
      expect(getFeature(f.db, id)!.currentVersion).toBe(2);
      sibling(f, "fix", 2);
      f.advance(HANDOFF_POLL_MS);
      await hand();
      expect(listEvents(f.db, { project: "p" }).filter((e) => e.kind === "escalate")).toMatchObject([{ data: { pending: ["T2"], handed: [`T1@${H1}`] } }]);
    } finally { f.close(); }
  });

  test("#7 a handed card itself sent back to fix: the sibling waiting in merge raises the notice", async () => {
    const { f, hand, handoffs } = await inMerge();
    try {
      const id = bindFeature(f);
      // T2 went out first in a batch with T1 (its handoff evidence names both), then came back to fix: it no longer polls its PR
      insertEvent(f.db, { actor: "scheduler", now: 5_000 }, { project: "p", target: "T2", kind: "scheduler",
        data: { op: "merge_handoff", evidence: { v: 1, pr: PR, head: H2, feature: { id, version: 1, batch: [`T1@${H1}`, `T2@${H2}`] } } } }, false);
      sibling(f, "fix", 2);
      expect(await hand()).toMatchObject({ step: "waiting", detail: `feature ${id} v1 同批还有节点没审过：B（T2 fix）` });
      const esc = () => listEvents(f.db, { project: "p" }).filter((e) => e.kind === "escalate");
      expect(esc()).toMatchObject([{ target: "T1", data: { op: "feature_handoff_regress", handed: [`T2@${H2}`], pending: ["T2"] } }]);
      expect(f.notices.at(-1)).toContain(`已交出 T2@${H2.slice(0, 12)}`);
      await hand();
      expect(esc()).toHaveLength(1);
      expect(handoffs()).toEqual([]);
    } finally { f.close(); }
  });

  test("#7 + #9 the same under the hold: the sibling waits on the hold and still raises the notice", async () => {
    const { f, hand } = await inMerge();
    try {
      const id = bindFeature(f);
      insertEvent(f.db, { actor: "scheduler", now: 5_000 }, { project: "p", target: "T2", kind: "scheduler",
        data: { op: "merge_handoff", evidence: { v: 1, pr: PR, head: H2, feature: { id, version: 1, batch: [`T1@${H1}`, `T2@${H2}`] } } } }, false);
      sibling(f, "fix", 2);
      await f.cli("pm", "handoff-hold", "p", "on", "--reason", "本地继续做");
      expect(await hand()).toMatchObject({ step: "waiting", detail: `项目暂停交接（pm）：本地继续做；feature ${id} v1 同批还有节点没审过：B（T2 fix）` });
      expect(listEvents(f.db, { project: "p" }).filter((e) => e.kind === "escalate"))
        .toMatchObject([{ target: "T1", data: { op: "feature_handoff_regress", handed: [`T2@${H2}`], pending: ["T2"] } }]);
    } finally { f.close(); }
  });

  test("#5–#7 an upstream that went out alone and came back to fix holds its successor in merge and raises the notice", async () => {
    const { f, hand, handoffs } = await inMerge();
    try {
      createTask(f.db, f.at("owner"), { project: "p", id: "T2", title: "upstream", kind: "code" });
      const id = createFeature(f.db, f.at("owner"), { project: "p", slug: "HDG", title: "HDG" }).row.id;
      initDag(f.db, f.at("owner"), { id, rev: 1, nodes: [{ key: "A", taskId: "T2", fileGlobs: ["src/lib/y.ts"] },
        { key: "B", taskId: "T1", deps: ["A"], fileGlobs: ["src/lib/x.ts"] }] });
      // T2 (A) has a successor, so it went out alone; it was live when T1 (B) started, then rolled back to fix
      insertEvent(f.db, { actor: "scheduler", now: 5_000 }, { project: "p", target: "T2", kind: "scheduler",
        data: { op: "merge_handoff", evidence: { v: 1, pr: PR, head: H2, feature: { id, version: 1, batch: [`T2@${H2}`] } } } }, false);
      sibling(f, "fix", 2);
      expect(await hand()).toMatchObject({ step: "waiting", detail: `feature ${id} v1 依赖的节点没审过：A（T2 fix）` });
      expect(handoffs()).toEqual([]);
      expect(listEvents(f.db, { project: "p" }).filter((e) => e.kind === "escalate"))
        .toMatchObject([{ target: "T1", data: { op: "feature_handoff_regress", handed: [`T2@${H2}`], pending: ["T2"] } }]);
      sibling(f, "live", 2);
      expect(await hand()).toMatchObject({ step: "handoff" });
    } finally { f.close(); }
  });

  test("#8 a one-node feature hands over as before, without a batch", async () => {
    const { f, hand, handoffs } = await inMerge();
    try {
      bindFeature(f, true);
      expect(await hand()).toMatchObject({ step: "handoff" });
      expect(handoffs()[0]!.data.evidence).not.toHaveProperty("feature");
    } finally { f.close(); }
  });
});
