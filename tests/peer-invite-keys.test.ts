/** 邀请里的密钥字段（lib/peers.ts parsePeerInviteV2；docs/relay/e2e-design.md §5.1）：带了就得两样都合格，否则整张作废，不降级成老邀请 */
import { describe, expect, test } from "bun:test";
import { createPublicKey, generateKeyPairSync } from "node:crypto";
import { signE2eKey } from "../src/lib/e2e-machine-key.ts";
import { generateEcdh } from "../src/lib/e2e/primitives.ts";
import { keyFingerprint } from "../src/lib/instance-key.ts";
import { encodePeerInviteV2, parsePeerInviteV2, type PeerInviteV2 } from "../src/lib/peers.ts";

async function keyed(): Promise<PeerInviteV2> {
  const privateKey = generateKeyPairSync("ed25519").privateKey;
  const idk = String(createPublicKey(privateKey).export({ format: "jwk" }).x);
  const ek = signE2eKey({ privateKey }, (await generateEcdh()).pub, 1, 1790000000);
  return { v: 2, name: "alice", url: "relay://" + keyFingerprint(idk), token: "a".repeat(64), join: "b".repeat(48), iid: "0123456789abcdef01234567", fp: keyFingerprint(idk), idk, ek };
}
const raw = (i: Record<string, unknown>) => Buffer.from(JSON.stringify(i)).toString("base64url");

describe("邀请里的 idk / ek", () => {
  test("带密钥的邀请往返；老邀请（两样都没有）照旧能解", async () => {
    const i = await keyed();
    expect(parsePeerInviteV2(encodePeerInviteV2(i))).toEqual(i);
    const { idk: _i, ek: _e, ...legacy } = i;
    expect(parsePeerInviteV2(encodePeerInviteV2(legacy))).toEqual(legacy);
  });

  test("只带一样、身份公钥对不上 fp、缺 fp、块形状不对 → 整张作废", async () => {
    const i = await keyed();
    const { idk, ek, ...rest } = i;
    expect(parsePeerInviteV2(raw({ ...rest, idk }))).toBeNull();
    expect(parsePeerInviteV2(raw({ ...rest, ek }))).toBeNull();
    expect(parsePeerInviteV2(raw({ ...i, fp: "0000-0000-0000-0000" }))).toBeNull();
    const { fp: _fp, ...noFp } = i;
    expect(parsePeerInviteV2(raw(noFp))).toBeNull();
    expect(parsePeerInviteV2(raw({ ...i, ek: { ...ek, v: 0 } }))).toBeNull();
    expect(parsePeerInviteV2(raw({ ...i, ek: { ...ek, sig: 5 } }))).toBeNull();
    expect(parsePeerInviteV2(raw({ ...i, idk: "short" }))).toBeNull();
  });

  test("块里多出来的字段丢掉，只留 v / ts / pub / sig", async () => {
    const i = await keyed();
    expect(parsePeerInviteV2(raw({ ...i, ek: { ...i.ek, extra: "x" } }))?.ek).toEqual(i.ek);
  });
});
