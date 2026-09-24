import { describe, expect, test } from "bun:test";
import { parseSource } from "@/features/chat/source-label";

describe("parseSource（外源消息来源标签）", () => {
  test("peer-<token名>：对方主动打来 → 通知", () => {
    expect(parseSource("peer-Shawn-2")).toEqual({ kind: "peer-notify", name: "Shawn-2", badge: "通知" });
  });
  test("peer <peer名>/<agent>：我们外呼后的回复 → 回复", () => {
    expect(parseSource("peer Shawn/claudestra")).toEqual({ kind: "peer-reply", name: "Shawn/claudestra", badge: "回复" });
  });
  test("本地别的 agent：两种写法都去前后缀，无 badge", () => {
    expect(parseSource("agent-harmonie")).toEqual({ kind: "agent", name: "harmonie" });
    expect(parseSource("harmonie (agent)")).toEqual({ kind: "agent", name: "harmonie" });
  });
  test("大总管转来的是机器，不是真人", () => {
    expect(parseSource("master")).toEqual({ kind: "agent", name: "master" });
  });
  test("其余是真人用户，原样显示", () => {
    expect(parseSource("Sekai")).toEqual({ kind: "user", name: "Sekai" });
    expect(parseSource("web-ui")).toEqual({ kind: "user", name: "web-ui" });
  });
});
