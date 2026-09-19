import { describe, expect, test } from "bun:test";
import { isDuplicateSend, normalizeForDedupe, SEND_DEDUPE_MS } from "../web/features/chat/send-dedupe";

const TEXT = "哎，所以现在有点纠结啊，到底是买 F 还是买 K1 还是主看台抽奖？";
const last = { agent: "guoqing-trip", wire: TEXT, at: 1_000_000 };

describe("isDuplicateSend", () => {
  test("同 agent 同文本 0.7s(owner 2026-09-19 实录)→ 判重复", () => {
    expect(isDuplicateSend(last, { agent: "guoqing-trip", wire: TEXT, at: last.at + 708 })).toBe(true);
  });
  test("超出窗口 → 放行(真想再发一遍)", () => {
    expect(isDuplicateSend(last, { agent: "guoqing-trip", wire: TEXT, at: last.at + SEND_DEDUPE_MS })).toBe(false);
  });
  test("换 agent / 换文本 → 放行", () => {
    expect(isDuplicateSend(last, { agent: "other", wire: TEXT, at: last.at + 100 })).toBe(false);
    expect(isDuplicateSend(last, { agent: "guoqing-trip", wire: `${TEXT} 另外酒店呢`, at: last.at + 100 })).toBe(false);
  });
  test("只多一个问号 → 按听写两稿判重复(见下方 describe)", () => {
    expect(isDuplicateSend(last, { agent: "guoqing-trip", wire: `${TEXT}?`, at: last.at + 100 })).toBe(true);
  });
  test("带附件 → 永不判重(同名文件重发是合法操作)", () => {
    expect(isDuplicateSend(last, { agent: "guoqing-trip", wire: TEXT, at: last.at + 100, hasFiles: true })).toBe(false);
  });
  test("没有上一次 / 时钟倒退 → 放行", () => {
    expect(isDuplicateSend(null, { agent: "guoqing-trip", wire: TEXT, at: 1 })).toBe(false);
    expect(isDuplicateSend(last, { agent: "guoqing-trip", wire: TEXT, at: last.at - 5 })).toBe(false);
  });
  test("按钮点击的 wire 同样受保护(连点两下同一个按钮)", () => {
    const b = { agent: "claudestra", wire: "[button:pr_merge]", at: 500 };
    expect(isDuplicateSend(b, { agent: "claudestra", wire: "[button:pr_merge]", at: 900 })).toBe(true);
  });
});

describe("isDuplicateSend — 听写两稿(只差标点)", () => {
  // owner 2026-09-19 10:46 UTC 实录:两条正文只差「票。/票？」「槟城。这两站/槟城这两站」
  const v1 = "哎，我现在还是难以决定行程，就是到底是买哪一种票。到底应该怎么去订酒店？行程怎么安排？是吉隆坡、槟城。这两站就够，还是要不要加普吉岛？";
  const v2 = "哎，我现在还是难以决定行程，就是到底是买哪一种票？到底应该怎么去订酒店？行程怎么安排？是吉隆坡、槟城这两站就够，还是要不要加普吉岛？";
  const last = { agent: "guoqing-trip", wire: v1, at: 1_000_000 };

  test("间隔 2.16s、只差标点 → 判重复(逐字比对会漏)", () => {
    expect(isDuplicateSend(last, { agent: "guoqing-trip", wire: v2, at: last.at + 2_164 })).toBe(true);
  });
  test("超出宽窗 5s → 放行(用户真想再问一遍)", () => {
    expect(isDuplicateSend(last, { agent: "guoqing-trip", wire: v2, at: last.at + 5_000 })).toBe(false);
  });
  test("换了实词 → 归一后仍不同,放行", () => {
    const other = v1.replace("普吉岛", "清迈");
    expect(isDuplicateSend(last, { agent: "guoqing-trip", wire: other, at: last.at + 500 })).toBe(false);
  });
  test("纯标点/空白消息不互相吞", () => {
    const punct = { agent: "a", wire: "？？", at: 0 };
    expect(isDuplicateSend(punct, { agent: "a", wire: "。。", at: 100 })).toBe(false);
  });
  test("归一只去标点空白,不碰字母数字大小写", () => {
    expect(normalizeForDedupe("Hello, world! 你好。")).toBe("Helloworld你好");
    expect(isDuplicateSend({ agent: "a", wire: "run test", at: 0 }, { agent: "a", wire: "RUN TEST", at: 100 })).toBe(false);
  });
});
