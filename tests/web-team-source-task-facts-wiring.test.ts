import { afterEach, expect, spyOn, test } from "bun:test";
import { sharedCollabSource } from "@/features/collab/team-source-shared";
import { generateTeamFixture } from "@/features/collab/shared/team-fixture-gen";
import { SharedLedgerSession, sharedLedgerTransport } from "@/lib/api/shared-ledger";
import { setAppConfigForTest } from "@/lib/app-config";
import { teamTaskFacts } from "@/features/collab/team-source-task-facts";

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; setAppConfigForTest(null); });
const flush = () => Bun.sleep(10);

function world(status: number) {
  const fx = generateTeamFixture({ features: 2 });
  const calls: string[] = [];
  let seq = 0;
  setAppConfigForTest({ mode: "direct", fp: "local", machineName: "fixture", version: "" });
  globalThis.fetch = (async (input: string | URL | Request) => {
    const path = String(input);
    calls.push(path);
    if (path.endsWith("/task-facts")) return new Response("unsupported", { status });
    if (path.endsWith("/features")) return Response.json({ ...fx.list, serverSeq: ++seq,
      features: fx.list.features.map(f => ({ ...f, rev: seq })) });
    const id = path.split("/").at(-1);
    const d = fx.details.find(d => d.feature.id === id);
    if (d) return Response.json(d);
    throw new Error(`unexpected request ${path}`);
  }) as typeof fetch;
  const session = new SharedLedgerSession({ center: "c", team: fx.team, person: "p", project: fx.project, machine: "local" }, sharedLedgerTransport());
  const src = sharedCollabSource(session, "team", "fixture");
  return { fx, src, calls, round: () => src.overview(new AbortController().signal) };
}

test("[验收线 2] no focus sends no task-facts; facts 429 does not block next detail round or mutate last()", async () => {
  const w = world(429), warn = spyOn(console, "warn").mockImplementation(() => {});
  try {
    await w.round(); await w.src.dag!.board("team"); await flush();
    expect(w.calls.filter(c => c.endsWith("/task-facts"))).toEqual([]);
    const before = w.src.last()!;
    w.src.focus(w.fx.details[0]!.feature.id); await flush();
    expect(w.calls.filter(c => c.endsWith("/task-facts"))).toHaveLength(1);
    const detailCount = w.calls.filter(c => w.fx.details.some(d => c.endsWith(`/${d.feature.id}`))).length;
    await w.round();
    expect(w.calls.filter(c => w.fx.details.some(d => c.endsWith(`/${d.feature.id}`))).length).toBeGreaterThan(detailCount);
    expect(w.src.last()!.details).toEqual(before.details);
    expect(w.src.last()!.failed.size).toBe(0);
    expect(w.calls.some(c => /ext-capabilities|\/activity|\/versions/.test(c))).toBe(false);
  } finally { warn.mockRestore(); }
});

test("[验收线 4] old center 404 is silent and board JSON remains identical", async () => {
  const w = world(404), warn = spyOn(console, "warn").mockImplementation(() => {});
  try {
    await w.round();
    const before = JSON.stringify(await w.src.dag!.board("team"));
    w.src.focus(w.fx.details[0]!.feature.id); await flush();
    expect(JSON.stringify(await w.src.dag!.board("team"))).toBe(before);
    w.src.focus(w.fx.details[0]!.feature.id); await flush();
    expect(w.calls.filter(c => c.endsWith("/task-facts"))).toHaveLength(1);
    expect(warn).not.toHaveBeenCalled();
  } finally { warn.mockRestore(); }
});

test("[验收线 2] detail 429 does not prevent facts read and opts.facts injects only that read", async () => {
  const w = world(429), original = globalThis.fetch;
  let facts = 0;
  const warn = spyOn(console, "warn").mockImplementation(() => {});
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    if (w.fx.details.some(d => String(input).endsWith(`/${d.feature.id}`))) return Response.json({ error: "limited" }, { status: 429 });
    return original(input, init);
  }) as typeof fetch;
  try {
    const session = new SharedLedgerSession({ center: "c", team: w.fx.team, person: "p", project: w.fx.project, machine: "local" }, sharedLedgerTransport());
    const src = sharedCollabSource(session, "team", "fixture", undefined, { facts: { taskFacts: async id => {
      facts++;
      return { schemaVersion: 1, teamId: w.fx.team, projectId: w.fx.project, featureId: id, serverSeq: 1, tasks: [] };
    } } });
    await src.overview(new AbortController().signal);
    src.focus(w.fx.details[0]!.feature.id); await flush();
    expect(facts).toBe(1);
    expect(src.last()!.details.size).toBe(0);
  } finally { warn.mockRestore(); }
});

test("[验收线 1] default transport captures current machine and project on each identity's read", async () => {
  const w = world(404), requests: { url: string; project: string | undefined }[] = [];
  setAppConfigForTest({ mode: "relay", relayBase: "fixture.invalid", version: "" });
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    requests.push({ url: String(input), project: (init?.headers as Record<string, string>)["X-Shared-Ledger-Project"] });
    return new Response("no route", { status: 404 });
  }) as typeof fetch;
  const session = new SharedLedgerSession({ center: "c", team: w.fx.team, person: "p", project: "first", machine: "m1" }, sharedLedgerTransport());
  const facts = teamTaskFacts(session, () => {}), id = w.fx.details[0]!.feature.id;
  facts.open(id); await flush();
  session.switchIdentity({ ...session.identity, project: "second", machine: "m2" }, sharedLedgerTransport());
  facts.open(id); await flush();
  expect(requests).toEqual([
    { url: `/m/m1/api/v1/shared-ledger/features/${id}/task-facts`, project: "first" },
    { url: `/m/m2/api/v1/shared-ledger/features/${id}/task-facts`, project: "second" },
  ]);
});
