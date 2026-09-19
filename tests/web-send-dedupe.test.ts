import { describe, expect, test } from "bun:test";
import { isDuplicateSend, SEND_DEDUPE_MS } from "../web/features/chat/send-dedupe";

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
    expect(isDuplicateSend(last, { agent: "guoqing-trip", wire: TEXT + "?", at: last.at + 100 })).toBe(false);
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
