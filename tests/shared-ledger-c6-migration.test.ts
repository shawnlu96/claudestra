import { expect, test } from "bun:test";
import { prepareSharedLedgerImport, advanceSharedLedgerImport, revokeUncommittedSharedLedgerImport } from "../scripts/shared-ledger-import.js";
import { readSharedLedgerMode } from "../src/lib/shared-ledger-mode.js";
import { readSharedLedgerBindings } from "../src/lib/shared-ledger-gate-bindings.js";
import { c6Fixture } from "./shared-ledger-c6-fixture.test.js";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

test("migration commit verifies before routing, restart recovers the same batch, activation preserves gates", async () => {
  const f = await c6Fixture();
  try {
    const prepared = await prepareSharedLedgerImport(f.db, f.options), digest = prepared.payload.manifestDigest;
    const advance = (action: "commit" | "activate" | "revoke") => advanceSharedLedgerImport(f.db, f.dirs[0]!, "batch", f.client(), digest, action);
    await expect(advanceSharedLedgerImport(f.db, f.dirs[0]!, "batch", f.client(), "0".repeat(64), "commit")).rejects.toThrow("reviewed");
    const committed = await advance("commit");
    expect(committed.status).toBe("staged");
    expect(readSharedLedgerBindings(f.dirs[0])).toEqual([]);
    f.restart();
    expect(await advance("commit")).toEqual(committed);
    expect(f.store.get<{ n: number }>("SELECT count(*) n FROM features")!.n).toBe(1);
    expect((await advance("activate")).status).toBe("active");
    expect(readSharedLedgerMode(f.options.featureIds[0]!, f.dirs[0])).toEqual({ authorityMode: "planning", sharedPlanning: true });
    expect(readSharedLedgerBindings(f.dirs[0])).toHaveLength(1);
    await expect(advance("revoke")).rejects.toThrow("already opened");
  } finally { f.close(); }
});

test("lost commit/activation responses and offline lookup retain the gate and recover by receipt first", async () => {
  const f = await c6Fixture();
  try {
    const { payload } = await prepareSharedLedgerImport(f.db, f.options);
    const calls: string[] = [];
    let drop = "/imports", offline = false;
    const fetcher = (async (url, init) => {
      const path = new URL(String(url)).pathname; calls.push(`${init?.method} ${path}`);
      if (offline) throw new Error("offline");
      const response = await fetch(url, init);
      const mode = init?.body ? JSON.parse(String(init.body)).payload.mode : "";
      if (init?.method === "POST" && path.endsWith(drop) && ["commit", "activate"].includes(mode)) throw new Error("lost receipt");
      return response;
    }) as typeof fetch;
    const advance = (action: "commit" | "activate") => advanceSharedLedgerImport(f.db, f.dirs[0]!, "batch", f.client(fetcher), payload.manifestDigest, action);
    await expect(advance("commit")).rejects.toThrow("unconfirmed");
    expect(readSharedLedgerMode(f.options.featureIds[0]!, f.dirs[0]).sharedPlanning).toBe(true);
    const count = calls.length; offline = true;
    await expect(advance("commit")).rejects.toThrow("unconfirmed");
    expect(calls.slice(count)).toEqual(["GET /v1/teams/team/imports/batch"]);
    offline = false; drop = "none"; f.restart(); calls.length = 0;
    expect((await advance("commit")).status).toBe("staged");
    expect(calls).toEqual(["GET /v1/teams/team/imports/batch"]);
    drop = "/imports/batch";
    await expect(advance("activate")).rejects.toThrow("unconfirmed");
    calls.length = 0; drop = "none";
    expect((await advance("activate")).status).toBe("active");
    expect(calls).toEqual(["GET /v1/teams/team/imports/batch"]);
  } finally { f.close(); }
});

test("trial revoke reopens the local gate only after a confirmed durable central revocation", async () => {
  const f = await c6Fixture();
  try {
    const { payload } = await prepareSharedLedgerImport(f.db, f.options);
    const advance = (client = f.client(), action: "commit" | "revoke" = "commit") =>
      advanceSharedLedgerImport(f.db, f.dirs[0]!, "batch", client, payload.manifestDigest, action);
    await advance();
    const lost = f.client((async (url, init) => {
      const response = await fetch(url, init);
      if (init?.method === "POST") throw new Error("receipt lost");
      return response;
    }) as typeof fetch);
    await expect(advance(lost, "revoke")).rejects.toThrow("unconfirmed");
    expect(readSharedLedgerMode(f.options.featureIds[0]!, f.dirs[0]).sharedPlanning).toBe(true);
    f.restart();
    expect((await advance(f.client(), "revoke")).status).toBe("revoked");
    expect(readSharedLedgerMode(f.options.featureIds[0]!, f.dirs[0]).sharedPlanning).toBe(false);
    expect((await f.members[0]!.features()).features).toEqual([]);
    const path = join(f.dirs[0]!, "shared-ledger-migrations", "batch.json");
    const record = JSON.parse(readFileSync(path, "utf8"));
    writeFileSync(path, JSON.stringify({ ...record, phase: "revoking" }));
    await expect(prepareSharedLedgerImport(f.db, { ...f.options, batchId: "new-batch" })).rejects.toThrow("already migrating");
    await advance(f.client(), "revoke");
    await prepareSharedLedgerImport(f.db, { ...f.options, batchId: "new-batch" });
    await advance(f.client(), "revoke");
    expect(readSharedLedgerMode(f.options.featureIds[0]!, f.dirs[0]).sharedPlanning).toBe(true);
  } finally { f.close(); }
});

test("a center rollback or missing previously confirmed receipt cannot reopen or silently recommit", async () => {
  const f = await c6Fixture();
  try {
    const { payload } = await prepareSharedLedgerImport(f.db, f.options);
    await advanceSharedLedgerImport(f.db, f.dirs[0]!, "batch", f.client(), payload.manifestDigest, "commit");
    const methods: string[] = [];
    const client = f.client((async (_url, init) => {
      methods.push(init?.method ?? "");
      return Response.json({ status: "unknown", batchId: "batch" });
    }) as typeof fetch);
    await expect(advanceSharedLedgerImport(f.db, f.dirs[0]!, "batch", client, payload.manifestDigest, "commit"))
      .rejects.toThrow("receipt rollback");
    expect(methods).toEqual(["GET"]);
    expect(readSharedLedgerMode(f.options.featureIds[0]!, f.dirs[0]).sharedPlanning).toBe(true);
  } finally { f.close(); }
});

test("prepared batch aborts locally while offline and a new selection can prepare under a new batch", async () => {
  const f = await c6Fixture();
  try {
    const { payload } = await prepareSharedLedgerImport(f.db, f.options);
    const offline = f.client((async () => { throw new Error("center must not be contacted"); }) as unknown as typeof fetch);
    await expect(advanceSharedLedgerImport(f.db, f.dirs[0]!, "batch", offline, "bad", "revoke"))
      .rejects.toThrow("reviewed manifest digest required");
    expect(readSharedLedgerMode(f.options.featureIds[0]!, f.dirs[0]).sharedPlanning).toBe(true);
    expect((await advanceSharedLedgerImport(f.db, f.dirs[0]!, "batch", offline, payload.manifestDigest, "revoke")).status).toBe("aborted");
    expect(readSharedLedgerMode(f.options.featureIds[0]!, f.dirs[0]).sharedPlanning).toBe(false);
    expect(JSON.parse(readFileSync(join(f.dirs[0]!, "shared-ledger-migrations", "batch.json"), "utf8")).phase).toBe("aborted");
    expect(await revokeUncommittedSharedLedgerImport(f.db, f.dirs[0]!, "batch")).toEqual({ status: "aborted", batchId: "batch" });
    await expect(advanceSharedLedgerImport(f.db, f.dirs[0]!, "batch", offline, payload.manifestDigest, "commit"))
      .rejects.toThrow("migration aborted");
    await expect(prepareSharedLedgerImport(f.db, f.options)).rejects.toThrow("batch revoked");
    await prepareSharedLedgerImport(f.db, { ...f.options, batchId: "other",
      summaries: { [f.options.featureIds[0]!]: { summary: "revised", digest: null } } });
  } finally { f.close(); }
});

test("gating crash aborts without payload or center credential; committing cannot abort locally", async () => {
  const f = await c6Fixture();
  try {
    const { payload } = await prepareSharedLedgerImport(f.db, f.options);
    const path = join(f.dirs[0]!, "shared-ledger-migrations", "batch.json");
    const record = JSON.parse(readFileSync(path, "utf8"));
    writeFileSync(path, JSON.stringify({ ...record, phase: "gating", payload: undefined }));
    expect(await revokeUncommittedSharedLedgerImport(f.db, f.dirs[0]!, "batch")).toEqual({ status: "aborted", batchId: "batch" });
    expect(JSON.parse(readFileSync(path, "utf8")).phase).toBe("aborted");
    expect(readSharedLedgerMode(f.options.featureIds[0]!, f.dirs[0]).sharedPlanning).toBe(false);
    await prepareSharedLedgerImport(f.db, { ...f.options, batchId: "next" });
    const nextPath = join(f.dirs[0]!, "shared-ledger-migrations", "next.json");
    const next = JSON.parse(readFileSync(nextPath, "utf8"));
    writeFileSync(nextPath, JSON.stringify({ ...next, phase: "committing" }));
    expect(await revokeUncommittedSharedLedgerImport(f.db, f.dirs[0]!, "next", payload.manifestDigest)).toBeNull();
    expect(readSharedLedgerMode(f.options.featureIds[0]!, f.dirs[0]).sharedPlanning).toBe(true);
  } finally { f.close(); }
});
