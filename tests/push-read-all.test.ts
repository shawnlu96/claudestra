import { afterEach, expect, test } from "bun:test";
import { createPushRoutes } from "../src/bridge/push/routes";
import { createDispatcher } from "../src/bridge/push/dispatcher";
import { bumpUnread, markAllRead, onAgentRead, type ReadEvent } from "../src/lib/unread-store";
import { openWebState, closeWebState } from "../src/lib/web-state";
import { saveApnsDevice, savePushSubscription } from "../src/lib/push-store";
import type { PushSender } from "../src/bridge/push/sender";
import type { Principal } from "../src/lib/principals";
import { runInNewContext } from "node:vm";

const owner: Principal = { id: "owner:self", role: "owner", agents: ["*", "master"], createdAt: "" };
const sender: PushSender = {
  config: () => ({ mode: "direct", apns: true, webPush: null }), webPushKeys: () => [],
  sendWebPush: async () => ({ ok: true, gone: false }), sendApns: async () => ({ ok: true, gone: false }),
};
afterEach(() => closeWebState(":memory:"));
const tables = (db: ReturnType<typeof openWebState>) => [db.query("SELECT * FROM agent_unread").all(), db.query("SELECT * FROM push_read").all()];

test("[验收线 1] atomic all-read moves every watermark forward and emits one event, including zero unread", async () => {
  const db = openWebState(":memory:");
  bumpUnread(db, "a", 1); bumpUnread(db, "a", 2); bumpUnread(db, "archived", 3);
  db.query("INSERT INTO push_read VALUES ('ahead', 9000), ('a', 50)").run();
  const events: ReadEvent[] = [];
  const off = onAgentRead((e) => events.push(e));
  try {
    expect(markAllRead(db, 100)).toBe(2);
    expect(db.query("SELECT agent, ts FROM push_read ORDER BY agent").all()).toEqual([
      { agent: "a", ts: 100 }, { agent: "ahead", ts: 9000 }, { agent: "archived", ts: 100 },
    ]);
    expect(db.query("SELECT count FROM agent_unread").all()).toEqual([{ count: 0 }, { count: 0 }]);
    expect(events).toEqual([{ agent: "", ts: 100, hadUnread: true, all: true }]);
    expect(markAllRead(db, 200)).toBe(0);
    expect(events[1]).toEqual({ agent: "", ts: 200, hadUnread: false, all: true });
  } finally { off(); }
});

test("[验收线 1] route owns read-all; guest, partial and peer leave both tables untouched", async () => {
  const db = openWebState(":memory:");
  bumpUnread(db, "a", 1);
  const h = createPushRoutes({ db, sender, liveAgents: async () => ["a"] });
  const url = new URL("http://bridge/api/v1/agents/read-all");
  const before = tables(db);
  for (const p of [
    { ...owner, role: "external", id: "guest:1", agents: ["a"], credential: "dev" },
    { ...owner, agents: ["a"], manage: false }, { ...owner, peer: "peer" },
  ] as Principal[]) {
    expect((await h(new Request(url.toString(), { method: "POST" }), url, p))?.status).toBe(403);
    expect(tables(db)).toEqual(before);
  }
  const res = await h(new Request(url.toString(), { method: "POST" }), url, owner);
  expect(await res?.json()).toEqual({ ok: true, cleared: 1 });
  expect(db.query("SELECT ts FROM push_read WHERE agent='a'").get()).toMatchObject({ ts: expect.any(Number) });
});

test("[验收线 1] one silent APNs per device and one dismiss per safe owner subscription, even when zero", async () => {
  const db = openWebState(":memory:");
  for (const token of ["a", "b"]) saveApnsDevice(db, token.repeat(64), "phone", new Date(), { audience: "owner", principal: owner.id });
  for (const [id, ua, audience] of [["mac", "Macintosh", "owner"], ["old", "Windows", "owner"], ["ios", "iPhone", "owner"], ["guest", "Macintosh", "guest"]] as const) {
    savePushSubscription(db, { endpoint: `https://push.example/${id}`, keys: { p256dh: "p", auth: "a" } }, ua, null, new Date(), { audience, principal: owner.id });
  }
  const sent: Array<{ kind: string; to: string; body: Record<string, unknown> }> = [];
  let hideContent = false;
  const d = createDispatcher({ db, fp: "here", noContent: () => hideContent, isOwnerChat: () => true, resolvePrincipal: () => owner,
    sender: { ...sender,
      sendWebPush: async (s, p) => { sent.push({ kind: "web", to: s.endpoint, body: JSON.parse(p) }); return { ok: true, gone: false }; },
      sendApns: async (t, p) => { sent.push({ kind: "apns", to: t, body: { ...p } }); return { ok: true, gone: false }; },
    },
  });
  try {
    for (const counts of [true, false]) {
      if (counts) { bumpUnread(db, "a", 1); bumpUnread(db, "b", 2); }
      sent.length = 0;
      hideContent = !counts;
      markAllRead(db, 100);
      await new Promise((r) => setTimeout(r, 10));
      expect(sent).toHaveLength(4);
      expect(sent.filter((s) => s.kind === "web").map((s) => s.body)).toEqual([
        { fp: "here", type: "dismiss", all: true, ts: 100, badge: 0 },
        { fp: "here", type: "dismiss", all: true, ts: 100, badge: 0 },
      ]);
      for (const s of sent.filter((s) => s.kind === "apns")) expect(s.body).toMatchObject({ silent: true, badge: 0, agent: "", tag: "cstra-badge-100" });
    }
  } finally { d.stop(); }
});

async function dismissed(source: string, payload: Record<string, unknown>) {
  const handlers: Record<string, (e: unknown) => void> = {};
  const closed: number[] = [];
  const data = [
    { agent: "a", fp: "here", ts: 10 }, { agent: "b", fp: "here", ts: 20 },
    { agent: "a", fp: "away", ts: 10 }, { agent: "a", fp: "here", ts: 30 },
  ];
  runInNewContext(source, { self: { addEventListener: (n: string, fn: (e: unknown) => void) => { handlers[n] = fn; },
    registration: { getNotifications: async () => data.map((d, i) => ({ data: d, close: () => closed.push(i) })) } }, URL, Date });
  let done: Promise<unknown> = Promise.resolve();
  handlers.push({ data: { json: () => payload }, waitUntil: (p: Promise<unknown>) => { done = p; } });
  await done;
  return closed;
}

test("[验收线 5] all dismiss respects fp/time; ordinary dismiss exactly matches baseline", async () => {
  const source = await Bun.file("web/public/sw.js").text();
  const p = Bun.spawn(["git", "show", "65161e2:web/public/sw.js"], { stdout: "pipe" });
  const baseline = await new Response(p.stdout).text();
  expect(await p.exited).toBe(0);
  const all = { type: "dismiss", all: true, fp: "here", ts: 20 };
  expect(await dismissed(baseline, all)).toEqual([]);
  expect(await dismissed(source, all)).toEqual([0, 1]);
  const one = { type: "dismiss", agent: "a", fp: "here", ts: 20 };
  expect(await dismissed(source, one)).toEqual(await dismissed(baseline, one));
  expect(await dismissed(source, one)).toEqual([0]);
});

test("[验收线 1] failed transaction changes neither table and never notifies", () => {
  const db = openWebState(":memory:");
  bumpUnread(db, "a", 1);
  db.query("INSERT INTO push_read VALUES ('a', 5)").run();
  db.exec("CREATE TRIGGER refuse_clear BEFORE UPDATE ON agent_unread BEGIN SELECT RAISE(ABORT, 'test failure'); END");
  const before = tables(db), seen: ReadEvent[] = [];
  const off = onAgentRead((e) => seen.push(e));
  try {
    expect(() => markAllRead(db, 100)).toThrow("test failure");
    expect(tables(db)).toEqual(before); expect(seen).toEqual([]);
  } finally { off(); }
});

test("[验收线 1] baseline read-all is not a push route and leaves tables untouched", async () => {
  const p = Bun.spawn(["git", "show", "65161e2:src/bridge/push/routes.ts"], { stdout: "pipe" });
  const source = await new Response(p.stdout).text();
  expect(await p.exited).toBe(0);
  const result = await Bun.build({ entrypoints: ["src/bridge/push/routes.ts"], target: "bun", plugins: [{
    name: "baseline-route", setup(build) {
      build.onLoad({ filter: /\/push\/routes\.ts$/ }, () => ({ contents: source, loader: "ts" }));
    },
  }] });
  expect(result.success).toBe(true);
  const dir = `${process.cwd()}/node_modules/.cache/pushclr`;
  const target = `${dir}/baseline-routes.mjs`;
  await Bun.write(target, await result.outputs[0].text());
  const { createPushRoutes: oldRoutes } = await import(target) as { createPushRoutes: typeof createPushRoutes };
  const db = openWebState(":memory:");
  bumpUnread(db, "a", 1);
  const before = tables(db), url = new URL("http://bridge/api/v1/agents/read-all");
  const h = oldRoutes({ db, sender, liveAgents: async () => ["a"] });
  expect(await h(new Request(url.toString(), { method: "POST" }), url, owner)).toBeNull();
  expect(tables(db)).toEqual(before);
});
