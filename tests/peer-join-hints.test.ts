import { describe, expect, test } from "bun:test";
import { classifyJoinError, joinFailureHint } from "../src/lib/peer-join-hints";

// 形态取自 Bun fetch 实测（2026-09-23）：对方没把机器共享给我 → 超时；pf block return → ConnectionRefused
describe("classifyJoinError", () => {
  test("超时 / 被拒 / 其它", () => {
    expect(classifyJoinError({ name: "TimeoutError", code: 23, message: "The operation timed out." })).toBe("timeout");
    expect(classifyJoinError({ name: "Error", code: "ConnectionRefused", message: "Unable to connect. Is the computer able to access the url?" })).toBe("refused");
    expect(classifyJoinError({ name: "Error", message: "socket hang up" })).toBe("other");
  });
});

describe("joinFailureHint（告诉接方谁该做什么）", () => {
  const peerUrl = "http://100.120.71.107:3847";
  test("超时：点明是对方要把机器共享给你，且共享是单向的", () => {
    const h = joinFailureHint("timeout", { peerUrl });
    expect(h).toContain("100.120.71.107:3847");
    expect(h).toContain("共享给你");
    expect(h).toContain("单向");
  });
  test("被拒：带上我方地址让对方放行防火墙", () => {
    expect(joinFailureHint("refused", { peerUrl, myAddr: "100.113.223.87" })).toContain("100.113.223.87");
    expect(joinFailureHint("refused", { peerUrl })).not.toContain("undefined");
  });
  test("邀请被拒 → 让对方重新生成；有 tailnet 候选时附上", () => {
    expect(joinFailureHint("rejected", { peerUrl })).toContain("重新生成");
    expect(joinFailureHint("timeout", { peerUrl, candidates: ["http://100.1.2.3:3847"] })).toContain("http://100.1.2.3:3847");
  });
});
