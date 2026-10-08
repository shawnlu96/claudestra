/** team-project-N8A4: binding history pre-checked locally, a center refusal splits the batch, identity / rate refusals refuse nothing. */
import { afterEach, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { STATE_DIR } from "../src/lib/paths.js";
import { createTask } from "../src/lib/ledger-write.js";
import { SharedLedgerRemoteError } from "../src/lib/shared-ledger-client.js";
import type { SharedLedgerClient } from "../src/lib/shared-ledger-client.js";
import type { SharedLedgerImport } from "../src/lib/shared-ledger-contract.js";
import { AUTO_SHARE_RULES, autoShareBindingBreak } from "../src/lib/shared-ledger-auto-share-check.js";
import { autoShareFixture, cleanupAutoShareState, PROJECT } from "./shared-ledger-auto-share-fixture.test.js";

afterEach(() => cleanupAutoShareState());
const T0 = Date.UTC(2026, 9, 9, 12, 0), STEP = 300_000;
const SENTINEL = "n8a4-center-message-sentinel";
type Fixture = Awaited<ReturnType<typeof autoShareFixture>>;
type Refuse = (p: SharedLedgerImport, call: "dry-run" | "commit") => SharedLedgerRemoteError | null;

/** The fake center with a refusal rule in front of dry-run / commit; `sent` records each dry-run's feature ids. */
function refusing(f: Fixture, refuse: Refuse) {
  const base = f.center.client, sent: string[][] = [];
  f.center.client = (connection: unknown) => {
    const inner = base(connection) as unknown as Record<string, (...a: unknown[]) => Promise<unknown>>;
    return { ...inner,
      async import(p: SharedLedgerImport) {
        sent.push(p.manifest.features.map((x) => x.sourceFeatureId));
        const error = refuse(p, "dry-run");
        if (error) { f.center.calls.push(`dry-run ${p.batchId}`); throw error; }
        return inner.import!(p);
      },
      async commitImport(p: SharedLedgerImport) {
        const error = refuse(p, "commit");
        if (error) { f.center.calls.push(`commit ${p.batchId}`); throw error; }
        return inner.commitImport!(p);
      } } as unknown as SharedLedgerClient;
  };
  return sent;
}
const invalid = () => new SharedLedgerRemoteError(400, { code: "invalid_field", message: `binding dropped ${SENTINEL}` });
/** The center's import replay (background 1): a binding once present stays, same taskId, in every later version. */
const centerReplayRefuses = (p: SharedLedgerImport) => p.manifest.features.some((x) => x.versions.some((v, i) =>
  i > 0 && x.versions[i - 1]!.bindings.some((b) => !v.bindings.some((n) => n.nodeKey === b.nodeKey && n.taskId === b.taskId))));

/** Feature `slug`: version 1 binds node work → a card, version 2 drops the binding. */
function droppedBinding(f: Fixture, slug: string): string {
  const id = f.feature(slug), task = `${slug}-card`;
  createTask(f.db, { actor: "owner", now: 1000 }, { project: PROJECT, id: task, title: `Card ${slug}`, kind: "code" });
  f.db.prepare("INSERT INTO dag_bindings (featureId, version, nodeKey, taskId, boundBy, boundAt) VALUES (?, 1, 'work', ?, 'owner', 1000)").run(id, task);
  f.db.prepare(`INSERT INTO dag_versions (featureId, version, reasonKind, reasonText, proposedBy, createdAt, nodes)
    SELECT featureId, 2, 'new_issue', 'Second plan', proposedBy, createdAt + 1, nodes FROM dag_versions WHERE featureId = ? AND version = 1`).run(id);
  f.db.prepare("UPDATE features SET currentVersion = 2 WHERE id = ?").run(id);
  return id;
}

test("binding continuity: first break is the later version and its nodeKey; kept or retargeted bindings are judged by nodeKey + taskId", () => {
  const v = (version: number, ...bindings: [string, string][]) => ({ version, bindings: bindings.map(([nodeKey, taskId]) => ({ nodeKey, taskId })) });
  expect(autoShareBindingBreak([])).toBeNull();
  expect(autoShareBindingBreak([v(1, ["a", "T1"])])).toBeNull();
  expect(autoShareBindingBreak([v(1, ["a", "T1"]), v(2, ["a", "T1"], ["b", "T2"]), v(3, ["b", "T2"], ["a", "T1"])])).toBeNull();
  expect(autoShareBindingBreak([v(1, ["a", "T1"]), v(2)])).toEqual({ version: 2, nodeKey: "a" });
  expect(autoShareBindingBreak([v(1), v(2, ["a", "T1"], ["b", "T2"]), v(3, ["a", "T1"], ["b", "T9"])])).toEqual({ version: 3, nodeKey: "b" });
});

test("验收 1: a feature whose history drops a bound card is refused locally with 0 center requests; the others share in one batch", async () => {
  const f = await autoShareFixture(["alpha", "beta"]);
  try {
    const p = droppedBinding(f, "pdrop"), [a, b] = f.features as [string, string];
    const sent = refusing(f, (payload) => centerReplayRefuses(payload) ? invalid() : null);
    await f.ledger(["shared-auto", "on", PROJECT]);
    await f.pass(T0);
    expect(f.state().features![p]).toMatchObject({ status: "refused", reason: "历史版本删掉了已绑定的卡", rules: AUTO_SHARE_RULES });
    expect(sent).toEqual([[a, b].sort()]);
    expect(f.state().batches!.map((x) => [x.featureIds, x.outcome])).toEqual([[[a, b].sort(), "staged"]]);
    for (const id of [a, b]) expect(f.state().features![id]!.status).toBe("shared");
    const calls = f.center.calls.length;
    await f.pass(T0 + STEP);
    expect(f.center.calls.length).toBe(calls);
    expect(f.state().features![p]).toMatchObject({ status: "refused", reason: "历史版本删掉了已绑定的卡" });
  } finally { await f.close(); }
});

test("验收 2 + 4: a center 400 splits the batch; alone, only the refused feature is refused with the contract code, never the center's text", async () => {
  const f = await autoShareFixture(["cfeat", "dfeat", "qfeat"]);
  try {
    const [c, d, q] = f.features as [string, string, string];
    const sent = refusing(f, (payload) => payload.manifest.features.some((x) => x.sourceFeatureId === q) ? invalid() : null);
    await f.ledger(["shared-auto", "on", PROJECT]);
    await f.pass(T0);
    for (const id of [c, d, q]) expect(f.state().features![id]).toMatchObject({ status: "deferred", reason: "批次被中心拒收，下轮单独成批", solo: true });
    expect(f.state().lastError ?? null).toBeNull();
    for (let round = 1; round <= 3; round++) await f.pass(T0 + round * STEP);
    expect(sent.map((s) => [...s].sort())).toEqual([[c, d, q].sort(), [c], [d], [q]]);
    expect(new Set(sent.map((s) => [...s].sort().join(","))).size).toBe(sent.length);
    for (const id of [c, d]) expect(f.state().features![id]!.status).toBe("shared");
    expect(f.state().features![q]).toMatchObject({ status: "refused", reason: "中心拒收(invalid_field)", rules: AUTO_SHARE_RULES });
    const calls = f.center.calls.length;
    await f.pass(T0 + 4 * STEP);
    expect(f.center.calls.length).toBe(calls);
    const status = await f.ledger(["shared-auto", "status", PROJECT]) as { lists: Record<string, { featureId: string; reason?: string }[]> };
    expect(status.lists["拒收"]).toEqual([{ featureId: q, reason: "中心拒收(invalid_field)" }]);
    expect(JSON.stringify(status)).not.toContain(SENTINEL);
    expect(readFileSync(join(STATE_DIR, "shared-ledger-auto-share.json"), "utf8")).not.toContain(SENTINEL);
  } finally { await f.close(); }
});

for (const [status, body, code] of [[403, { code: "forbidden", message: SENTINEL }, "forbidden"], [429, { message: SENTINEL }, "unknown"]] as const) {
  test(`验收 3: a ${status} on commit defers the whole batch (no solo, no refusal); the next pass shares the same batch`, async () => {
    const f = await autoShareFixture(["alpha", "beta"]);
    try {
      let once = true;
      const sent = refusing(f, (_p, call) => call === "commit" && once ? (once = false, new SharedLedgerRemoteError(status, body)) : null);
      await f.ledger(["shared-auto", "on", PROJECT]);
      await f.pass(T0);
      const text = `中心暂时拒绝(${code})，下轮重试`;
      for (const id of f.features) {
        expect(f.state().features![id]).toMatchObject({ status: "deferred", reason: text });
        expect(f.state().features![id]!.solo).toBeUndefined();
      }
      expect(f.state()).toMatchObject({ pending: null, lastError: text, batches: [{ outcome: "center-busy" }] });
      await f.pass(T0 + STEP);
      expect(sent).toEqual([f.features, f.features]);
      for (const id of f.features) expect(f.state().features![id]!.status).toBe("shared");
      expect(f.state().lastError).toBeNull();
      expect(readFileSync(join(STATE_DIR, "shared-ledger-auto-share.json"), "utf8")).not.toContain(SENTINEL);
    } finally { await f.close(); }
  });
}
