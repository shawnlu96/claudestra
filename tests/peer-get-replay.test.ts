import { expect, setSystemTime, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { peerReplayVerdict } from "../src/bridge/peer-signature.js";

test("启动前但仍新鲜的 GET：首次扣桶，后四次不扣，第六次拒；非 GET 仍拒", () => {
  // 签名时间必定早于防重放缓存建立，时钟拨到签名后一秒 = 仍新鲜。不能用真实时钟：整套测试跑过 5 分钟后条目一记下就已过期，次次都像第一次
  const once = { sig: randomBytes(64).toString("base64url"), ts: "1000", idempotent: true };
  setSystemTime(new Date(1001_000));
  try {
    expect(peerReplayVerdict(once, "old-get-test")).toEqual({ reject: false, charge: true });
    for (let n = 0; n < 4; n++) expect(peerReplayVerdict(once, "old-get-test")).toEqual({ reject: false, charge: false });
    expect(peerReplayVerdict(once, "old-get-test")).toEqual({ reject: "replay", charge: false });
    expect(peerReplayVerdict({ ...once, idempotent: false }, "old-get-test")).toEqual({ reject: "before_start", charge: true });
  } finally {
    setSystemTime();
  }
});
