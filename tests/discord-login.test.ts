// DNF-1：Discord 登录失败分类 / 退避 / 不退出 / 看门狗只重连 / 首次 ready 只初始化一次
import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { EventEmitter } from "node:events";
import {
  attachGatewayWatch, bindFirstReady, classifyGatewayClose, classifyLoginError, createDiscordConnector, createStatusWatchdog,
  gatewayConnected, loginBackoffMs, LOGIN_BACKOFF_MAX_MS, SHARD_LOG_EVERY_MS,
  type DiscordConnector, type LoginFailure,
} from "../src/bridge/discord-login.ts";

const err = (props: Record<string, unknown>, message = "x") => Object.assign(new Error(message), props);

/** 手动时钟：记下每个定时器的延时，由测试决定何时触发 */
function manualTimers() {
  const pending: { fn: () => void; ms: number; id: number }[] = [];
  let seq = 0;
  return {
    pending,
    setTimer: (fn: () => void, ms: number) => { const id = ++seq; pending.push({ fn, ms, id }); return id as unknown as ReturnType<typeof setTimeout>; },
    clearTimer: (t: ReturnType<typeof setTimeout>) => { const i = pending.findIndex((p) => p.id === (t as unknown as number)); if (i >= 0) pending.splice(i, 1); },
    /** 触发第一个延时为 ms 的定时器 */
    fire(ms: number) { const i = pending.findIndex((p) => p.ms === ms); if (i < 0) throw new Error(`no timer ${ms}`); const [p] = pending.splice(i, 1); p!.fn(); },
  };
}
const quiet = () => {
  const lines: string[] = [];
  const push = (...a: unknown[]) => void lines.push(a.map(String).join(" "));
  return { lines, log: { log: push, warn: push, error: push } };
};
const flush = () => new Promise((r) => setTimeout(r, 0));

let exitSpy: ReturnType<typeof spyOn>;
beforeEach(() => { exitSpy = spyOn(process, "exit").mockImplementation((() => { throw new Error("process.exit called"); }) as never); });
afterEach(() => exitSpy.mockRestore());

describe("classifyLoginError：Bun / discord.js 实测的错误形态", () => {
  test.each([
    [err({ code: "ConnectionRefused" }, "Unable to connect. Is the computer able to access the url?"), "network", false],
    [Object.assign(new Error("The operation was aborted."), { name: "AbortError", code: 20 }), "network", false],
    [err({ code: "ENOTFOUND" }, "getaddrinfo ENOTFOUND discord.com"), "network", false],
    [err({ code: "DEPTH_ZERO_SELF_SIGNED_CERT" }, "self signed certificate"), "tls", false],
    [err({ code: "CERT_HAS_EXPIRED" }, "certificate has expired"), "tls", false],
    [err({ code: "TokenInvalid" }, "An invalid token was provided."), "token", true],
    [err({}, "wrapped"), "unknown", false],
  ])("%#", (e, kind, fatal) => {
    const f = classifyLoginError(e);
    expect(f.kind).toBe(kind as LoginFailure["kind"]);
    expect(f.fatal).toBe(fatal as boolean);
  });

  test("沿 cause 链找真原因：外层泛化、里层 401 / 网络码", () => {
    expect(classifyLoginError(err({ cause: { status: 401 } }, "request failed")).kind).toBe("token");
    expect(classifyLoginError(err({ cause: err({ code: "ECONNRESET" }) }, "fetch failed")).kind).toBe("network");
    expect(classifyLoginError(err({ code: "DisallowedIntents" }, "Privileged intent provided is not enabled")).kind).toBe("intents");
    expect(classifyLoginError("plain string").kind).toBe("unknown");
  });

  test("gateway 不可恢复关闭码", () => {
    expect(classifyGatewayClose(4004)?.kind).toBe("token");
    expect(classifyGatewayClose(4014)).toMatchObject({ kind: "intents", fatal: true });
    expect(classifyGatewayClose(1006)).toBeNull();
    expect(classifyGatewayClose(undefined)).toBeNull();
  });
});

test("退避：5s 起翻倍封顶 5 分钟；不可恢复类直接按上限", () => {
  expect([1, 2, 3, 4, 5, 6, 7, 8, 20].map((n) => loginBackoffMs(n, false) / 1000)).toEqual([5, 10, 20, 40, 80, 160, 300, 300, 300]);
  expect(loginBackoffMs(1, true)).toBe(LOGIN_BACKOFF_MAX_MS);
});

describe("createDiscordConnector", () => {
  test("登录连续失败不退出，按退避重试；日志区分原因；恢复后计数清零", async () => {
    const t = manualTimers();
    const q = quiet();
    const outcomes: (Error | null)[] = [err({ code: "ConnectionRefused" }), err({ code: "CERT_HAS_EXPIRED" }), err({ code: "TokenInvalid" }), null];
    let calls = 0;
    const c = createDiscordConnector({
      login: () => { const o = outcomes[calls++]; return o ? Promise.reject(o) : Promise.resolve("ok"); },
      isConnected: () => false, setTimer: t.setTimer, clearTimer: t.clearTimer, log: q.log,
    });
    c.start(); await flush();
    expect(c.failures).toBe(1);
    t.fire(5_000); await flush();
    expect(c.failures).toBe(2);
    t.fire(10_000); await flush();
    expect(c.failures).toBe(3);
    t.fire(LOGIN_BACKOFF_MAX_MS); await flush(); // token 无效：按上限重试，仍不退出
    expect(calls).toBe(4);
    expect(c.failures).toBe(0);
    const text = q.lines.join("\n");
    expect(text).toContain("📴 Discord 网络不可达");
    expect(text).toContain("🔒 Discord TLS 握手失败");
    expect(text).toContain("🚨 Discord token 无效");
    expect(text).toContain("不可恢复");
    expect(text).toContain("✅ Discord 登录恢复（此前连续失败 3 次；login 成功）");
    expect(exitSpy).not.toHaveBeenCalled();
  });

  test("login 挂住不 settle：超时按网络失败重排，迟到的旧结果被丢弃", async () => {
    const t = manualTimers();
    const q = quiet();
    let resolveFirst: (v: unknown) => void = () => {};
    let calls = 0;
    const c = createDiscordConnector({
      login: () => (++calls === 1 ? new Promise((r) => { resolveFirst = r; }) : Promise.reject(err({ code: "ENETUNREACH" }))),
      isConnected: () => false, setTimer: t.setTimer, clearTimer: t.clearTimer, log: q.log, loginTimeoutMs: 1234,
    });
    c.start();
    t.fire(1234); await flush();
    expect(c.failures).toBe(1);
    expect(q.lines.join("\n")).toContain("login 1s 未完成");
    resolveFirst("late"); await flush();
    expect(c.failures).toBe(1); // 旧 login 的迟到成功不改状态
    t.fire(5_000); await flush();
    expect(calls).toBe(2);
    expect(c.failures).toBe(2);
  });

  test("重试到点时已在线就不再 login", async () => {
    const t = manualTimers();
    let connected = false;
    let calls = 0;
    const c = createDiscordConnector({
      login: () => { calls++; return Promise.reject(err({ code: "ECONNREFUSED" })); },
      isConnected: () => connected, setTimer: t.setTimer, clearTimer: t.clearTimer, log: quiet().log,
    });
    c.start(); await flush();
    connected = true;
    t.fire(5_000); await flush();
    expect(calls).toBe(1);
    expect(c.failures).toBe(0);
  });

  test("reconnect：登录在跑或重试已排上时不插队；fail 作废在跑的登录并重排", async () => {
    const t = manualTimers();
    let calls = 0;
    const c = createDiscordConnector({
      login: () => { calls++; return new Promise(() => {}); },
      isConnected: () => false, setTimer: t.setTimer, clearTimer: t.clearTimer, log: quiet().log, loginTimeoutMs: 999,
    });
    c.start();
    c.reconnect("看门狗");
    expect(calls).toBe(1);
    c.fail(classifyGatewayClose(4014)!);
    expect(t.pending.some((p) => p.ms === LOGIN_BACKOFF_MAX_MS)).toBe(true);
    c.reconnect("看门狗");
    expect(calls).toBe(1);
    t.fire(999); // 被作废的那次 login 的超时：不再重排
    expect(c.failures).toBe(1);
    t.fire(LOGIN_BACKOFF_MAX_MS);
    expect(calls).toBe(2);
  });
});

function fakeConnector() {
  const calls: string[] = [];
  const c: DiscordConnector = {
    start: () => calls.push("start"), reconnect: (r) => calls.push(`reconnect:${r}`), fail: (f) => calls.push(`fail:${f.kind}`), failures: 0,
  };
  return { c, calls };
}

describe("看门狗只重连不退出", () => {
  test("gateway 连续 5 拍不在线 → reconnect 一次，计数归零", () => {
    const { c, calls } = fakeConnector();
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    let up = false;
    const tick = createStatusWatchdog(() => up, c);
    for (let i = 0; i < 9; i++) tick();
    expect(calls.length).toBe(1);
    up = true; tick(); up = false;
    for (let i = 0; i < 4; i++) tick();
    expect(calls.length).toBe(1);
    warn.mockRestore();
    expect(exitSpy).not.toHaveBeenCalled();
  });

  test("shardDisconnect：不可恢复码走 fail；可恢复码只记日志，不重新 login（重连交给 @discordjs/ws 与状态看门狗）", () => {
    const { c, calls } = fakeConnector();
    const em = new EventEmitter();
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    attachGatewayWatch(em, c);
    em.emit("shardDisconnect", { code: 4014 }, 0);
    expect(calls).toEqual(["fail:intents"]);
    for (let i = 0; i < 5; i++) em.emit("shardDisconnect", { code: 1006 }, 0);
    expect(calls).toEqual(["fail:intents"]);
    warn.mockRestore();
    expect(exitSpy).not.toHaveBeenCalled();
  });
});

test("断网时 shard 重连 / 报错日志节流：每分钟一条，带省略数", () => {
  const em = new EventEmitter();
  const lines: string[] = [];
  const logSpy = spyOn(console, "log").mockImplementation((m: string) => void lines.push(m));
  const errSpy = spyOn(console, "error").mockImplementation((m: string) => void lines.push(m));
  let now = 0;
  attachGatewayWatch(em, fakeConnector().c, () => now);
  for (let i = 0; i < 120; i++) { now += 500; em.emit("shardReconnecting", 0); em.emit("shardError", new Error("Failed to connect"), 0); }
  now += SHARD_LOG_EVERY_MS;
  em.emit("shardReconnecting", 0);
  logSpy.mockRestore(); errSpy.mockRestore();
  const re = lines.filter((l) => l.includes("reconnecting"));
  expect(re.length).toBe(2);
  expect(re[1]).toContain("此前同类 119 条已省略");
  expect(lines.filter((l) => l.includes("error")).length).toBe(1);
});

test("bindFirstReady：ready 触发多次（断开再恢复）只初始化一次", async () => {
  const em = new EventEmitter();
  let n = 0;
  bindFirstReady(em as never, async () => { n++; });
  em.emit("ready"); em.emit("ready"); em.emit("ready");
  await flush();
  expect(n).toBe(1);
});

test("gatewayConnected：按 shard 状态判断，没有 shard 不算在线", () => {
  const shards = (st: number[]) => ({ ws: { shards: { size: st.length, every: (fn: (s: { status: number }) => boolean) => st.every((status) => fn({ status })) } } });
  expect(gatewayConnected(shards([]))).toBe(false);
  expect(gatewayConnected(shards([0]))).toBe(true);
  expect(gatewayConnected(shards([0, 1]))).toBe(false);
});
