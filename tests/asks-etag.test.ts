/**
 * SYN-2：GET /api/v1/asks 的条件请求和默认窗口——没变回 304；有新卡、状态变了一定 200 拿新内容；
 * 已结案的默认只给 24 小时内的，?history=1 给 3 天；guest 的可见范围不变。库是临时的。
 */
import { afterEach, beforeEach, expect, test } from "bun:test";
import { setAsksForTest } from "../src/bridge/asks.js";
import { handleAsksApi } from "../src/bridge/local-api/asks.js";
import type { Envelope } from "../src/bridge/router.js";
import { closeAsk, openAsk, type NewAsk } from "../src/lib/ledger-asks.js";
import { closeLedger, openLedger } from "../src/lib/ledger-store.js";
import type { RegistryAgent } from "../src/lib/registry.js";
import { guest, owner } from "./asks-test-kit.js";
import { tempLedgerPath } from "./ledger-test-helpers.js";

let path = "";
beforeEach(() => {
  path = tempLedgerPath("asks-etag-");
  openLedger(path);
  const registry = [{ name: "agent-x", channelId: "111", status: "active", projectId: "p" } as RegistryAgent];
  const deps = { clients: new Map(), controlChannelId: "999", deliver: async (env: Envelope) => ({ envelope: env, outcome: { kind: "sent" as const } }), hold: () => {} };
  setAsksForTest({ path, registry, ownerChats: ["api:owner:self"], deps });
});
afterEach(() => {
  setAsksForTest(undefined);
  closeLedger(path);
});

const base: NewAsk = { project: "p", fromAgent: "agent-x", fromChannelId: "111", source: "reply", kind: "decide", title: "发吗", body: "发吗？" };
const get = async (p: string, etag?: string | null, who = owner()) => {
  const r = (await handleAsksApi(new Request(`http://x/api/v1${p}`, { headers: etag ? { "If-None-Match": etag } : {} }), p.split("?")[0], who))!;
  return { status: r.status, etag: r.headers.get("etag"), text: await r.text() };
};
const ids = (text: string) => (JSON.parse(text) as { asks: { id: string }[] }).asks.map((a) => a.id).sort();

test("没变回 304 不带正文；新开一张、状态变了都回 200 + 新 ETag", async () => {
  const a = openAsk(openLedger(path), base);
  const first = await get("/asks");
  expect(first.status).toBe(200);
  expect(ids(first.text)).toEqual([a.id]);
  const same = await get("/asks", first.etag);
  expect(same).toMatchObject({ status: 304, text: "" });
  const b = openAsk(openLedger(path), { ...base, title: "第二张" });
  const added = await get("/asks", first.etag);
  expect(added.status).toBe(200);
  expect(ids(added.text)).toEqual([a.id, b.id].sort());
  closeAsk(openLedger(path), a.id, "cancelled");
  const changed = await get("/asks", added.etag);
  expect(changed.status).toBe(200);
  expect(changed.etag).not.toBe(added.etag);
});

test("已结案的默认只给 24 小时内的，?history=1 才给 3 天内的；开着的不管多老都给", async () => {
  const db = openLedger(path);
  const now = Date.now();
  const old = openAsk(db, { ...base, title: "老的开着" });
  const recent = openAsk(db, { ...base, title: "刚结案" });
  const twoDays = openAsk(db, { ...base, title: "两天前结案" });
  const fourDays = openAsk(db, { ...base, title: "四天前结案" });
  closeAsk(db, recent.id, "cancelled", "", now - 3600_000);
  closeAsk(db, twoDays.id, "cancelled", "", now - 2 * 86400_000);
  closeAsk(db, fourDays.id, "cancelled", "", now - 4 * 86400_000);
  expect(ids((await get("/asks")).text)).toEqual([old.id, recent.id].sort());
  expect(ids((await get("/asks?history=1")).text)).toEqual([old.id, recent.id, twoDays.id].sort());
});

test("guest 照旧只拿到指给自己的，304 也不越权（不同凭据各自的 ETag）", async () => {
  openAsk(openLedger(path), base);
  const mine = openAsk(openLedger(path), { ...base, title: "给 guest", assignee: "local:guest:aa11" });
  const g = await get("/asks", null, guest("aa11"));
  expect(g.status).toBe(200);
  expect(ids(g.text)).toEqual([mine.id]);
  const o = await get("/asks", g.etag);
  expect(o.status).toBe(200); // owner 的列表不同，拿 guest 的 ETag 也得到完整正文
  expect(ids(o.text).length).toBe(2);
});
