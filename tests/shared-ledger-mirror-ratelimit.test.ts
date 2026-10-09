import { expect, test } from "bun:test";
import { createFeature, initDag } from "../src/lib/ledger-feature-write.js";
import { setMeta } from "../src/lib/ledger-write.js";
import { instanceKeySync } from "../src/lib/instance-key.js";
import { SharedLedgerClient, SharedLedgerRemoteError } from "../src/lib/shared-ledger-client.js";
import * as transport from "../src/lib/shared-ledger-client-transport.js";
import { runSharedLedgerMirrorPass, type MirrorLoopDeps } from "../src/lib/shared-ledger-mirror-loop.js";
import { readSharedLedgerMirrors, resolveMirrorCredential, updateSharedLedgerMirrors } from "../src/lib/shared-ledger-mirror.js";
import { writeSharedLedgerMode } from "../src/lib/shared-ledger-mode.js";
import type { SharedLedgerProjection } from "../src/lib/shared-ledger-contract.js";
import { sourceDagUploadDigest, type SourceDagUpload } from "../src/lib/shared-ledger-contract-source-dag.js";
import { integrationFixture } from "./shared-ledger-integration-fixture.test.js";
import { mirrorEntry, SCRUB, serviceCredential } from "./shared-ledger-mirror-fixture.test.js";

/** Each world owns its state and clock; simulated sleeps also generate an event every two seconds during a pass. */
async function world(count = 30) {
  const f = integrationFixture(), dir = f.startEnv.ledgerDir;
  await serviceCredential(dir);
  let t = 100_000, nextEvent = t + 2000;
  const advance = (ms: number) => {
    const end = t + ms;
    while (nextEvent <= end) {
      setMeta(f.db, { actor: "owner", now: nextEvent }, { project: f.project, key: "docsDir", value: `tick-${nextEvent}` });
      nextEvent += 2000;
    }
    t = end;
  };
  const ids: string[] = [];
  for (let i = 0; i < count; i++) {
    const id = createFeature(f.db, { actor: f.actor }, { project: f.project, slug: `rate-${String(i).padStart(2, "0")}`, title: `Rate ${i}` }).row.id;
    initDag(f.db, { actor: f.actor }, { id, rev: 1, nodes: [{ key: "work", oneLine: "Work", fileGlobs: ["src/work.ts"] }] });
    await writeSharedLedgerMode(id, { authorityMode: "source", sharedPlanning: true, mirror: true }, dir, f.db.filename);
    ids.push(id);
  }
  await updateSharedLedgerMirrors(dir, (entries) => {
    for (const id of ids) entries[id] = mirrorEntry(f, 0, { centerFeatureId: `center-${id}`, snapshot: true });
  });
  const deps: MirrorLoopDeps = { stateDir: dir, ledgerPath: f.db.filename, now: () => t,
    sleep: async (ms) => advance(ms), scrub: async () => SCRUB };
  return { f, dir, ids, deps, advance, now: () => t, entries: () => readSharedLedgerMirrors(dir) };
}

type Call = { at: number; resource: string; feature: string };
/** Real signed transport, projection and source-DAG codecs; the center can inject HTTP errors before decoding. */
function center(w: Awaited<ReturnType<typeof world>>, reject: (c: Call, n: number) => Response | null = () => null) {
  const calls: Call[] = [], observed = new Map<string, number>();
  const fetcher = (async (url: URL, init?: RequestInit) => {
    const payload = JSON.parse(String(init?.body)).payload as SharedLedgerProjection | SourceDagUpload;
    const call = { at: w.now(), resource: url.pathname.split("/").at(-1)!, feature: payload.featureId };
    calls.push(call);
    const no = reject(call, calls.length);
    if (no) return no;
    if (call.resource === "source-dags") {
      const dag = payload as SourceDagUpload;
      return Response.json({ schemaVersion: 1, featureId: dag.featureId, version: dag.dag.version, digest: sourceDagUploadDigest(dag), droppedBindings: 0 });
    }
    const projection = payload as SharedLedgerProjection;
    observed.set(payload.featureId, projection.observedAt);
    return Response.json({ schemaVersion: 1, serverSeq: calls.length, sourceInstanceId: projection.sourceInstanceId,
      sourceSeq: projection.sourceSeq, digest: "a".repeat(64) });
  }) as unknown as typeof fetch;
  return { calls, observed, fetcher, pass: () => runSharedLedgerMirrorPass({ ...w.deps, fetch: fetcher }) };
}

test("N8A9: 30 mirrors, 2r/s burst20, local events every 2s, 5min: fair rotation, <=60s lag, no 429 failures", async () => {
  const w = await world();
  try {
    let tokens = 20, refilled = w.now(), maxLag = 0, maxFeatures = 0, maxFailures = 0, minGap = Infinity;
    const start = w.now();
    const limited: number[] = [];
    const c = center(w, (call) => {
      for (const id of w.ids) maxLag = Math.max(maxLag, w.now() - (c.observed.get(`center-${id}`) ?? start));
      tokens = Math.min(20, tokens + (call.at - refilled) / 500); refilled = call.at;
      if (tokens < 1) { limited.push(call.at); return new Response("nginx", { status: 429, headers: { "Retry-After": "1" } }); }
      tokens--;
      return null;
    });
    let firstEnded = 0;
    while (w.now() - start < 300_000) {
      const before = c.calls.length, roundStart = w.now();
      await c.pass();
      for (let i = before + 1; i < c.calls.length; i++) minGap = Math.min(minGap, c.calls[i]!.at - c.calls[i - 1]!.at);
      maxFeatures = Math.max(maxFeatures, new Set(c.calls.slice(before).map((x) => x.feature)).size);
      if (!firstEnded) firstEnded = w.now();
      // Unseen features start with the import's observation time; the initial sweep must finish within a minute too.
      for (const id of w.ids) maxLag = Math.max(maxLag, w.now() - (c.observed.get(`center-${id}`) ?? start));
      for (const e of Object.values(w.entries())) maxFailures = Math.max(maxFailures, e.failures);
      w.advance(Math.max(600, 10_000 - (w.now() - roundStart)));
    }
    console.info("N8A9 simulation", JSON.stringify({ calls: c.calls.length, limited: limited.length,
      afterFirst: limited.filter((at) => at > firstEnded).length, maxLag, maxFeatures, maxFailures, minGap, observed: c.observed.size }));
    expect(minGap).toBeGreaterThanOrEqual(600);
    expect(maxFeatures).toBeLessThanOrEqual(12);
    expect(maxFailures).toBe(0);
    expect(c.observed.size).toBe(30);
    expect(limited.filter((at) => at > firstEnded).length).toBeLessThanOrEqual(2);
    expect(maxLag).toBeLessThanOrEqual(60_000);
  } finally { await w.f.close(); }
});

test("N8A9: projection 429 stops remaining features, preserves failures/backoff, holds every feature and import across processes", async () => {
  const w = await world(4);
  try {
    await updateSharedLedgerMirrors(w.dir, (entries) => { entries[w.ids[0]!]!.failures = 3; });
    const before = w.entries();
    const c = center(w, () => new Response("nginx private body", { status: 429, headers: { "Retry-After": "30" } }));
    await c.pass();
    expect(c.calls).toHaveLength(1);
    const limited = w.entries()[w.ids[0]!]!;
    expect(limited).toEqual({ ...before[w.ids[0]!]!, lastError: "中心限流", lastErrorAt: w.now() });
    for (const id of w.ids.slice(1)) expect(w.entries()[id]).toEqual(before[id]);
    const credential = resolveMirrorCredential(limited, w.dir)!;
    const until = transport.sharedLedgerNotBefore(credential.baseUrl, w.dir);
    expect(until).toBe(w.now() + 30_000);
    w.advance(29_999);
    expect(await c.pass()).toEqual({});
    expect(c.calls).toHaveLength(1);
    await expect(transport.requestSharedLedger(credential, instanceKeySync(w.dir)!, { stateDir: w.dir, now: w.now, fetch: c.fetcher },
      "POST", `/v1/teams/${credential.teamId}/imports`, {})).rejects.toMatchObject({ status: 429 });
    expect(c.calls).toHaveLength(1);
    // A new process sees the same gate (the auto-share importer runs in a child, not the mirror's process).
    const script = `import { requestSharedLedger } from ${JSON.stringify(new URL("../src/lib/shared-ledger-client-transport.ts", import.meta.url).pathname)};
      import { instanceKeySync } from ${JSON.stringify(new URL("../src/lib/instance-key.ts", import.meta.url).pathname)};
      try { await requestSharedLedger(${JSON.stringify(credential)}, instanceKeySync(${JSON.stringify(w.dir)}),
        {stateDir:${JSON.stringify(w.dir)},now:()=>${w.now()},fetch:async()=>{throw Error("must not fetch")}},"POST","/v1/teams/team-a/imports",{}); }
      catch(e) { console.log(e.status); }`;
    const child = Bun.spawn([process.execPath, "--no-env-file", "-e", script], { stdout: "pipe", stderr: "pipe" });
    expect(await new Response(child.stdout).text()).toBe("429\n");
    expect(await child.exited).toBe(0);
    w.advance(1);
    const ok = center(w);
    await ok.pass();
    expect(ok.calls.length).toBeGreaterThan(0);
  } finally { await w.f.close(); }
});

test("N8A9: source-DAG 429 preserves confirmed projection, never increments DAG failures, and stops the pass", async () => {
  const w = await world(3);
  try {
    const c = center(w, (call) => call.resource === "source-dags" ? new Response("nginx", { status: 429 }) : null);
    const before = w.entries();
    await c.pass();
    expect(c.calls.map((x) => x.resource)).toEqual(["projections", "source-dags"]);
    const e = w.entries()[w.ids[0]!]!;
    expect(e.watermark).toBeGreaterThan(0);
    expect(e).toMatchObject({ failures: 0, nextAttemptAt: 0, lastError: "中心限流" });
    expect(e.dagError).toBeUndefined();
    expect(e.dagVersion).toBeUndefined();
    for (const id of w.ids.slice(1)) expect(w.entries()[id]).toEqual(before[id]);
    expect(transport.sharedLedgerNotBefore("https://center.example/", w.dir)).toBe(w.now() + 5000);
  } finally { await w.f.close(); }
});

test("N8A9: 409 snapshot retry is also paced; injected cap and spacing apply to actual sends", async () => {
  const w = await world(5);
  try {
    await updateSharedLedgerMirrors(w.dir, (entries) => { for (const e of Object.values(entries)) e.snapshot = false; });
    const c = center(w, (_call, n) => n === 1 ? Response.json({ error: "conflict" }, { status: 409 }) : null);
    await runSharedLedgerMirrorPass({ ...w.deps, fetch: c.fetcher, maxFeatures: 2, requestGapMs: 700 });
    expect(new Set(c.calls.map((x) => x.feature)).size).toBe(2);
    expect(c.calls.map((x) => x.resource)).toEqual(["projections", "projections", "source-dags", "projections", "source-dags"]);
    for (let i = 1; i < c.calls.length; i++) expect(c.calls[i]!.at - c.calls[i - 1]!.at).toBe(700);
  } finally { await w.f.close(); }
});

test.each(["500", "network"])("N8A9: %s preserves old failures, backoff and all watermark fields exactly", async (failure) => {
  const w = await world(1);
  try {
    await updateSharedLedgerMirrors(w.dir, (entries) => { entries[w.ids[0]!]!.failures = 2; });
    const prior = w.entries()[w.ids[0]!]!;
    const c = center(w, () => { if (failure === "network") throw new Error("private socket text"); return new Response("private body", { status: 500 }); });
    await c.pass();
    expect(w.entries()[w.ids[0]!]!).toEqual({ ...prior, failures: 3, lastError: "center unavailable; outcome unconfirmed",
      lastErrorAt: w.now(), nextAttemptAt: w.now() + 40_000 });
    expect(c.calls).toHaveLength(1);
  } finally { await w.f.close(); }
});

test.each([null, "3", "600", "-1", "bad", "", "Thu, 01 Jan 1970 00:01:43 GMT"])("N8A9: Retry-After %s is safely parsed without retaining nginx body", async (header) => {
  const w = await world(1);
  try {
    const c = center(w, () => new Response("secret body", { status: 429, headers: header === null ? {} : { "Retry-After": header } }));
    const e = w.entries()[w.ids[0]!]!, credential = resolveMirrorCredential(e, w.dir)!;
    const client = new SharedLedgerClient(credential, instanceKeySync(w.dir)!, { fetch: c.fetcher, now: w.now, stateDir: w.dir, scrub: SCRUB });
    const upload: SourceDagUpload = { schemaVersion: 1, projectId: e.projectId, featureId: e.centerFeatureId, sourceInstanceId: e.sourceInstanceId,
      dag: { version: 1, reason: "Work", nodes: [], bindings: [] } };
    let error: unknown;
    try { await client.sourceDag(upload); } catch (e) { error = e; }
    const ms = header === "3" || header?.includes("GMT") ? 3000 : header === "600" ? 60_000 : 5000;
    expect(error).toBeInstanceOf(SharedLedgerRemoteError);
    expect(error).toMatchObject({ status: 429, response: null, retryAfterMs: ms });
    expect(JSON.stringify(error)).not.toContain("secret");
    expect(transport.sharedLedgerNotBefore(credential.baseUrl, w.dir)).toBe(w.now() + ms);
  } finally { await w.f.close(); }
});
