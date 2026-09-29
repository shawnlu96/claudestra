/**
 * 跨实例 Chat 协议 v1 的测试向量（docs/talk/protocol.md §9）。钥匙由固定种子生成（Ed25519 签名是确定的），
 * 别的实现拿这些字面量就能对齐：指纹、dm 房间 id、回执签名串与签名。dm id 与指纹已用 shasum / python 独立核过。
 */
import { describe, expect, test } from "bun:test";
import { createHash, createPrivateKey, createPublicKey } from "node:crypto";
import { keyFingerprint } from "../src/lib/instance-key.js";
import { checkInboundFrame, signTalkAck, talkAckMessage, verifyTalkAck, type InboundContext } from "../src/lib/talk-protocol.js";
import { dmRoomId, memberKey } from "../src/lib/talk-rooms.js";

const seeded = (byte: number) => {
  const priv = createPrivateKey({ key: Buffer.from(`302e020100300506032b657004220420${Buffer.alloc(32, byte).toString("hex")}`, "hex"), format: "der", type: "pkcs8" });
  return { priv, pub: String(createPublicKey(priv).export({ format: "jwk" }).x) };
};
const A = seeded(0x01); // 发送方
const B = seeded(0x02); // 接收方
const FP_A = "3475-0f98-bd59-fcfc";
const FP_B = "6a38-03d5-f059-902a";
const ID = "tm_00000000-0000-4000-8000-000000000001";
const ACK_SIG = "s5O7erP2bZniXBgze0GTCqp9MjwKFR3MrucgDUIrcgVlcI_fKk_SvK0ZAZVLR4L-XfmIunV1okTggwqoEsVbCw";
const ACK_SIG_ACCEPTED = "IZPZbogiG4zJ6cZEuKSihbRO1sK6rdFvBaJVBwwVrMH8_umVkIBltXnZ-XAtQN7Fo54NtvQ6OwHKOJr1pBleBQ";

describe("向量：钥匙、指纹、dm 房间 id", () => {
  test("种子 0x01 / 0x02 的公钥与指纹", () => {
    expect(A.pub).toBe("iojj3XQJ8ZX9UtstPLpdcspnCb8dlBIb83SIAbQPb1w");
    expect(B.pub).toBe("gTl3Dqh9F19Wo1Rmw0x-zMuNipG07jeiXfYPW4_Js5Q");
    expect(keyFingerprint(A.pub)).toBe(FP_A);
    expect(keyFingerprint(B.pub)).toBe(FP_B);
  });
  test("dm id = hex(sha256(a + \\n + b))，a、b 为两个成员键按字节序排好；与谁先谁后无关", () => {
    const a = memberKey(FP_A, "owner:self");
    const b = memberKey(FP_B, "guest:0a1b2c3d");
    expect(dmRoomId(a, b)).toBe("0005c46be6b0757a733cca7dfd39b7b1f0fc03655e26e6315aeba8cff8cf946b");
    expect(dmRoomId(b, a)).toBe(dmRoomId(a, b));
    expect(dmRoomId(a, memberKey(FP_B, "owner:self"))).toBe("5feef6ed94c82dad6a1a4dfde49da814f44d780d7786de74887bc9905eb12a89");
    expect(memberKey("3475-0F98-BD59-FCFC", "owner:self")).toBe(a);
  });
});

describe("向量：签名回执", () => {
  test("签名串逐字节", () => {
    expect(talkAckMessage(FP_A, ID, FP_B)).toBe(`claudestra-talk-ack-v1\n${FP_A}\n${ID}\n${FP_B}`);
    expect(talkAckMessage(FP_A, ID, FP_B, "accepted")).toBe(`claudestra-talk-ack-v1\n${FP_A}\n${ID}\n${FP_B}\naccepted`);
  });
  test("接收方 B 签的回执（确定性签名）", () => {
    expect(signTalkAck(B.priv, B.pub, talkAckMessage(FP_A, ID, FP_B))).toEqual({ key: B.pub, sig: ACK_SIG });
    expect(signTalkAck(B.priv, B.pub, talkAckMessage(FP_A, ID, FP_B, "accepted")).sig).toBe(ACK_SIG_ACCEPTED);
  });
  test("发送方核回执：自带公钥的指纹必须是期望的接收方；挪用别的消息、别的实例、别的状态的回执都不算", () => {
    const expect_ = { recipientFp: FP_B, origin: FP_A, id: ID };
    expect(verifyTalkAck({ key: B.pub, sig: ACK_SIG }, expect_)).toBe("ok");
    expect(verifyTalkAck({ key: B.pub, sig: ACK_SIG_ACCEPTED }, { ...expect_, state: "accepted" })).toBe("ok");
    expect(verifyTalkAck({ key: B.pub, sig: ACK_SIG }, { ...expect_, state: "accepted" })).toBe("bad_sig");
    expect(verifyTalkAck({ key: B.pub, sig: ACK_SIG }, { ...expect_, id: "tm_00000000-0000-4000-8000-000000000002" })).toBe("bad_sig");
    // 中继（或第三方）用自己的钥匙签一张「送达」：指纹对不上，不出队
    const forged = signTalkAck(A.priv, A.pub, talkAckMessage(FP_A, ID, FP_B));
    expect(verifyTalkAck(forged, expect_)).toBe("wrong_key");
    expect(verifyTalkAck({ key: B.pub, sig: "x" }, expect_)).toBe("bad_sig");
    expect(verifyTalkAck({ ok: true }, expect_)).toBe("malformed");
    expect(verifyTalkAck(null, expect_)).toBe("malformed");
  });
});

describe("入站帧校验（接收方 B）", () => {
  const ctx: InboundContext = { origin: FP_A, selfFp: FP_B, bodyBytes: 1000, openToChat: (p) => p === "owner:self" || p === "guest:0a1b2c3d" };
  const png = Buffer.from("89504e470d0a1a0a", "hex");
  const frame = (over: Record<string, unknown> = {}) => ({
    v: 1, type: "chat", id: ID, room: { creatorFp: "", id: "whatever-the-sender-says", kind: "dm" }, to: "owner:self",
    author: { principal: "owner:self", name: "Alex‮" }, text: "hi", createdAt: "2026-10-01T00:00:00Z", ...over,
  });

  test("dm：房间 id 由接收方重算，不采信帧里的；自报名清洗", () => {
    const r = checkInboundFrame(frame(), ctx);
    expect(r.ok && r.room).toEqual({ creatorFp: "", id: dmRoomId(memberKey(FP_A, "owner:self"), memberKey(FP_B, "owner:self")) });
    expect(r.ok && r.authorKey).toBe(`${FP_A}/owner:self`);
    expect(r.ok && r.claimedName).toBe("Alex");
  });
  test("dm 的收件人必须本机存在且开放了 chat；creatorFp 必须为空", () => {
    expect(checkInboundFrame(frame({ to: "guest:ffff" }), ctx)).toMatchObject({ ok: false, status: 400 });
    expect(checkInboundFrame(frame({ room: { creatorFp: FP_A, id: "x", kind: "dm" } }), ctx)).toMatchObject({ ok: false });
  });
  test("thread：对方建的要带 members 且含作者，本机只有列名且开放了 chat 的人看得见；我方建的标 mustBeMember；第三方建的拒", () => {
    const tid = "tr_00000000-0000-4000-8000-0000000000aa";
    const members = [`${FP_A}/owner:self`, `${FP_B}/guest:0a1b2c3d`, `${FP_B}/guest:notopen`];
    const r = checkInboundFrame(frame({ room: { creatorFp: FP_A, id: tid, kind: "thread" }, to: undefined, members }), ctx);
    expect(r.ok && r.localMembers).toEqual([`${FP_B}/guest:0a1b2c3d`]);
    expect(checkInboundFrame(frame({ room: { creatorFp: FP_A, id: tid, kind: "thread" }, members: [`${FP_B}/guest:0a1b2c3d`, `${FP_A}/guest:x`] }), ctx)).toMatchObject({ ok: false });
    expect(checkInboundFrame(frame({ room: { creatorFp: FP_A, id: tid, kind: "thread" }, members: [`${FP_A}/owner:self`, `${FP_B}/guest:notopen`] }), ctx)).toMatchObject({ ok: false });
    const ours = checkInboundFrame(frame({ room: { creatorFp: FP_B, id: tid, kind: "thread" } }), ctx);
    expect(ours.ok && ours.mustBeMember).toBe(true);
    expect(checkInboundFrame(frame({ room: { creatorFp: "1111-2222-3333-4444", id: tid, kind: "thread" }, members }), ctx)).toMatchObject({ ok: false });
  });
  test("形状与大小：legacy 版本号、id、principal 字符集、超大正文 413、附件哈希与大小、SVG", () => {
    expect(checkInboundFrame(frame({ v: 0 }), ctx)).toMatchObject({ ok: false, status: 400 });
    expect(checkInboundFrame(frame({ id: "tm_x" }), ctx)).toMatchObject({ ok: false });
    expect(checkInboundFrame(frame({ author: { principal: "owner self", name: "x" } }), ctx)).toMatchObject({ ok: false });
    expect(checkInboundFrame(frame({ author: { principal: "a".repeat(65), name: "x" } }), ctx)).toMatchObject({ ok: false });
    expect(checkInboundFrame(frame(), { ...ctx, bodyBytes: 2 * 1024 * 1024 + 1 })).toMatchObject({ ok: false, status: 413 });
    const att = { sha256: createHash("sha256").update(png).digest("hex"), mime: "image/png", bytes: png.length, inline: png.toString("base64") };
    expect(checkInboundFrame(frame({ atts: [att] }), ctx).ok).toBe(true);
    expect(checkInboundFrame(frame({ atts: [{ ...att, sha256: "0".repeat(64) }] }), ctx)).toMatchObject({ ok: false });
    expect(checkInboundFrame(frame({ atts: [{ ...att, bytes: 99 }] }), ctx)).toMatchObject({ ok: false });
    expect(checkInboundFrame(frame({ atts: [{ ...att, mime: "image/svg+xml" }] }), ctx)).toMatchObject({ ok: false });
    expect(checkInboundFrame(frame({ text: "", refs: [] }), ctx)).toMatchObject({ ok: false });
    expect(checkInboundFrame(frame({ refs: [{ kind: "task", id: "T1", title: "只带标题" }] }), ctx).ok).toBe(true);
  });
});
