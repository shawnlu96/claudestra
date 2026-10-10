import { expect, test } from "bun:test";
import { sharedCollabSource } from "@/features/collab/team-source-shared";
import { generateTeamFixture } from "@/features/collab/shared/team-fixture-gen";
import { ApiError } from "@/lib/api/client";
import { SharedLedgerSession, type Transport } from "@/lib/api/shared-ledger";

function world(retryAfter?: number) {
  const fx = generateTeamFixture({ features: 3 });
  let t = 100_000, seq = fx.list.serverSeq, lists = 0, details = 0, reject = false;
  const ds = new Map(fx.details.map((d) => [d.feature.id, d]));
  const listTimes: number[] = [];
  const transport: Transport = {
    list: async () => {
      lists++; listTimes.push(t);
      if (reject) throw new ApiError("nginx limited", 429, retryAfter === undefined ? {} : { retryAfter });
      return { ...fx.list, serverSeq: seq };
    },
    detail: async (id) => { details++; return ds.get(id)!; },
    command: async () => { throw new Error("unused"); },
    receipt: async (id) => ({ status: "unknown", requestId: id }),
  };
  const session = new SharedLedgerSession({ center: "c", team: fx.team, project: fx.project, person: "p", machine: "m" }, transport);
  const src = sharedCollabSource(session, "team", "label", 1, { now: () => t });
  return { src, session, listTimes, now: () => t, lists: () => lists, details: () => details,
    read: () => src.overview(new AbortController().signal),
    advance: (ms: number) => { t += ms; seq++; }, reject: (value: boolean) => { reject = value; } };
}

test.each([30, undefined, 600])("N8A9: list 429 Retry-After %s delays overview/poke, preserving the whole list and details", async (retryAfter) => {
  const w = world(retryAfter), delay = retryAfter === undefined ? 5000 : Math.min(60_000, retryAfter * 1000);
  await w.read();
  const previous = w.src.last()!, calls = w.lists(), detailCalls = w.details();
  w.reject(true); w.advance(1);
  await w.read();
  expect(w.lists()).toBe(calls + 1);
  expect(w.src.last()).toBe(previous);
  expect(w.details()).toBe(detailCalls);
  w.reject(false);
  w.advance(delay - 1);
  w.src.poke();
  await w.read();
  await w.read();
  expect(w.lists()).toBe(calls + 1);
  expect(w.src.last()).toBe(previous);
  expect(w.details()).toBe(detailCalls);
  w.advance(1);
  await w.read();
  expect(w.lists()).toBe(calls + 2);
  expect(w.listTimes.at(-1)).toBe(w.listTimes[calls]! + delay);
  expect(w.src.last()!.list.serverSeq).toBeGreaterThan(previous.list.serverSeq);
});

async function until(done: () => boolean) {
  const deadline = Date.now() + 1000;
  while (!done() && Date.now() < deadline) await Bun.sleep(1);
  expect(done()).toBe(true);
}

test("N8A9: follow polling obeys the same list cooldown as overview, retains data and resumes at Retry-After", async () => {
  const w = world(30), ctrl = new AbortController();
  await w.read();
  const previous = w.src.last()!, detailCalls = w.details();
  w.reject(true);
  let events = 0;
  const follow = w.src.follow({ signal: ctrl.signal, onOpen: () => {}, onEvent: () => { events++; } });
  try {
    await until(() => w.lists() === 2);
    const start = w.now();
    w.reject(false); w.advance(29_999);
    await w.read();
    await Bun.sleep(15);
    expect(w.lists()).toBe(2);
    expect(w.details()).toBe(detailCalls);
    expect(w.src.last()).toBe(previous);
    expect(events).toBe(0);
    w.advance(1);
    await until(() => w.lists() > 2);
    expect(w.listTimes[2]).toBe(start + 30_000);
    expect(events).toBeGreaterThan(0);
    await w.read();
    expect(w.src.last()!.list.serverSeq).toBeGreaterThan(previous.list.serverSeq);
  } finally { ctrl.abort(); await follow; }
});

test("N8A9: poll and initial overview coalesce an in-flight list request", async () => {
  const fx = generateTeamFixture({ features: 1 });
  let release!: () => void, calls = 0;
  const pending = new Promise<void>((resolve) => { release = resolve; });
  const session = new SharedLedgerSession({ center: "c", team: fx.team, project: fx.project, person: "p", machine: "m" }, {
    list: async () => { calls++; await pending; return fx.list; },
    detail: async () => fx.details[0]!,
    command: async () => { throw new Error("unused"); }, receipt: async (id) => ({ status: "unknown", requestId: id }),
  });
  const source = sharedCollabSource(session, "team", "label", 1), ctrl = new AbortController();
  const overview = source.overview(ctrl.signal);
  const follow = source.follow({ signal: ctrl.signal, onOpen: () => {}, onEvent: () => {} });
  try {
    await Bun.sleep(15);
    expect(calls).toBe(1);
    ctrl.abort(); release();
    await overview.catch((error: unknown) => { expect((error as Error).name).toBe("AbortError"); });
  } finally { ctrl.abort(); release(); await follow; }
});
