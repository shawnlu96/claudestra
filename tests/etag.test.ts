/** SYN-2：列表接口条件请求（src/lib/etag.ts）——没变回 304 不带正文，内容任何变化 ETag 都变，volatile 字段不进哈希 */
import { expect, test } from "bun:test";
import { conditionalJson, etagMatches, etagOf } from "../src/lib/etag.ts";

test("同样的正文 ETag 相同，任何字段变了就不同", () => {
  const a = etagOf(JSON.stringify({ ok: true, asks: [{ id: "a", state: "open" }] }));
  expect(etagOf(JSON.stringify({ ok: true, asks: [{ id: "a", state: "open" }] }))).toBe(a);
  expect(etagOf(JSON.stringify({ ok: true, asks: [{ id: "a", state: "answered" }] }))).not.toBe(a);
  expect(a.startsWith('W/"')).toBe(true);
});

test("If-None-Match：弱比较、多个值、* 都认；空 / 不对的不认", () => {
  const e = etagOf("x");
  expect(etagMatches(e, e)).toBe(true);
  expect(etagMatches(e.replace(/^W\//, ""), e)).toBe(true);
  expect(etagMatches(`W/"other", ${e}`, e)).toBe(true);
  expect(etagMatches("*", e)).toBe(true);
  expect(etagMatches(null, e)).toBe(false);
  expect(etagMatches('W/"other"', e)).toBe(false);
});

test("conditionalJson：首拉 200 带 ETag；带上它再拉 304 无正文；正文变了 200 + 新 ETag", async () => {
  const first = conditionalJson(null, { ok: true, agents: [1] });
  expect(first.status).toBe(200);
  const etag = first.headers.get("etag")!;
  expect(await first.json()).toEqual({ ok: true, agents: [1] });
  const same = conditionalJson(etag, { ok: true, agents: [1] });
  expect(same.status).toBe(304);
  expect(await same.text()).toBe("");
  expect(same.headers.get("etag")).toBe(etag);
  const changed = conditionalJson(etag, { ok: true, agents: [1, 2] });
  expect(changed.status).toBe(200);
  expect(changed.headers.get("etag")).not.toBe(etag);
});

test("volatile 字段（/asks 的 now）不进 ETag，但照常在 200 正文里", async () => {
  const r1 = conditionalJson(null, { ok: true, asks: [], now: 1 }, ["now"]);
  const r2 = conditionalJson(r1.headers.get("etag"), { ok: true, asks: [], now: 2 }, ["now"]);
  expect(r2.status).toBe(304);
  const r3 = conditionalJson(null, { ok: true, asks: [], now: 3 }, ["now"]);
  expect(await r3.json()).toMatchObject({ now: 3 });
});
