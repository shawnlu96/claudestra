import { expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { peerReplayVerdict } from "../src/bridge/peer-signature.js";

test("启动前但仍新鲜的 GET：首次扣桶，后四次不扣，第六次拒；非 GET 仍拒", () => {
  const once = { sig: randomBytes(64).toString("base64url"), ts: String(Math.floor((Date.now() - process.uptime() * 1000) / 1000) - 1), idempotent: true };
  expect(peerReplayVerdict(once, "old-get-test")).toEqual({ reject: false, charge: true });
  for (let n = 0; n < 4; n++) expect(peerReplayVerdict(once, "old-get-test")).toEqual({ reject: false, charge: false });
  expect(peerReplayVerdict(once, "old-get-test")).toEqual({ reject: "replay", charge: false });
  expect(peerReplayVerdict({ ...once, idempotent: false }, "old-get-test")).toEqual({ reject: "before_start", charge: true });
});
