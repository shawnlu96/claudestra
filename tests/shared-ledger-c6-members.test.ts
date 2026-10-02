import { expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { prepareSharedLedgerImport, advanceSharedLedgerImport } from "../scripts/shared-ledger-import.js";
import { SharedLedgerClient, SharedLedgerRemoteError } from "../src/lib/shared-ledger-client.js";
import { SharedLedgerCache } from "../src/lib/shared-ledger-cache.js";
import type { SharedLedgerFeatureList } from "../src/lib/shared-ledger-contract.js";
import { makeDraft, rewrite, rebaseDraft, resolveNodeConflict, stale } from "../web/features/collab/shared/shared-model.js";
import { c6Fixture } from "./shared-ledger-c6-fixture.test.js";

async function until(predicate: () => boolean) {
  const deadline = Date.now() + 7000;
  while (!predicate() && Date.now() < deadline) await Bun.sleep(20);
  expect(predicate()).toBe(true);
}

test("two isolated members: import visibility, next poll, CAS draft rebase, locked execution and permissions over HTTP", async () => {
  const f = await c6Fixture(), stops: (() => void)[] = [];
  try {
    console.log(`C6 center temporary port ${f.port}; peer A / peer B have independent credential directories`);
    const prepared = await prepareSharedLedgerImport(f.db, f.options);
    const advance = (action: "commit" | "activate") => advanceSharedLedgerImport(f.db, f.dirs[0]!, "batch", f.client(), prepared.payload.manifestDigest, action);
    await advance("commit"); await advance("activate");
    const [a, b] = f.members as [SharedLedgerClient, SharedLedgerClient];
    const id = (await a.features()).features[0]!.id;
    expect(await b.feature(id)).toEqual(await a.feature(id));
    expect((await a.feature(id)).tasks).toHaveLength(1);
    const caches = [new SharedLedgerCache<SharedLedgerFeatureList>(), new SharedLedgerCache<SharedLedgerFeatureList>()];
    const errors: unknown[] = [];
    for (const side of [0, 1]) {
      const c = f.members[side]!;
      stops.push(c.poll(caches[side]!, { centerId: "center", teamId: "team", personId: c.connection.personId, projectId: "project" }, (e) => errors.push(e)));
    }
    await until(() => caches.every((c) => c.read()?.value.features.length === 1));
    await Promise.all(f.members.map((c, side) => c.command({ type: "feature.new", requestId: `new-${side}`, projectId: "project",
      title: side === 0 ? "peer A plan" : "peer B plan", description: "Shared plan", homeInstanceId: c.connection.instanceId })));
    await until(() => caches.every((c) => c.read()?.value.features.length === 3));
    expect(errors).toEqual([]);
    const base = await a.feature(id), drafts = [makeDraft(base), makeDraft(base)];
    drafts.forEach((d, i) => { d.nodes.find((n) => n.key === "free")!.oneLine = i ? "peer B draft" : "peer A draft"; d.reason = "Reviewed change"; });
    const results = await Promise.allSettled([a.command(rewrite(drafts[0]!, "edit-a")), b.command(rewrite(drafts[1]!, "edit-b"))]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const loser = results.findIndex((r) => r.status === "rejected"), failed = results[loser] as PromiseRejectedResult;
    expect(failed.reason).toBeInstanceOf(SharedLedgerRemoteError);
    expect(failed.reason.status).toBe(409);
    expect(drafts[loser]!.nodes.find((n) => n.key === "free")!.oneLine).toBe(loser ? "peer B draft" : "peer A draft");
    const latest = await f.members[loser]!.feature(id);
    const rebased = resolveNodeConflict(rebaseDraft(drafts[loser]!, latest), "free", "mine");
    await f.members[loser]!.command(rewrite(rebased, "resubmit"));
    const updated = await a.feature(id);
    expect(updated.dag.nodes.find((n) => n.key === "free")!.oneLine).toBe(loser ? "peer B draft" : "peer A draft");
    const locked = makeDraft(updated); locked.nodes.find((n) => n.key === "bound")!.oneLine = "Forbidden"; locked.reason = "Rejected bound change";
    expect(() => rewrite(locked, "locked")).toThrow("bound_node_locked");
    const lockedCommand = rewrite({ ...locked, nodes: updated.dag.nodes }, "locked");
    if (lockedCommand.type !== "dag.rewrite") throw new Error("expected rewrite");
    await expect(a.command({ ...lockedCommand, nodes: locked.nodes }))
      .rejects.toBeInstanceOf(SharedLedgerRemoteError);
    await expect(a.command({ type: "task.stage" } as never)).rejects.toThrow();
    await expect(a.controlImport({ mode: "revoke", batchId: "batch", projectId: "project", manifestDigest: prepared.payload.manifestDigest }))
      .rejects.toMatchObject({ status: 403, response: { code: "forbidden" } });
    await expect(a.command({ type: "feature.new", requestId: "cross", projectId: "other", title: "Denied", description: "", homeInstanceId: "peer-a" }))
      .rejects.toMatchObject({ status: 403 });
    const wrong = new SharedLedgerClient({ ...f.connections[0]!, instanceId: "wrong-instance" }, f.keys[0]!);
    await expect(wrong.features()).rejects.toMatchObject({ status: 403 });
    const stranger = new SharedLedgerClient({ ...f.connections[0]!, bearer: randomBytes(24).toString("hex") }, f.keys[0]!);
    await expect(stranger.features()).rejects.toMatchObject({ status: 403, response: { code: "not_member" } });
    await f.client().commitImport(prepared.payload);
    expect((await a.feature(id)).dag).toEqual(updated.dag);
    expect(stale(updated.feature, updated.feature.projection!.observedAt + 31000)).toBe(true);
    f.restart(); expect((await b.feature(id)).dag).toEqual(updated.dag);
    stops.forEach((stop) => stop()); stops.length = 0;
    f.stop();
    await expect(a.features()).rejects.toThrow("unconfirmed");
    expect(caches[0]!.read(caches[0]!.read()!.lastSuccessAt + 31000)!.stale).toBe(true);
    console.log("C6 V1 1-3 and recovery: shared import, five-second polling, one CAS winner, retained/rebased draft, denials PASS");
  } finally {
    stops.forEach((stop) => stop()); f.close();
    console.log("C6 cleanup: poll timers stopped; loopback server stopped; both temporary state directories removed");
  }
}, 20000);
