/**
 * team-parity-MIRRORID1：会被外发闸当随机串的卡号，开卡时就拒（src/lib/shared-ledger-mirror-skip-id.ts）。
 * start_node 什么都不建；rewrite_dag / 初版 DAG 只核新加且没绑卡的节点，整次写入拒绝、不出新版本。
 */
import { expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { createFeature, initDag } from "../src/lib/ledger-feature-write.js";
import { getFeature } from "../src/lib/ledger-feature.js";
import { getTask } from "../src/lib/ledger-store.js";
import { preflightStart } from "../src/lib/dag-tools-start.js";
import { CARD_ID_BLOCKED_HINT, cardIdGate } from "../src/lib/shared-ledger-mirror-skip-id.js";
import { integrationFixture } from "./shared-ledger-integration-fixture.test.js";

const BLOCKED = "followup-reliability-RECLAIMINT1"; // 32 位，大写小写数字都有
const LONG_KEY = "RECLAIMINT1-abcdefghij0123456"; // gate-<它> = 34 位

test("[验收线 3] start_node：卡号会撞闸就拒，什么都不建；31 位以内或不含数字的照常过闸", async () => {
  const f = integrationFixture();
  try {
    const before = f.feature();
    const out = await f.tools.start_node(f.call, { featureId: f.id, key: "next", taskId: BLOCKED, spec: "# scope" });
    expect(out).toMatchObject({ ok: false, code: "invalid" });
    expect(JSON.stringify(out)).toContain(CARD_ID_BLOCKED_HINT);
    expect(getTask(f.db, BLOCKED)).toBeNull();
    expect(f.calls).toEqual([]); // 没有 task-new、没有 create、没有 dag-bind
    expect(existsSync(join(f.startEnv.worktreeRoot, BLOCKED.toLowerCase()))).toBe(false);
    expect(existsSync(join(f.startEnv.ledgerDir, "docs", "tasks", `${BLOCKED}.md`))).toBe(false);
    expect(f.feature()).toEqual(before);
    // 过闸的卡号走完预检、拿到开工计划（预检不写任何东西；夹具的假 manager 建不出 agent，所以不跑后面的步骤）
    for (const taskId of [BLOCKED.slice(0, 31), "followup-reliability-reclaimintabc"]) {
      expect(await preflightStart(f.startEnv, { featureId: f.id, key: "next", taskId, spec: "# scope" })).toMatchObject({ ok: true, plan: { taskId } });
    }
    expect(await preflightStart(f.startEnv, { featureId: f.id, key: "next", taskId: BLOCKED, spec: "# scope" })).toMatchObject({ ok: false, code: "invalid" });
    expect(cardIdGate(BLOCKED)).toBe(`卡号 ${BLOCKED} ${CARD_ID_BLOCKED_HINT}`);
  } finally { await f.close(); }
});

test("[验收线 3] rewrite_dag 新节点卡号会撞闸：整次拒绝，DAG 不出新版本；短 key 照常写入", async () => {
  const f = integrationFixture();
  try {
    const version = f.feature().currentVersion;
    const bad = await f.tools.rewrite_dag(f.call, { featureId: f.id, reasonKind: "new_issue", reason: "add",
      add: [{ key: LONG_KEY, oneLine: "Long", fileGlobs: ["src/lib/long.ts"] }] });
    expect(bad).toMatchObject({ ok: false });
    expect(JSON.stringify(bad)).toContain(CARD_ID_BLOCKED_HINT);
    expect(JSON.stringify(bad)).toContain(`gate-${LONG_KEY}`);
    expect(f.feature().currentVersion).toBe(version);
    for (const key of ["RECLAIMINT1", "reclaim-interval-without-digits-x"]) {
      const ok = await f.tools.rewrite_dag(f.call, { featureId: f.id, reasonKind: "new_issue", reason: `add ${key}`,
        add: [{ key, oneLine: "Short", fileGlobs: ["src/lib/short.ts"] }] });
      expect(ok).toMatchObject({ ok: true });
    }
    expect(f.feature().currentVersion).toBe(version + 2);
  } finally { await f.close(); }
});

test("[验收线 3] 初版 DAG 有撞闸的新节点：整次拒绝，不出 v1", async () => {
  const f = integrationFixture();
  try {
    createFeature(f.db, { actor: f.actor }, { project: f.project, slug: "fresh", title: "Fresh" });
    const id = "c5a0-fresh";
    expect(() => initDag(f.db, { actor: f.actor }, { id, rev: 1, nodes: [{ key: "a", oneLine: "A" }, { key: LONG_KEY, oneLine: "Long" }] }))
      .toThrow(CARD_ID_BLOCKED_HINT);
    expect(getFeature(f.db, id)!.currentVersion).toBe(0);
    initDag(f.db, { actor: f.actor }, { id, rev: 1, nodes: [{ key: "a", oneLine: "A" }] });
    expect(getFeature(f.db, id)!.currentVersion).toBe(1);
  } finally { await f.close(); }
});

test("闸之前留下的未绑卡撞闸节点：一次无关的 rewrite 不被拒（只核新加的节点）", async () => {
  const f = integrationFixture();
  try {
    const legacy = [{ key: "existing", taskId: "c5-existing", oneLine: "Existing", deps: [], status: "spec", estimate: "", inheritedFrom: null, cardSlug: "gate" },
      { key: LONG_KEY, taskId: null, oneLine: "Legacy", deps: [], status: "planned", estimate: "", inheritedFrom: null, cardSlug: "gate", fileGlobs: ["src/lib/l.ts"] }];
    f.db.prepare("INSERT INTO dag_versions (featureId,version,reasonKind,reasonText,proposedBy,createdAt,nodes) VALUES (?,2,'new_issue','legacy','owner',1001,?)")
      .run(f.id, JSON.stringify(legacy));
    f.db.prepare("UPDATE features SET currentVersion = 2 WHERE id = ?").run(f.id);
    const ok = await f.tools.rewrite_dag(f.call, { featureId: f.id, reasonKind: "new_issue", reason: "unrelated",
      add: [{ key: "later", oneLine: "Later", fileGlobs: ["src/lib/later.ts"] }] });
    expect(ok).toMatchObject({ ok: true });
    expect(f.feature().currentVersion).toBe(3);
    // 那个旧节点仍然开不了卡
    const start = await f.tools.start_node(f.call, { featureId: f.id, key: LONG_KEY, spec: "# scope" });
    expect(start).toMatchObject({ ok: false, code: "invalid" });
    expect(getTask(f.db, `gate-${LONG_KEY}`)).toBeNull();
  } finally { await f.close(); }
});
