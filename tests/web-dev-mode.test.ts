import { describe, expect, test, beforeEach } from "bun:test";
import { resolveDevMode, DEV_MODE_KEY } from "../web/features/devtools/dev-mode";
import {
  DEV_EVENT_CAP,
  allCounters,
  bumpCounter,
  clearDevEvents,
  devEvent,
  devEventFromLog,
  devEventsVersion,
  makeRateSampler,
  readCounter,
  recentDevEvents,
  resetCounters,
  subscribeDevEvents,
} from "../web/features/devtools/dev-events";
import {
  clearDevSections,
  devSectionsVersion,
  listDevSections,
  registerDevSection,
  subscribeDevSections,
} from "../web/features/devtools/dev-registry";

describe("resolveDevMode — URL 参数 > 持久化值", () => {
  test("没有参数 → 沿用持久化值,不落盘", () => {
    expect(resolveDevMode("", null)).toEqual({ on: false, persist: false });
    expect(resolveDevMode("?x=1", "1")).toEqual({ on: true, persist: false });
  });
  test("?dev=1 / ?dev / ?dev=true / ?dev=on → 开;之前关着才需要落盘", () => {
    for (const s of ["?dev=1", "?dev", "?dev=true", "?dev=ON"]) {
      expect(resolveDevMode(s, null)).toEqual({ on: true, persist: true });
      expect(resolveDevMode(s, "1")).toEqual({ on: true, persist: false });
    }
  });
  test("?dev=0 / false / off → 关;之前开着才需要落盘", () => {
    for (const s of ["?dev=0", "?dev=false", "?dev=off"]) {
      expect(resolveDevMode(s, "1")).toEqual({ on: false, persist: true });
      expect(resolveDevMode(s, null)).toEqual({ on: false, persist: false });
    }
  });
  test("无法识别的值 → 当没传", () => {
    expect(resolveDevMode("?dev=maybe", "1")).toEqual({ on: true, persist: false });
    expect(resolveDevMode("?dev=maybe", null)).toEqual({ on: false, persist: false });
  });
  test("与其它参数共存", () => {
    expect(resolveDevMode("?noWebgl=1&dev=1&foo=bar", null).on).toBe(true);
  });
  test("localStorage 键名固定(设置页与 URL 写同一个)", () => {
    expect(DEV_MODE_KEY).toBe("cstra_devmode");
  });
});

describe("dev-events — 事件环", () => {
  beforeEach(() => {
    clearDevEvents();
    resetCounters();
  });
  test("push 后能读到,最新在后", () => {
    devEvent("a", "first", 1);
    devEvent("b", "second", 2);
    expect(recentDevEvents(10).map((e) => e.msg)).toEqual(["first", "second"]);
    expect(recentDevEvents(1)[0]?.kind).toBe("b");
  });
  test("超过上限丢最旧的", () => {
    for (let i = 0; i < DEV_EVENT_CAP + 25; i++) devEvent("k", `m${i}`, i);
    const all = recentDevEvents(DEV_EVENT_CAP + 100);
    expect(all.length).toBe(DEV_EVENT_CAP);
    expect(all[0]?.msg).toBe("m25");
  });
  test("超长消息截断到 2000 字", () => {
    devEvent("k", "x".repeat(5000));
    expect(recentDevEvents(1)[0]?.msg.length).toBe(2001);
  });
  test("client.log 一行 → kind:[tag] 归 tag,壳/PWA 的运行时错误归 error,无前缀归 log", () => {
    devEventFromLog("[commits] 31 commits in one task");
    devEventFromLog("[pwa] error TypeError: x is not a function\nstack: …");
    devEventFromLog("[shell] unhandledrejection boom");
    devEventFromLog("[shell] slide back total=900ms");
    devEventFromLog("stream connected agent=foo");
    expect(recentDevEvents(5).map((e) => e.kind)).toEqual(["commits", "error", "error", "shell", "log"]);
    expect(recentDevEvents(5)[0]?.msg).toBe("31 commits in one task");
    expect(recentDevEvents(5)[1]?.msg.startsWith("pwa error TypeError")).toBe(true);
    expect(recentDevEvents(5)[4]?.msg).toBe("stream connected agent=foo");
  });
  test("版本号随 push / clear 单调递增,订阅者收到通知", () => {
    const v0 = devEventsVersion();
    let calls = 0;
    const off = subscribeDevEvents(() => calls++);
    devEvent("k", "m");
    expect(devEventsVersion()).toBeGreaterThan(v0);
    clearDevEvents();
    expect(calls).toBe(2);
    off();
    devEvent("k", "m");
    expect(calls).toBe(2);
  });
});

describe("dev-events — 计数器与速率", () => {
  beforeEach(() => resetCounters());
  test("bump / read / all / reset", () => {
    bumpCounter("x");
    bumpCounter("x", 4);
    bumpCounter("y");
    expect(readCounter("x")).toBe(5);
    expect(allCounters()).toEqual({ x: 5, y: 1 });
    resetCounters();
    expect(readCounter("x")).toBe(0);
  });
  test("速率采样器:首采 0,之后 = 差值 / 秒", () => {
    const rate = makeRateSampler("r");
    expect(rate(0)).toBe(0);
    bumpCounter("r", 10);
    expect(rate(2000)).toBe(5);
    expect(rate(3000)).toBe(0);
    bumpCounter("r", 3);
    expect(rate(3500)).toBe(6);
  });
});

describe("dev-registry — 分区注册", () => {
  beforeEach(() => clearDevSections());
  test("注册 / 列出 / 注销;同 id 覆盖", () => {
    const m1 = () => undefined;
    const m2 = () => undefined;
    const off1 = registerDevSection("s", m1);
    registerDevSection("s", m2);
    expect(listDevSections().map((s) => s.mount)).toEqual([m2]);
    off1(); // m1 已被覆盖,注销无效
    expect(listDevSections().length).toBe(1);
  });
  test("版本号与订阅", () => {
    const v0 = devSectionsVersion();
    let calls = 0;
    const off = subscribeDevSections(() => calls++);
    const unreg = registerDevSection("a", () => undefined);
    unreg();
    expect(calls).toBe(2);
    expect(devSectionsVersion()).toBe(v0 + 2);
    off();
  });
});
