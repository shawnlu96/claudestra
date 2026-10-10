import { testChildEnv } from "./test-env.ts";
import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  attachPendingOfferAsk, claimPendingOffer, listPendingOfferIds, readPendingOffer, savePendingOffer, type PendingJoinOffer,
} from "../src/lib/shared-ledger-join-offer.js";

const offer = (n: number): PendingJoinOffer => ({
  offerId: n.toString(16).padStart(32, "0"), peer: "fixture", url: "https://center.example/", host: "center.example",
  centerId: `center-${"a".repeat(32)}`, code: `sljoin1.center-${"a".repeat(32)}.${"b".repeat(32)}.${"M".repeat(43)}`,
  receivedAt: Date.now(), expiresAt: Date.now() + 60_000,
});

test("concurrent pending arrivals respect the cap, even a replacement cannot insert past it", async () => {
  const dir = mkdtempSync(join(tmpdir(), "offer-cap-"));
  try {
    const results = await Promise.all(Array.from({ length: 51 }, (_, n) => savePendingOffer(dir, offer(n))));
    expect(results.filter(r => r === "ok")).toHaveLength(50);
    expect(results.filter(r => r === "full")).toHaveLength(1);
    expect(await savePendingOffer(dir, offer(51), { replace: true })).toBe("full");
    expect(await savePendingOffer(dir, offer(0))).toBe("exists");
    expect(await savePendingOffer(dir, offer(0), { replace: true })).toBe("ok");
    expect(readdirSync(dir)).toEqual([]);
    for (const id of listPendingOfferIds(dir)) claimPendingOffer(dir, id);
    expect(listPendingOfferIds(dir)).toEqual([]);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("store copies isolate mutations and state directories; ask attachment cannot revive a claim", async () => {
  const dir = mkdtempSync(join(tmpdir(), "offer-claim-"));
  try {
    const p = offer(0), original = p.code;
    await savePendingOffer(dir, p);
    p.code = "mutated";
    const read = readPendingOffer(dir, p.offerId)!;
    expect(read.code).toBe(original);
    read.code = "mutated again";
    expect(readPendingOffer(dir, p.offerId)!.code).toBe(original);
    expect(readPendingOffer(`${dir}/other`, p.offerId)).toBeNull();
    attachPendingOfferAsk(dir, p.offerId, "ask_fixture");
    expect(claimPendingOffer(dir, p.offerId)!.askId).toBe("ask_fixture");
    attachPendingOfferAsk(dir, p.offerId, "ask_late");
    expect(claimPendingOffer(dir, p.offerId)).toBeNull();
    expect(readdirSync(dir)).toEqual([]);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("a fresh process cannot recover the invitation secret from the same state directory", async () => {
  const root = mkdtempSync(join(tmpdir(), "offer-restart-")), dir = join(root, "state"), home = join(root, "home");
  mkdirSync(dir); mkdirSync(home);
  try {
    const script = `
      import assert from "node:assert/strict";
      import { readdirSync } from "node:fs";
      import { savePendingOffer, listPendingOfferIds } from "./src/lib/shared-ledger-join-offer.ts";
      const dir = process.env.CLAUDESTRA_STATE_DIR;
      if (process.env.OFFER_FIRST === "1") {
        await savePendingOffer(dir, ${JSON.stringify(offer(0))});
        assert.equal(listPendingOfferIds(dir).length, 1);
      } else assert.deepEqual(listPendingOfferIds(dir), []);
      assert.deepEqual(readdirSync(dir), []);
    `;
    for (const first of ["1", "0"]) {
      const p = Bun.spawn([process.execPath, "--no-env-file", "-e", script], {
        cwd: process.cwd(), env: testChildEnv({ HOME: home, CLAUDESTRA_STATE_DIR: dir, OFFER_FIRST: first }),
        stdout: "pipe", stderr: "pipe",
      });
      const [exit, stdout, stderr] = await Promise.all([p.exited, new Response(p.stdout).text(), new Response(p.stderr).text()]);
      expect({ exit, stdout, stderr }).toEqual({ exit: 0, stdout: "", stderr: "" });
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("fresh bridge closes a real durable orphan card and sends exactly one fixed failure receipt", async () => {
  const root = mkdtempSync(join(tmpdir(), "offer-durable-restart-"));
  try {
    const script = `
      import assert from "node:assert/strict";
      import { readdirSync, readFileSync } from "node:fs";
      import { setAsksForTest, askDb } from "./src/bridge/asks.ts";
      import { listAsks } from "./src/lib/ledger-asks.ts";
      import { receiveJoinOffer, sweepJoinOffers, joinOfferLiveDeps } from "./src/bridge/shared-ledger-join-offer.ts";
      import { listPendingOfferIds } from "./src/lib/shared-ledger-join-offer.ts";
      const dir = process.env.CLAUDESTRA_STATE_DIR;
      setAsksForTest({ path: dir + "/cards.sqlite" });
      const peer = { name: "synthetic-restart-peer", baseUrl: "https://peer.example", outToken: "synthetic-token", addedAt: "" };
      const receipts = [], informed = [];
      const d = { ...joinOfferLiveDeps, stateDir: () => dir, peers: async () => [peer],
        projects: async () => [{ id: "local", name: "Local", lastActivityAt: 0 }], bindings: () => [],
        inform: async text => { informed.push(text); }, sendReceipt: async (_peer, body) => { receipts.push(JSON.parse(body)); return 200; } };
      if (process.env.OFFER_FIRST === "1") {
        const response = await receiveJoinOffer(peer, ${JSON.stringify({ v: 1, offerId: offer(99).offerId, url: offer(99).url, code: offer(99).code, expiresAt: offer(99).expiresAt })}, d);
        assert.equal(response.status, 202);
        assert.equal(listPendingOfferIds(dir).length, 1);
        assert.equal(listAsks(askDb(), { states: ["open"] }).length, 1);
        for (const name of readdirSync(dir)) assert.ok(!readFileSync(dir + "/" + name).includes(${JSON.stringify(offer(99).code)}));
      } else {
        assert.deepEqual(listPendingOfferIds(dir), []);
        await sweepJoinOffers(d);
        assert.equal(listAsks(askDb(), { states: ["open"] }).length, 0);
        assert.deepEqual(receipts, [{ v: 1, offerId: ${JSON.stringify(offer(99).offerId)}, status: "failed" }]);
        assert.deepEqual(informed, ["邀请已失效，请邀请方重新发起。"]);
        await sweepJoinOffers(d);
        assert.equal(receipts.length, 1);
      }
      console.log("durable-restart-passed");
    `;
    for (const first of ["1", "0"]) {
      const child = Bun.spawn([process.execPath, "--no-env-file", "-e", script], { cwd: process.cwd(),
        env: testChildEnv({ HOME: join(root, "home"), CLAUDESTRA_STATE_DIR: join(root, "state"),
          CLAUDESTRA_RUNTIME_DIR: join(root, "runtime"), OFFER_FIRST: first }), stdout: "pipe", stderr: "pipe" });
      const [exit, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
      expect({ exit, stderr }).toEqual({ exit: 0, stderr: "" });
      expect(stdout).toContain("durable-restart-passed");
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});
