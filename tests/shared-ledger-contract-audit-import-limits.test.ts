import { describe, expect, test } from "bun:test";
import { generateKeyPairSync } from "node:crypto";
import { SharedLedgerClient } from "../src/lib/shared-ledger-client.js";
import { SharedLedgerError, SHARED_LEDGER_MAX_BODY_BYTES, type SharedLedgerImport, type SharedLedgerImportResult } from "../src/lib/shared-ledger-contract.js";
import {
  SHARED_LEDGER_MAX_IMPORT_MAPPINGS, SHARED_LEDGER_MAX_IMPORT_MAPPING_BYTES, sharedLedgerImportManifestMappings, sharedLedgerImportMappingBytes,
} from "../src/lib/shared-ledger-contract-import-limits.js";
import { parseSharedLedgerResponse } from "../src/lib/shared-ledger-contract-responses.js";
import { parseSharedLedgerImport, sharedLedgerManifestDigest } from "../src/lib/shared-ledger-contract-transfer.js";

type Mapping = SharedLedgerImportResult["mappings"][number];
const SOURCE = "synthetic-instance";
const connection = { centerId: "fake-center", baseUrl: "http://127.0.0.1/", teamId: "fake-team",
  personId: "fake-member", instanceId: "fake-instance", bearer: "obviously-fake-credential" };
function fakeKey() {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  return { privateKey, publicKey: String(publicKey.export({ format: "jwk" }).x) };
}
const rejected = (run: () => unknown) => {
  try { run(); } catch (error) { expect((error as SharedLedgerError).code).toBe("invalid_field"); return; }
  throw new Error("expected invalid_field");
};

const task = (sourceTaskId: string) => ({ sourceTaskId, sourceRev: 1, sourceSeq: 1, stage: "write", assigneeCode: null, executorInstanceId: null,
  pr: null, head: null, deps: [], specSummary: "", specDigest: null, fullText: "home_only" as const, steps: [], asks: [] });
/** Synthetic ledger: one feature per entry, holding the given task ids; a single-task feature binds it to a one-node DAG. */
function synthetic(taskIds: string[][], sourceInstanceId = SOURCE, mode: SharedLedgerImport["mode"] = "dry-run"): SharedLedgerImport {
  const manifest: SharedLedgerImport["manifest"] = { projectId: "synthetic-project", sourceInstanceId, sourceSeq: 1,
    features: taskIds.map((ids, i) => ({ sourceFeatureId: `f${i}`, title: `feature ${i}`, description: "", rev: 1, authorityMode: "source",
      pendingProposal: false,
      versions: ids.length === 1 ? [{ version: 1, nodes: [{ key: "C1", oneLine: "card", deps: [], fileGlobs: [], estimate: "" }],
        bindings: [{ nodeKey: "C1", taskId: ids[0]! }], reason: "" }] : [],
      projection: { mode: "snapshot", previousSourceSeq: 0, sourceSeq: 1, observedAt: 1, tasks: ids.map(task), events: [] } })) };
  return { mode, batchId: "synthetic-batch", manifestDigest: sharedLedgerManifestDigest(manifest), manifest };
}
const singleCards = (n: number) => synthetic(Array.from({ length: n }, (_, i) => [`t${i}`]));
/** The full mapping list a center returns for the payload, in manifest order. */
const mapped = (p: SharedLedgerImport, idOf = (m: Mapping) => `center-${m.kind}-${m.sourceId}`): Mapping[] =>
  sharedLedgerImportManifestMappings(p.manifest).map((m) => ({ ...m, id: idOf(m) }));
const result = (p: SharedLedgerImport, mappings: Mapping[], mode = p.mode): SharedLedgerImportResult =>
  ({ schemaVersion: 1, mode, batchId: p.batchId, manifestDigest: p.manifestDigest, serverSeq: 1, mappings });

/** Fake center on the client's fetch seam: stages a commit and serves it back inside the receipt wrapper. */
function fakeCenter(mappingsOf: (p: SharedLedgerImport) => Mapping[] = mapped) {
  let staged: unknown = null, posts = 0;
  const fetcher = (async (url, init) => {
    const batchId = "synthetic-batch";
    if (init?.method === "GET") return Response.json(staged ?? { status: "unknown", batchId });
    posts++;
    const p = JSON.parse(init!.body as string).payload as SharedLedgerImport;
    const receipt = result(p, mappingsOf(p));
    if (p.mode === "commit") {
      const fs = p.manifest.features;
      staged = { status: "staged", batchId, projectId: p.manifest.projectId, serverSeq: 1, receipt,
        verification: { features: fs.length, versions: fs.reduce((n, f) => n + f.versions.length, 0),
          bindings: fs.reduce((n, f) => n + f.versions.reduce((a, v) => a + v.bindings.length, 0), 0),
          tasks: fs.reduce((n, f) => n + f.projection.tasks.length, 0), sourceSeq: p.manifest.sourceSeq, manifestDigest: p.manifestDigest } };
    }
    return Response.json(receipt);
  }) as typeof fetch;
  const client = new SharedLedgerClient(connection, fakeKey(), { fetch: fetcher, scrub: { identity: { username: "fake-user", hostname: "fake-host" } } });
  return { client, posts: () => posts };
}

describe("[验收线 1] single-card features: import and full mapping receipt agree across dry-run, commit and the receipt wrapper", () => {
  for (const n of [500, 501]) {
    test(`${n} features with one task each`, async () => {
      const payload = singleCards(n);
      expect(parseSharedLedgerImport(payload).manifest.features).toHaveLength(n);
      const expected = mapped(payload);
      expect(expected).toHaveLength(2 * n);
      expect(parseSharedLedgerResponse("import", result(payload, expected)).mappings).toEqual(expected);
      const center = fakeCenter();
      const dryRun = await center.client.import(payload);
      const commit = await center.client.commitImport(payload);
      const wrapper = await center.client.importReceipt(payload.batchId);
      expect(dryRun.mappings).toEqual(expected);
      expect(commit.mappings).toEqual(expected);
      if (wrapper.status === "unknown") throw new Error("receipt was not staged");
      expect(wrapper.receipt).toEqual(commit);
      // An already-staged batch answers a repeated commit from the wrapper's embedded receipt.
      expect(await center.client.commitImport(payload)).toEqual(commit);
      expect(center.posts()).toBe(2);
    });
  }
});

/** n features of up to 1000 tasks each, with ids sized so the reserved mapping bytes total exactly `bytes`. */
function sizedToBytes(bytes: number): SharedLedgerImport {
  const source = "s".repeat(128);
  const of = (kind: Mapping["kind"], sourceId: string) => sharedLedgerImportMappingBytes({ kind, sourceInstanceId: source, sourceId, id: "x".repeat(128) });
  const features = 3, emptyTask = of("task", "");
  const forTasks = bytes - [0, 1, 2].reduce((n, i) => n + of("feature", `f${i}`), 0);
  const count = Math.ceil(forTasks / (emptyTask + 128));
  const idChars = forTasks - count * emptyTask;
  const ids = Array.from({ length: count }, (_, i) => {
    const length = Math.floor(idChars / count) + (i < idChars % count ? 1 : 0);
    return `${String(i).padStart(5, "0")}${"t".repeat(length - 5)}`;
  });
  return synthetic(Array.from({ length: features }, (_, i) => ids.slice(i * 1000, (i + 1) * 1000)), source);
}
const longestId = (m: Mapping) => `${m.kind === "feature" ? "F" : "T"}${m.sourceId.slice(0, 127)}`.padEnd(128, "c");
const reservedBytes = (p: SharedLedgerImport) => sharedLedgerImportManifestMappings(p.manifest).reduce((n, m) => n + sharedLedgerImportMappingBytes(m), 0);

describe("[验收线 2] one total budget for the request and the response", () => {
  test("the count boundary round-trips and one more feature-or-task is refused before submission", async () => {
    const atLimit = synthetic(Array.from({ length: 4 }, (_, f) => Array.from({ length: SHARED_LEDGER_MAX_IMPORT_MAPPINGS / 4 - 1 }, (_, i) => `t${f}-${i}`)));
    const expected = mapped(atLimit);
    expect(expected).toHaveLength(SHARED_LEDGER_MAX_IMPORT_MAPPINGS);
    expect(parseSharedLedgerImport(atLimit).manifestDigest).toBe(atLimit.manifestDigest);
    expect(parseSharedLedgerResponse("import", result(atLimit, expected)).mappings).toEqual(expected);
    const center = fakeCenter();
    expect((await center.client.import(atLimit)).mappings).toHaveLength(SHARED_LEDGER_MAX_IMPORT_MAPPINGS);

    const tasks = atLimit.manifest.features.map((f) => f.projection.tasks.map((t) => t.sourceTaskId));
    const oneMoreTask = synthetic([[...tasks[0]!, "extra"], ...tasks.slice(1)]);
    const oneMoreFeature = synthetic([...tasks, []]);
    for (const over of [oneMoreTask, oneMoreFeature]) {
      rejected(() => parseSharedLedgerImport(over));
      for (const mode of ["dry-run", "commit"] as const) rejected(() => parseSharedLedgerImport({ ...over, mode }));
      await expect(center.client.import(over)).rejects.toThrow();
      await expect(center.client.commitImport(over)).rejects.toThrow();
      rejected(() => parseSharedLedgerResponse("import", result(over, mapped(over))));
    }
    expect(center.posts()).toBe(1);
  });

  test("the byte boundary round-trips with the longest ids and one more byte is refused before submission", async () => {
    const atLimit = sizedToBytes(SHARED_LEDGER_MAX_IMPORT_MAPPING_BYTES);
    expect(reservedBytes(atLimit)).toBe(SHARED_LEDGER_MAX_IMPORT_MAPPING_BYTES);
    expect(sharedLedgerImportManifestMappings(atLimit.manifest).length).toBeLessThan(SHARED_LEDGER_MAX_IMPORT_MAPPINGS);
    expect(parseSharedLedgerImport(atLimit).manifestDigest).toBe(atLimit.manifestDigest);
    // The center may assign ids of any valid length: the longest ones still fit the response budget.
    const longest = mapped(atLimit, longestId);
    expect(longest.every((m) => m.id.length === 128)).toBe(true);
    const response = result(atLimit, longest);
    expect(parseSharedLedgerResponse("import", response).mappings).toEqual(longest);
    const wrapper = { status: "staged", batchId: atLimit.batchId, projectId: "p".repeat(128), serverSeq: Number.MAX_SAFE_INTEGER, receipt: response,
      verification: Object.fromEntries(["features", "versions", "bindings", "tasks", "sourceSeq"].map((k) => [k, Number.MAX_SAFE_INTEGER])) };
    expect(Buffer.byteLength(JSON.stringify(wrapper))).toBeLessThanOrEqual(SHARED_LEDGER_MAX_BODY_BYTES);

    const over = sizedToBytes(SHARED_LEDGER_MAX_IMPORT_MAPPING_BYTES + 1);
    expect(reservedBytes(over)).toBe(SHARED_LEDGER_MAX_IMPORT_MAPPING_BYTES + 1);
    rejected(() => parseSharedLedgerImport(over));
    rejected(() => parseSharedLedgerImport({ ...over, mode: "commit" }));
    rejected(() => parseSharedLedgerResponse("import", result(over, mapped(over, longestId))));
  });

  test("the count limit at its worst-case bytes exceeds the byte budget, so both limits bind", () => {
    const worst = sharedLedgerImportMappingBytes({ kind: "feature", sourceInstanceId: "s".repeat(128), sourceId: "s".repeat(128), id: "x".repeat(128) });
    expect(SHARED_LEDGER_MAX_IMPORT_MAPPINGS * worst).toBeGreaterThan(SHARED_LEDGER_MAX_IMPORT_MAPPING_BYTES);
    expect(1002 * worst).toBeLessThan(SHARED_LEDGER_MAX_IMPORT_MAPPING_BYTES);
  });

  test("duplicate, wrong or missing mappings are refused instead of being dropped", async () => {
    const payload = singleCards(400);
    const good = mapped(payload);
    const bad: Record<string, Mapping[]> = {
      "duplicate row": [...good, good[0]!],
      "duplicate source": [...good.slice(1), { ...good[0]!, id: "center-other" }, good[0]!],
      "duplicate target": [{ ...good[0]!, id: good[2]!.id }, ...good.slice(1)],
      "unknown kind": [{ ...good[0]!, kind: "item" as Mapping["kind"] }, ...good.slice(1)],
      "invalid id": [{ ...good[0]!, id: "" }, ...good.slice(1)],
      "extra field": [{ ...good[0]!, note: "x" } as Mapping, ...good.slice(1)],
    };
    for (const [name, mappings] of Object.entries(bad)) {
      try { parseSharedLedgerResponse("import", result(payload, mappings)); } catch (error) {
        expect((error as SharedLedgerError).code).toBe("invalid_field");
        continue;
      }
      throw new Error(`${name} was accepted`);
    }
    // A center that returns a rejected list never yields a shortened receipt through any of the three paths.
    const center = fakeCenter((p) => [...mapped(p), mapped(p)[0]!]);
    await expect(center.client.import(payload)).rejects.toThrow();
    await expect(center.client.commitImport(payload)).rejects.toThrow();
    await expect(center.client.importReceipt(payload.batchId)).rejects.toThrow();
    // The same task under a feature and a task kind is two mappings, not a duplicate.
    const sameSource = [{ kind: "feature", sourceInstanceId: SOURCE, sourceId: "a", id: "x" }, { kind: "task", sourceInstanceId: SOURCE, sourceId: "a", id: "x" }] as Mapping[];
    expect(parseSharedLedgerResponse("import", result(payload, sameSource)).mappings).toEqual(sameSource);
  });
});
