import { describe, expect, test } from "bun:test";
import { attachUpdateHints, isNewerVersion, makeVersionCache, pickUpdateHint } from "../src/lib/update-hints";
import { parseCcSessionEntry } from "../src/lib/cc-sessions";

describe("isNewerVersion", () => {
  test("逐段数字比较，不是字符串比较", () => {
    expect(isNewerVersion("2.1.281", "2.1.280")).toBe(true);
    expect(isNewerVersion("0.87.1", "0.86.1")).toBe(true);
    expect(isNewerVersion("2.1.100", "2.1.99")).toBe(true);
    expect(isNewerVersion("2.1.280", "2.1.280")).toBe(false);
    expect(isNewerVersion("2.1.279", "2.1.280")).toBe(false);
  });
  test("解析不出来 → false（拿不准就不提示）", () => {
    expect(isNewerVersion(undefined, "1.0.0")).toBe(false);
    expect(isNewerVersion("2.1.281", "garbage")).toBe(false);
  });
});

describe("pickUpdateHint", () => {
  test("Claude Code：磁盘版本比会话启动时新 → 提示重启", () => {
    expect(pickUpdateHint("claude-code", { running: "2.1.280", installed: "2.1.281" }))
      .toEqual({ kind: "restart", running: "2.1.280", installed: "2.1.281" });
    expect(pickUpdateHint("claude-code", { running: "2.1.281", installed: "2.1.281" })).toBeNull();
  });
  test("Claude Code 不看 latest（原生安装器自己会更新）", () => {
    expect(pickUpdateHint("claude-code", { running: "2.1.281", installed: "2.1.281", latest: "9.9.9" })).toBeNull();
  });
  test("Pi：有新版 → 先提示 pi update，哪怕运行版本也落后", () => {
    expect(pickUpdateHint("pi", { running: "0.85.0", installed: "0.86.1", latest: "0.87.1" }))
      .toEqual({ kind: "pi-update", installed: "0.86.1", latest: "0.87.1" });
  });
  test("Pi：已是最新但会话还在旧版 → 提示重启", () => {
    expect(pickUpdateHint("pi", { running: "0.86.1", installed: "0.87.1", latest: "0.87.1" }))
      .toEqual({ kind: "restart", running: "0.86.1", installed: "0.87.1" });
  });
  test("缺数据（快照没版本、离线查不到最新）→ 不提示", () => {
    expect(pickUpdateHint("pi", { installed: "0.86.1" })).toBeNull();
    expect(pickUpdateHint("claude-code", { installed: "2.1.281" })).toBeNull();
  });
});

test("会话登记带出进程启动时的版本", () => {
  const raw = JSON.stringify({ pid: 86415, sessionId: "s1", cwd: "/x", version: "2.1.280" });
  expect(parseCcSessionEntry(raw)?.version).toBe("2.1.280");
});

describe("makeVersionCache — 列表请求绝不等探测", () => {
  const deferred = () => {
    let resolve!: (v: string | undefined) => void;
    const p = new Promise<string | undefined>((r) => (resolve = r));
    return { p, resolve };
  };
  test("冷缓存 get 立刻给 undefined；并发 refresh 共用一轮，探测只跑一次", async () => {
    const c = makeVersionCache();
    const d = deferred();
    let calls = 0;
    const probe = { key: "k", ttl: 60_000, load: () => (calls++, d.p) };
    expect(c.get("k")).toBeUndefined();
    const a = c.refresh([probe]);
    const b = c.refresh([probe]);
    expect(b).toBe(a);
    expect(calls).toBe(1);
    d.resolve("1.2.3");
    await a;
    expect(c.get("k")).toBe("1.2.3");
  });
  test("TTL 内不重探，过期才重探", async () => {
    let t = 0;
    const c = makeVersionCache(() => t);
    let calls = 0;
    const probe = { key: "k", ttl: 1000, load: async () => `1.0.${++calls}` };
    await c.refresh([probe]);
    t = 999;
    await c.refresh([probe]);
    expect(calls).toBe(1);
    t = 1000;
    await c.refresh([probe]);
    expect(c.get("k")).toBe("1.0.2");
  });
  test("forget：TTL 内也立刻重探（刚替用户装完新版本）", async () => {
    const c = makeVersionCache(() => 0);
    let calls = 0;
    const probe = { key: "k", ttl: 60_000, load: async () => `0.8${++calls}.0` };
    await c.refresh([probe]);
    c.forget("k");
    expect(c.get("k")).toBeUndefined();
    await c.refresh([probe]);
    expect(c.get("k")).toBe("0.82.0");
  });
  test("探测抛错：不 reject，记成 undefined，TTL 内不再打", async () => {
    const c = makeVersionCache(() => 0);
    let calls = 0;
    const probe = { key: "k", ttl: 1000, load: async () => { calls++; throw new Error("offline"); } };
    await c.refresh([probe]);
    await c.refresh([probe]);
    expect(c.get("k")).toBeUndefined();
    expect(calls).toBe(1);
  });
});

describe("attachUpdateHints", () => {
  const regs = new Map([["p1", { runtime: "pi" }], ["p2", { runtime: "pi" }]]);
  test("不 await 后台刷新：刷新永不结束也照样返回，用的是缓存里已有的值", async () => {
    const asked: string[][] = [];
    const cache = {
      get: (k: string) => ({ "installed:pi": "0.86.1", "latest:pi": "0.87.1" })[k],
      refresh: (probes: { key: string }[]) => (asked.push(probes.map((p) => p.key)), new Promise<void>(() => {})),
      forget: () => {},
    };
    const agents: any[] = [{ name: "p1", status: "active" }, { name: "p2", status: "stopped" }, { name: "x", status: "active" }];
    await attachUpdateHints(agents, regs, cache);
    expect(agents[0].updateHint).toEqual({ kind: "pi-update", installed: "0.86.1", latest: "0.87.1" });
    expect(agents[1].updateHint).toBeUndefined(); // 非 active 不提示
    expect(agents[2].updateHint).toBeUndefined(); // 不在 registry（如 master）不提示
    expect(asked).toEqual([["installed:pi", "latest:pi"]]); // 只有 Pi 会话 → 不去探 claude
  });
  test("冷缓存 → 这一轮不带提示", async () => {
    const cache = { get: () => undefined, refresh: () => Promise.resolve(), forget: () => {} };
    const agents: any[] = [{ name: "p1", status: "active" }];
    await attachUpdateHints(agents, regs, cache);
    expect(agents[0].updateHint).toBeNull();
  });
});
