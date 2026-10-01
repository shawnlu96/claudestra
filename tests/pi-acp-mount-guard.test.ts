/**
 * 挂 channel-server 的会话起之前 / 起之后的闸（#300 r1 P1-3）：配置可能在等旧 pi 退出时才出现，也可能在适配器复查之后、
 * pi 读 mcp.json 之前出现。三道闸：closePi 前查、closePi 后再查、pi 里的挂载扩展在 session_start 报的状态（与 pi 读配置同一刻）。
 * 任何一道不过：session/new 失败；旧会话已经停掉的，错误带 previousSessionClosed，宿主据此重起接回旧会话（clear.ts）。
 */
import { describe, expect, test } from "bun:test";
import { MOUNT_OK, MOUNT_STATUS_KEY } from "../src/lib/acp/pi-adapter/mcp-mount.ts";
import { piLinkOver, type PiProc } from "../src/lib/acp/pi-adapter/pi-link.ts";
import { PiAcpServer } from "../src/lib/acp/pi-adapter/server.ts";
import { createRpcPeer, RpcError, type RpcWire } from "../src/lib/acp/rpc.ts";

type Rec = Record<string, any>;
const SERVERS = [{ name: "claudestra", command: "/bin/x", args: [], env: [] }];

function pipePair(): [RpcWire, RpcWire] {
  const side = () => ({ data: (_: string) => {}, close: (_: string) => {} });
  const a = side(), b = side();
  const wire = (me: ReturnType<typeof side>, peer: ReturnType<typeof side>): RpcWire => ({
    write: (line) => peer.data(line), onData: (cb) => void (me.data = cb as (c: string) => void), onClose: (cb) => void (me.close = cb),
    close: (why) => (peer.close(why), me.close(why)),
  });
  return [wire(a, b), wire(b, a)];
}

/** 假 pi：先报挂载状态（status 为 null 就不报，像挂载扩展没加载上），再应答启动查询 */
function fakePi(status: string | null, stops: string[], name: string): PiProc {
  let onData: (c: string) => void = () => {};
  let exit!: (n: number) => void;
  const closeCbs: ((why: string) => void)[] = [];
  let sent = false;
  const emit = (r: Rec) => onData(`${JSON.stringify(r)}\n`);
  return {
    wire: {
      write(line) {
        if (!sent && status !== null) emit({ type: "extension_ui_request", id: "m", method: "setStatus", statusKey: MOUNT_STATUS_KEY, statusText: status });
        sent = true;
        const c = JSON.parse(line);
        emit({ id: c.id, type: "response", command: c.type, success: true, data: c.type === "get_state" ? { thinkingLevel: "off" } : {} });
      },
      onData: (cb) => void (onData = cb as (c: string) => void),
      onClose: (cb) => void closeCbs.push(cb),
      close: () => {},
    },
    stop: () => (stops.push(name), closeCbs.splice(0).forEach((cb) => cb("exit 0")), exit(0)),
    exited: new Promise((r) => (exit = r)),
  };
}

function harness(statuses: (string | null)[], problem: () => string | null = () => null) {
  const [host, adapter] = pipePair();
  const stops: string[] = [];
  let n = 0;
  new PiAcpServer(adapter, {
    openPi: () => piLinkOver(fakePi(n < statuses.length ? (statuses[n] as string | null) : MOUNT_OK, stops, `pi${++n}`), () => {}),
    newSessionId: () => `s${n + 1}`, mountProblem: () => problem(), log: () => {}, exit: () => {},
  });
  const rpc = createRpcPeer(host, { log: () => {} });
  const open = () => rpc.request<Rec>("session/new", { cwd: "/w", mcpServers: SERVERS }, { timeoutMs: 2_000 }).then((r) => ({ ok: r.sessionId }), (e: RpcError) => ({ err: e.message, data: e.data }));
  const prompt = (sessionId: string) => rpc.request<Rec>("session/prompt", { sessionId, prompt: [] }, { timeoutMs: 2_000 }).catch((e: Error) => e.message);
  return { open, prompt, stops, opened: () => n };
}

describe("挂载闸", () => {
  test("等旧 pi 退出期间配置变了：closePi 后复查拒，新 pi 不起，错误带 previousSessionClosed", async () => {
    let calls = 0; // 第一次起查两次（前 / 后）；第二次起的第一道（closePi 前）还干净，旧 pi 退出期间写进了同名配置
    const h = harness([], () => (++calls >= 4 ? "…/mcp.json 里有名为「claudestra」的 MCP server，会顶掉…" : null));
    expect(await h.open()).toEqual({ ok: "s1" });
    expect(await h.open()).toEqual({ err: expect.stringContaining("顶掉"), data: { previousSessionClosed: true } });
    expect(calls).toBe(4);
    expect(h.opened()).toBe(1);
    expect(await h.prompt("s1")).toContain("还没有会话"); // 适配器手上已经没有会话，宿主要重起接回
  });

  test("复查之后、pi 读配置那一刻才出现：挂载扩展报的撞名让 session/new 失败，新 pi 被停掉", async () => {
    const h = harness([MOUNT_OK, "…/mcp.json 里有名为「claudestra」的 MCP server，会顶掉…"]);
    expect(await h.open()).toEqual({ ok: "s1" });
    expect(await h.open()).toEqual({ err: expect.stringContaining("顶掉"), data: { previousSessionClosed: true } });
    expect(h.stops).toEqual(["pi1", "pi2"]);
  });

  test("挂了 server 却没报挂载状态（扩展没加载上）也拒；第一次起没有旧会话可接回，不带 previousSessionClosed", async () => {
    const h = harness([null]);
    expect(await h.open()).toEqual({ err: expect.stringContaining("没有报挂载状态"), data: undefined });
    expect(h.stops).toEqual(["pi1"]);
  });

  test("第一道闸（closePi 前）拒时旧会话不动", async () => {
    let clash: string | null = null;
    const h = harness([], () => clash);
    await h.open();
    clash = "撞名";
    expect(await h.open()).toEqual({ err: "撞名", data: undefined });
    expect(h.stops).toEqual([]);
    expect(h.opened()).toBe(1);
  });
});
