import { describe, expect, test } from "bun:test";
import { sendBridgeOob, type OobEvent, type OobIo } from "../src/lib/bridge-watchdog-oob.ts";
import type { ExecResult, SideMode } from "../src/lib/bridge-watchdog-diag.ts";

const TOKEN = "FAKE-TOKEN.bwd2.do-not-leak-0123456789";
const CHANNEL = "123456789012345678";
const T0 = Date.UTC(2026, 9, 13, 20, 48, 35);
const STUCK: OobEvent = { kind: "stuck", reason: "api", lastOkAt: T0 - 60_000, startedAt: T0, watchdogMode: "on", diagDir: "bridge-stuck-20261013T204835Z" };
const RECOVERED: OobEvent = { ...STUCK, kind: "recovered" };

interface Opts {
  mode?: SideMode;
  platform?: string;
  discord?: boolean;
  fetch?: OobIo["fetch"];
  exec?: (cmd: string[]) => Promise<ExecResult>;
  host?: string;
}

function fakeIo(opts: Opts = {}) {
  const calls = { fetch: [] as { url: string; init: RequestInit }[], exec: [] as string[][], log: [] as string[] };
  const io: OobIo = {
    mode: () => opts.mode ?? "on",
    platform: opts.platform ?? "darwin",
    discord: () => (opts.discord === false ? { token: "", channelId: "" } : { token: TOKEN, channelId: CHANNEL }),
    hostname: () => opts.host ?? "sekai-mini.corp.example.com",
    fetch: async (url, init) => {
      calls.fetch.push({ url, init });
      return opts.fetch ? opts.fetch(url, init) : { ok: true, status: 200 };
    },
    exec: async (cmd) => {
      calls.exec.push(cmd);
      return opts.exec ? opts.exec(cmd) : { ok: true, out: "" };
    },
    log: (l) => void calls.log.push(l),
  };
  /** token 只许出现在请求头：日志、URL、请求体、命令参数都不许有 */
  const leaked = () => [...calls.log, ...calls.exec.flat(), ...calls.fetch.flatMap((f) => [f.url, String(f.init.body)])].filter((s) => s.includes(TOKEN));
  return { io, calls, leaked };
}

const bodyOf = (init: RequestInit) => JSON.parse(String(init.body)) as { content: string; allowed_mentions: unknown };

describe("带外通知：路由", () => {
  test("有 Discord 配置走 REST 发到控制频道，不发系统通知", async () => {
    const { io, calls, leaked } = fakeIo();
    await sendBridgeOob(STUCK, io);
    expect(calls.fetch.length).toBe(1);
    expect(calls.exec.length).toBe(0);
    expect(calls.fetch[0]!.url).toBe(`https://discord.com/api/v10/channels/${CHANNEL}/messages`);
    expect(calls.fetch[0]!.init.method).toBe("POST");
    expect((calls.fetch[0]!.init.headers as Record<string, string>).Authorization).toBe(`Bot ${TOKEN}`);
    expect(bodyOf(calls.fetch[0]!.init).allowed_mentions).toEqual({ parse: [] });
    expect(leaked()).toEqual([]);
  });

  test("没有 Discord 配置：darwin 发系统通知（正文走 argv），不调 REST", async () => {
    const { io, calls } = fakeIo({ discord: false });
    await sendBridgeOob(STUCK, io);
    expect(calls.fetch.length).toBe(0);
    expect(calls.exec.length).toBe(1);
    const cmd = calls.exec[0]!;
    expect(cmd[0]).toBe("osascript");
    expect(cmd.join(" ")).toContain("display notification (item 1 of argv)");
    expect(cmd.at(-1)).toContain("bridge 卡住");
    expect(cmd.slice(0, -1).join(" ")).not.toContain("bridge 卡住"); // 正文不拼进脚本源码
  });

  test("只配了 token 没配频道也按没有 Discord 配置走", async () => {
    const { io, calls, leaked } = fakeIo();
    io.discord = () => ({ token: TOKEN, channelId: "" });
    await sendBridgeOob(STUCK, io);
    expect(calls.fetch.length).toBe(0);
    expect(calls.exec.length).toBe(1);
    expect(leaked()).toEqual([]);
  });

  test("没有 Discord 配置且非 darwin：只记日志", async () => {
    const { io, calls } = fakeIo({ discord: false, platform: "linux" });
    await sendBridgeOob(STUCK, io);
    expect(calls.fetch.length).toBe(0);
    expect(calls.exec.length).toBe(0);
    expect(calls.log.length).toBe(1);
    expect(calls.log[0]).toContain("只记日志");
  });
});

describe("带外通知：三档", () => {
  test("observe 只记本会发什么，不调 REST 也不调命令", async () => {
    for (const discord of [true, false]) {
      const { io, calls, leaked } = fakeIo({ mode: "observe", discord });
      await sendBridgeOob(STUCK, io);
      expect(calls.fetch.length).toBe(0);
      expect(calls.exec.length).toBe(0);
      expect(calls.log.length).toBe(1);
      expect(calls.log[0]).toContain("本会发");
      expect(calls.log[0]).toContain("bridge 卡住");
      expect(leaked()).toEqual([]);
    }
  });

  test("off 完全不调", async () => {
    const { io, calls } = fakeIo({ mode: "off" });
    await sendBridgeOob(STUCK, io);
    await sendBridgeOob(RECOVERED, io);
    expect(calls.fetch.length + calls.exec.length + calls.log.length).toBe(0);
  });
});

describe("带外通知：文本与 token", () => {
  test("文本带机器短名、原因、最后一次正常、看门狗档位、现场目录；不带主机全名", async () => {
    const { io, calls } = fakeIo();
    await sendBridgeOob(STUCK, io);
    await sendBridgeOob({ ...RECOVERED, reason: "relay", watchdogMode: "observe", diagDir: null }, io);
    const [stuck, recovered] = calls.fetch.map((f) => bodyOf(f.init).content);
    for (const part of ["[sekai-mini]", "本机接口连续无响应", new Date(T0 - 60_000).toISOString(), "看门狗档位：on", "bridge-stuck-20261013T204835Z"]) {
      expect(stuck).toContain(part);
    }
    for (const part of ["[sekai-mini]", "恢复正常", "中继长时间未连上", "看门狗档位：observe", "现场：无"]) expect(recovered).toContain(part);
    for (const text of [stuck!, recovered!]) {
      expect(text).not.toContain("corp.example.com");
      expect(text).not.toContain(TOKEN);
      expect(text).not.toMatch(/\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}/);
    }
  });

  test("REST 报错 / 非 2xx：只记一行，不抛；错误文本里的 token 被抹掉", async () => {
    const thrown = fakeIo({ fetch: async () => { throw new Error(`connect failed for Authorization: Bot ${TOKEN}`); } });
    await sendBridgeOob(STUCK, thrown.io);
    expect(thrown.calls.log.length).toBe(1);
    expect(thrown.calls.log[0]).toContain("Discord REST 失败");
    expect(thrown.leaked()).toEqual([]);
    const http = fakeIo({ fetch: async () => ({ ok: false, status: 401 }) });
    await sendBridgeOob(STUCK, http.io);
    expect(http.calls.log[0]).toContain("HTTP 401");
    expect(http.leaked()).toEqual([]);
  });

  test("系统通知失败、取环境抛错都不抛", async () => {
    const a = fakeIo({ discord: false, exec: async () => ({ ok: false, error: "exit 1" }) });
    await sendBridgeOob(STUCK, a.io);
    expect(a.calls.log[0]).toContain("系统通知失败");
    const b = fakeIo();
    b.io.hostname = () => { throw new Error("no hostname"); };
    await sendBridgeOob(STUCK, b.io);
    expect(b.calls.log[0]).toContain("带外通知失败");
    expect(b.leaked()).toEqual([]);
  });
});
