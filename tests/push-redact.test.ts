import { afterAll, describe, expect, test } from "bun:test";
import { setLangInMemory } from "../src/lib/i18n.ts";
import { redactApns, redactWebPush } from "../src/lib/push-redact.ts";

afterAll(() => setLangInMemory("zh"));

describe("push-redact", () => {
  test("英文界面给英文通用文案；collapseId 这类额外字段一律丢掉", () => {
    setLangInMemory("en");
    const m = redactApns({ title: "alpha", body: "secret", agent: "alpha", url: "/chat?agent=alpha", ts: 5, tag: "cstra-alpha-5", collapseId: "alpha", badge: 2 });
    expect(m).toEqual({ title: "Claudestra", body: "New message", agent: "", url: "/chat", ts: 5, tag: "cstra-5", badge: 2 });
    expect(redactWebPush({ title: "alpha", body: "secret", ask: "ask_1", agent: "alpha", ts: 5 }))
      .toEqual({ title: "Claudestra", body: "New message", url: "/chat", tag: "cstra-5", agent: "", ts: 5 });
  });
  test("dismiss 只留 ts / badge；没有 ts 的 payload 用当前时间", () => {
    expect(redactWebPush({ type: "dismiss", agent: "alpha", ts: 7 })).toEqual({ type: "dismiss", ts: 7 });
    const p = redactWebPush({ title: "x", body: "y" });
    expect(typeof p.ts).toBe("number");
  });
});
