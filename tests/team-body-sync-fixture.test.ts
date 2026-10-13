/** The on-disk world of the body sync tests: a mirrored feature, a switch, a fake center and its recorded requests. No tests here. */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { appendEvent, setMeta } from "../src/lib/ledger-write.js";
import { listEvents } from "../src/lib/ledger-store.js";
import { runSharedLedgerMirrorPass, type MirrorLoopDeps } from "../src/lib/shared-ledger-mirror-loop.js";
import { updateSharedLedgerMirrors } from "../src/lib/shared-ledger-mirror.js";
import { writeSharedLedgerMode } from "../src/lib/shared-ledger-mode.js";
import type { SharedLedgerProjection } from "../src/lib/shared-ledger-contract.js";
import type { MirrorClient } from "../src/lib/shared-ledger-projector.js";
import { parseTeamBodyUpload, type TeamBodyUpload } from "../src/lib/shared-ledger-contract-team-body.js";
import { integrationFixture } from "./shared-ledger-integration-fixture.test.js";
import { mirrorEntry, SCRUB, serviceCredential } from "./shared-ledger-mirror-fixture.test.js";

/** Text that trips the gate in more paragraph splits than the bounded search resolves: refused (team-body-scrub.test.ts). */
export const KNOWN = { ...SCRUB, knownSecrets: ["alpha line\n\nbeta line"] };
export const REFUSED = Array.from({ length: 6 }, (_, i) => `note ${i}.\n\nalpha line\n\nbeta line`).join("\n\n");

export async function world(mode: "on" | "observe" | "off") {
  const f = integrationFixture(), dir = f.startEnv.ledgerDir;
  await serviceCredential(dir);
  await writeSharedLedgerMode(f.id, { authorityMode: "source", sharedPlanning: true, mirror: true }, dir, f.db.filename);
  await updateSharedLedgerMirrors(dir, (entries) => { entries[f.id] = mirrorEntry(f, 0, { snapshot: true }); });
  const policy = (m: "on" | "observe" | "off") => writeFileSync(join(dir, "recovery-policy.json"), JSON.stringify({ projects: { [f.project]: { keys: { teamBody: m } } } }));
  policy(mode);
  const docs = join(dir, "docs");
  mkdirSync(join(docs, "tasks"), { recursive: true });
  setMeta(f.db, { actor: "owner" }, { project: f.project, key: "docsDir", value: docs });
  let t = 1_000_000;
  const projections: SharedLedgerProjection[] = [];
  const projector: MirrorClient = { async projection(p) {
    projections.push(p);
    return { schemaVersion: 1, serverSeq: projections.length, sourceInstanceId: p.sourceInstanceId, sourceSeq: p.sourceSeq, digest: "b".repeat(64) };
  } };
  const requests: { method: string; path: string; upload?: TeamBodyUpload; bodyBytes?: number }[] = [];
  let onCapability = () => {};
  let capability: () => Response = () => Response.json({ schemaVersion: 1, teamId: "team-a", teamBody: true });
  /** Answers an upload instead of the center; null lets that one through. */
  let failUploads: ((upload: TeamBodyUpload) => Response | null) | null = null;
  const fetcher = (async (url: URL, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    if (method === "GET") { requests.push({ method, path: url.pathname }); onCapability(); return capability(); }
    const upload = parseTeamBodyUpload(JSON.parse(String(init?.body)).payload);
    requests.push({ method, path: url.pathname, upload, bodyBytes: Buffer.byteLength(String(init?.body), "utf8") });
    const failed = failUploads?.(upload);
    if (failed) return failed;
    return Response.json({ schemaVersion: 1, batchId: upload.batchId, results: upload.records.map((r) => ({
      taskId: r.taskId, kind: r.kind, sourceKey: r.sourceKey, status: "stored", code: null })) });
  }) as unknown as typeof fetch;
  let onScrub = () => {};
  const deps = (scrub = SCRUB): MirrorLoopDeps => ({ stateDir: dir, ledgerPath: f.db.filename, now: () => t, requestGapMs: 0,
    sleep: async () => {}, fetch: fetcher, client: () => projector, scrub: async () => { onScrub(); return scrub; } });
  const note = (text: string, target = "c5-existing") => appendEvent(f.db, { actor: f.actor }, { project: f.project, target, kind: "note", text }).event.seq;
  const uploads = () => requests.filter((r) => r.method === "POST").map((r) => r.upload!);
  const observed = () => listEvents(f.db, { project: f.project }).filter((e) => e.data.op === "recovery-observe" || e.data.mechanism === "teamBody");
  return { f, dir, docs, deps, note, requests, uploads, observed, projections, policy,
    pass: (scrub = SCRUB) => runSharedLedgerMirrorPass(deps(scrub)),
    advance: (ms: number) => { t += ms; }, now: () => t,
    failing: (on: boolean | ((upload: TeamBodyUpload) => Response | null)) => {
      failUploads = on === true ? () => new Response("down", { status: 503 }) : on || null;
    },
    setCapability: (c: () => Response) => { capability = c; },
    onCapability: (hook: () => void) => { onCapability = hook; }, onScrub: (hook: () => void) => { onScrub = hook; } };
}
