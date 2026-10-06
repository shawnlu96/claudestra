import { afterEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { spawnAdapter, type AdapterProc } from "../src/lib/acp/adapter-proc.ts";
import type { BridgeLinkDeps } from "../src/lib/acp/bridge-link.ts";
import { AdapterPick } from "../src/lib/acp/codex-compat-switch.ts";
import { AcpHost } from "../src/lib/acp/host.ts";
import { startToolProxy } from "../src/lib/acp/tool-proxy.ts";
import type { StopReport } from "../src/lib/acp/turn.ts";

// 宿主的「自研起不来退上游」：真 AcpHost + 真 stub 子进程当「上游」，「自研」是起来就退 / 协议不兼容 / 能接上的 stub。
// 只有 bridge 连接和 /hook 是假的。stub 的回合和 tests/acp-host.test.ts 同一个（scripts/acp-stub.ts）。

const REPO = join(import.meta.dir, "..");
const STUB = [process.execPath, join(REPO, "scripts/acp-stub.ts")];
const SID = "019a0000-0000-7000-8000-00000000cafe";
const until = async (cond: () => boolean, ms = 20_000) => {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error("等超时");
    await new Promise((r) => setTimeout(r, 25));
  }
};

let host: AcpHost | null = null;
const procs: AdapterProc[] = [];
afterEach(() => {
  host?.stop();
  host = null;
  for (const p of procs.splice(0)) p.stop();
});

/** self：「自研」的命令；selfEnv：只给「自研」那一份子进程加的环境（模拟它自己的毛病） */
function start(self: string[], selfEnv: Record<string, string> = {}, upstream: string[] | null = STUB) {
  const logs: string[] = [];
  const sent: any[] = [];
  const stops: StopReport[] = [];
  const spawned: string[][] = [];
  let link!: Omit<BridgeLinkDeps, "url">;
  let ready = false;
  const pick = new AdapterPick("self", self, upstream, (m) => logs.push(m));
  host = new AcpHost(
    {
      channelId: "local-switch-test", agentName: "agent-switch-test", sessionId: SID, cwd: REPO, mcpName: "claudestra", agentCmd: pick.cmd,
      env: { base: { ...process.env }, bunBin: process.execPath, channelServer: join(REPO, "src/channel-server.ts"), mcpName: "claudestra", logsDir: "/tmp" },
    },
    {
      spawn: (cmd, env, cwd) => {
        spawned.push(cmd);
        const p = spawnAdapter(cmd, cmd === self ? { ...env, ...selfEnv } : env, cwd, (m) => logs.push(m));
        procs.push(p);
        return p;
      },
      fallback: (why, kind) => pick.fallback(why, kind),
      makeLink: (d) => {
        link = d;
        return {
          connect: () => void setTimeout(() => d.onRegistered(), 0),
          send: (f: any) => {
            sent.push(f);
            if (f.type === "reply") setTimeout(() => link.onFrame({ type: "response", requestId: f.requestId, result: { messageIds: ["m1"] } }), 0);
            return true;
          },
          request: async (f: any) => (f.type === "acp_entries" ? true : null),
          close: () => {},
          up: true,
        } as any;
      },
      startProxy: (d) => startToolProxy(d),
      postHook: async (b) => (stops.push(b), {}),
      markReady: async () => void (ready = true),
      rotateSession: async () => ({ ok: true }),
      log: (m) => logs.push(m),
    },
  );
  host.start();
  const inbound = (content: string) => link.onFrame({ type: "message", content, meta: { chat_id: "api:owner", message_id: `m${Date.now()}` } });
  return { logs, sent, stops, spawned, pick, inbound, isReady: () => ready };
}

describe("宿主：自研起不来退回上游（故障竞争）", () => {
  test("自研一起来就退出：换上游接回同一线程、标就绪，不出失败卡；之后的回合照常", async () => {
    const h = start([process.execPath, "-e", "process.exit(3)"]);
    h.inbound("先到的消息"); // 自研还在起、起不来、换上游的整个过程里先到的入站：等会话，不丢、不按失败收尾
    await until(h.isReady);
    expect(h.spawned).toEqual([[process.execPath, "-e", "process.exit(3)"], STUB]);
    expect(h.pick.adapter).toBe("upstream");
    expect(h.logs.some((l) => l.includes("改用上游 codex-acp"))).toBe(true);
    await until(() => h.stops.length === 1);
    expect(h.stops[0]!.event).toBe("Stop");
    expect(h.sent.filter((f) => f.type === "acp_failure")).toEqual([]);
  }, 45_000);

  test("自研协议不兼容（initialize 被拒，本来会「不再重起」）：同样换上游，不卡在拒起", async () => {
    const h = start(STUB.slice(), { STUB_INITIALIZE: JSON.stringify({ protocolVersion: 2 }) });
    await until(h.isReady);
    expect(h.spawned).toHaveLength(2);
    expect(h.spawned[1]).toBe(STUB);
    expect(h.logs.some((l) => l.includes("不再重起"))).toBe(false);
    h.inbound("在吗");
    await until(() => h.stops.length === 1);
    expect(h.stops[0]!.event).toBe("Stop");
  }, 45_000);

  test("没装上游：自研起不来就照旧（协议不兼容 = 拒起一张卡），不会凭空起别的", async () => {
    const h = start(STUB.slice(), { STUB_INITIALIZE: JSON.stringify({ protocolVersion: 2 }) }, null);
    await until(() => h.sent.some((f) => f.type === "acp_failure"));
    await until(() => h.logs.some((l) => l.includes("协议不兼容，不再重起")));
    expect(h.spawned).toHaveLength(1);
    expect(h.logs.some((l) => l.includes("没装上游"))).toBe(true);
  }, 45_000);

  test("自研接上之后被杀（app-server 崩溃把适配器带走）：退避后重起的还是自研，接回同一线程——崩溃不等于起不来", async () => {
    const self = STUB.slice();
    const h = start(self);
    await until(h.isReady);
    h.inbound("[stub:slow] 慢慢来");
    await until(() => h.logs.some((l) => l.includes("已接上线程")));
    await Bun.sleep(300);
    procs[0]!.stop();
    await until(() => h.stops.length === 1);
    expect(h.stops[0]!.event).toBe("StopFailure");
    await until(() => h.spawned.length === 2 && h.logs.filter((l) => l.includes("已接上线程")).length === 2);
    expect(h.spawned[1]).toBe(self);
    expect(h.pick.adapter).toBe("self");
    h.inbound("回来了吗");
    await until(() => h.stops.length === 2);
    expect(h.stops[1]!.event).toBe("Stop");
  }, 60_000);
});
