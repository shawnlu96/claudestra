/**
 * CBUDGET2: the team view polls the center feature list every 15 seconds and not at all while the page is hidden;
 * back to the foreground it reads once right away, then on the poll interval again. An opened feature detail still
 * loads right away (focus → poke), hidden or not.
 * The page visibility is a minimal stand-in document (hidden + visibilitychange), removed after each test.
 */
import { afterEach, expect, test } from "bun:test";
import { DETAIL_BEHIND_MS, DETAIL_REFRESH_MS, POLL_MS, sharedCollabSource } from "@/features/collab/team-source-shared";
import { generateTeamFixture } from "@/features/collab/shared/team-fixture-gen";
import { SharedLedgerSession, type Transport } from "@/lib/api/shared-ledger";

class FakeDocument extends EventTarget {
  hidden = false;
  set(hidden: boolean) { this.hidden = hidden; this.dispatchEvent(new Event("visibilitychange")); }
}
const g = globalThis as { document?: unknown };
const original = Object.getOwnPropertyDescriptor(g, "document");
afterEach(() => { if (original) Object.defineProperty(g, "document", original); else delete g.document; });
function page(): FakeDocument {
  const doc = new FakeDocument();
  Object.defineProperty(g, "document", { value: doc, configurable: true, writable: true });
  return doc;
}

function world(pollMs: number, failFirst?: string) {
  const fx = generateTeamFixture({ features: 3 });
  const ds = new Map(fx.details.map((d) => [d.feature.id, d]));
  const listTimes: number[] = [], detailIds: string[] = [];
  let failing = failFirst;
  const transport: Transport = {
    list: async () => { listTimes.push(Date.now()); return fx.list; },
    detail: async (id) => {
      detailIds.push(id);
      if (id === failing) { failing = undefined; throw new Error("first read fails"); }
      return ds.get(id)!;
    },
    command: async () => { throw new Error("unused"); },
    receipt: async (id) => ({ status: "unknown", requestId: id }),
  };
  const session = new SharedLedgerSession({ center: "c", team: fx.team, project: fx.project, person: "p", machine: "m" }, transport);
  const src = sharedCollabSource(session, "team", "label", pollMs);
  return { fx, src, listTimes, detailIds, read: () => src.overview(new AbortController().signal) };
}

async function until(done: () => boolean, ms = 1000) {
  const deadline = Date.now() + ms;
  while (!done() && Date.now() < deadline) await Bun.sleep(1);
  expect(done()).toBe(true);
}

test("[验收线 4] the list poll interval is 15 seconds; the behind-list threshold follows it", () => {
  expect(POLL_MS).toBe(15_000);
  expect(DETAIL_BEHIND_MS).toBe(DETAIL_REFRESH_MS + 15_000);
});

test("[验收线 4] hidden page: 0 list requests for 4+ intervals; visible again → 1 right away, then on the interval", async () => {
  const doc = page(), w = world(40), ctrl = new AbortController();
  await w.read();
  const base = w.listTimes.length;
  doc.set(true);
  const follow = w.src.follow({ signal: ctrl.signal, onOpen: () => {}, onEvent: () => {} });
  try {
    await Bun.sleep(200); // 5 poll intervals hidden (60s at 15s)
    expect(w.listTimes.length).toBe(base);
    const shown = Date.now();
    doc.set(false);
    await until(() => w.listTimes.length === base + 1, 30);
    expect(w.listTimes[base]! - shown).toBeLessThan(30);
    await until(() => w.listTimes.length === base + 2, 500);
    expect(w.listTimes[base + 1]! - w.listTimes[base]!).toBeGreaterThanOrEqual(35);
  } finally { ctrl.abort(); await follow; }
});

test("[验收线 4] hidden for less than an interval: back to the foreground reads at once instead of waiting the rest", async () => {
  const doc = page(), w = world(400), ctrl = new AbortController();
  await w.read();
  const base = w.listTimes.length;
  const follow = w.src.follow({ signal: ctrl.signal, onOpen: () => {}, onEvent: () => {} });
  try {
    await Bun.sleep(20);
    doc.set(true);
    await Bun.sleep(20);
    doc.set(false);
    await until(() => w.listTimes.length === base + 1, 100);
  } finally { ctrl.abort(); await follow; }
});

test("[验收线 4] visible page keeps polling on the interval; abort while hidden ends follow", async () => {
  const doc = page(), w = world(20), ctrl = new AbortController();
  await w.read();
  const base = w.listTimes.length;
  const follow = w.src.follow({ signal: ctrl.signal, onOpen: () => {}, onEvent: () => {} });
  await until(() => w.listTimes.length >= base + 2, 500);
  doc.set(true);
  await Bun.sleep(30);
  const held = w.listTimes.length;
  ctrl.abort();
  await follow;
  expect(w.listTimes.length).toBe(held);
});

test("[验收线 4] opened feature detail still loads right away while the page is hidden", async () => {
  const doc = page(), fxId = generateTeamFixture({ features: 3 }).details[1]!.feature.id;
  const w = world(15_000, fxId), ctrl = new AbortController();
  const original = console.warn;
  console.warn = () => {};
  try {
    await w.read();
    expect(w.src.last()!.details.has(fxId)).toBe(false);
    doc.set(true);
    let events = 0;
    const follow = w.src.follow({ signal: ctrl.signal, onOpen: () => {}, onEvent: () => { events++; } });
    w.src.focus(fxId);
    expect(events).toBe(1);
    const before = w.detailIds.length;
    await w.read();
    expect(w.detailIds[before]).toBe(fxId);
    expect(w.src.last()!.details.has(fxId)).toBe(true);
    ctrl.abort();
    await follow;
  } finally { console.warn = original; }
});
