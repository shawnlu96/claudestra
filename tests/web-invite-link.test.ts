import { describe, expect, test } from "bun:test";
import { decodeInvite, findInviteCode, inviteLink, inviteMessage } from "@/features/chat/invite-link";

const enc = (o: unknown) => Buffer.from(JSON.stringify(o), "utf8").toString("base64url");
const CODE = enc({ v: 2, name: "小明", url: "https://mac.tail1.ts.net/", token: "t".repeat(64), join: "j".repeat(48), iid: "abc" });

describe("邀请链接 / 转发文案", () => {
  test("解出展示信息（中文名、去掉结尾斜杠）", () => {
    expect(decodeInvite(CODE)).toEqual({ name: "小明", url: "https://mac.tail1.ts.net" });
  });
  test("不是 v2 邀请 / 乱码 → null", () => {
    expect(decodeInvite(enc({ v: 1, name: "x", url: "https://a" }))).toBeNull();
    expect(decodeInvite("not-base64!!")).toBeNull();
  });
  test("从整段话、链接、裸码里都能找出邀请码", () => {
    expect(findInviteCode(`小明 邀请你……\nhttps://mac.tail1.ts.net/api/v1/invite#${CODE}\n\n链接打不开…`)).toBe(CODE);
    expect(findInviteCode(CODE)).toBe(CODE);
    expect(findInviteCode("普通聊天，没有邀请")).toBeNull();
  });
  test("链接指向邀请方的落地页，邀请码在 # 后面", () => {
    expect(inviteLink(CODE)).toBe(`https://mac.tail1.ts.net/api/v1/invite#${CODE}`);
  });
  test("转发文案带名字、可找的 agent、链接和退路", () => {
    const m = inviteMessage(CODE, ["claudestra"])!;
    expect(m).toContain("小明 邀请你的 Claudestra");
    expect(m).toContain("claudestra");
    expect(m).toContain(`/api/v1/invite#${CODE}`);
    expect(findInviteCode(m)).toBe(CODE);
  });
});

describe("经中继的邀请（url 是 relay://<指纹>）", () => {
  const RELAY = enc({ v: 2, name: "小明", url: "relay://16f9-b5d1-30fb-8923", token: "t".repeat(64), join: "j".repeat(48), fp: "16f9-b5d1-30fb-8923" });
  const LINK = `https://relay.example.com/i#${RELAY}`;
  test("能解出、能从文字里找出", () => {
    expect(decodeInvite(RELAY)).toEqual({ name: "小明", url: "relay://16f9-b5d1-30fb-8923" });
    expect(findInviteCode(`看这个 ${LINK} 谢谢`)).toBe(RELAY);
  });
  test("没有 bridge 给的链接就没有链接；给了就原样用", () => {
    expect(inviteLink(RELAY)).toBeNull();
    expect(inviteMessage(RELAY, [])).toBeNull();
    expect(inviteLink(RELAY, LINK)).toBe(LINK);
    expect(inviteMessage(RELAY, ["claudestra"], "en", LINK)).toContain(LINK);
  });
  test("直连邀请也可以用 bridge 给的链接覆盖", () => {
    expect(inviteLink(CODE, LINK)).toBe(LINK);
  });
});
