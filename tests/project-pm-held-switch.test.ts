import { expect, test } from "bun:test";
import { deliverPmLocal } from "../src/bridge/local-api/project-pm-delivery.js";
import { expectPmTarget, shouldRetry } from "../src/bridge/pm-held-transfer.js";
import { switchProjectPm } from "../src/lib/pm-role-switch.js";
import { A, B, P } from "./pm-role-fixture.test.js";
import { CA, CB, inboxWorld, peerRequest, stopA, useInboxWorld } from "./project-pm-held-world.test.js";

useInboxWorld();

// followup-reliability-PMSWR r2 handoff-mixed-turn：交接的 await 窗口里 owner 切 PM，分轮 / claim / 记账和最终收件频道必须是同一个
for (const at of ["working-a", "working-b", "settled-b"] as const) {
  test(`handoff-mixed-turn: PM switched back to A during ${at}; letters follow A's turn rules, one peer per turn`, async () => {
    const w = await inboxWorld();
    w.principal({ id: "token:tok_second", role: "external", peer: "second", agents: [A, B], createdAt: "2026-01-01" });
    peerRequest(w, "first-peer", "tok_peer", "remote");
    peerRequest(w, "second-peer", "tok_second", "second");
    Object.assign(w.opts, { busyOnSend: true, idleRule: true });
    const where = at === "working-a" ? CA : CB;
    let switched = 0;
    w.opts.onProbe = async (c) => {
      if (c !== where) return false;
      // working(B) 只在交接路径里跑；settled(B) 在 B 空闲、mayJoin 看画面时跑——都在核完 B、发送之前
      await switchProjectPm(w.fixture.db, P, A, { actor: "owner" }, w.fixture.deps);
      return !!++switched;
    };
    await w.flush(CA);
    expect(switched).toBe(1);
    expect(w.sent).toEqual([{ channel: CA, text: "first-peer body" }]);
    expect(w.q(CA).map((i) => i.env.meta.messageId)).toEqual(["second-peer"]);
    expect(w.q(CB)).toEqual([]);
    expect(stopA(w, "private first answer")).toEqual([{ peer: "tok_peer", reply: "private first answer" }]);
    w.busy.delete(CA);
    w.restart();
    await w.flush(CA);
    expect(w.sent.map((e) => e.text)).toEqual(["first-peer body", "second-peer body"]);
    expect(stopA(w, "answer to second")).toEqual([{ peer: "tok_second", reply: "answer to second" }]);
    expect([...w.q(CA), ...w.q(CB)]).toEqual([]);
  });
}

test("handoff-mixed-turn: final recipient differs from the PM flush checked → not sent, receipt and queue untouched", async () => {
  const w = await inboxWorld();
  peerRequest(w, "first-peer", "tok_peer", "remote");
  await switchProjectPm(w.fixture.db, P, A, { actor: "owner" }, w.fixture.deps); // 核的是 B，投时当班已是 A
  const item = w.q(CA)[0]!, receipts = JSON.stringify([...w.receipts]);
  expectPmTarget(item.env, CB);
  const r = await deliverPmLocal(item.env, item.to, w.clients as never, w.calls, w.receipts, async (e) => {
    w.sent.push({ channel: "?", text: e.content });
    return { envelope: e, outcome: { kind: "sent" } };
  }, { db: w.fixture.db, agents: (await w.fixture.deps.read()).agents });
  expectPmTarget(item.env, undefined);
  expect(shouldRetry(r)).toBe(true);
  expect(w.sent).toEqual([]);
  expect(JSON.stringify([...w.receipts])).toBe(receipts);
  expect(w.q(CA)).toEqual([item]);
});
