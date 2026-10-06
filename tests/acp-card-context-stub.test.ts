import { afterEach, describe, expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnAdapter, type AdapterProc } from "../src/lib/acp/adapter-proc.ts";
import { AcpHost } from "../src/lib/acp/host.ts";
import { startToolProxy } from "../src/lib/acp/tool-proxy.ts";

// CTXA 整条宿主链：真的 AcpHost + 真的 stub 子进程（scripts/acp-stub.ts，照 codex-acp 报 usage_update / compaction_update）。
// bridge 连接、/hook、时钟是假的；线用 limits 压低到 stub 报得出的 usage（stub 一轮报 1234 + 正文长度）。不调模型、不碰生产。

const REPO = join(import.meta.dir, "..");
const SID = "019a0000-0000-7000-8000-0000000c7a00";
const until = async (cond: () => boolean, what: string, ms = 15_000) => {
  for (const end = Date.now() + ms; !cond(); await new Promise((r) => setTimeout(r, 20))) if (Date.now() > end) throw new Error(`等不到：${what}`);
};

let host: AcpHost | null = null;
const procs: AdapterProc[] = [];
afterEach(() => {
  host?.stop();
  host = null;
  for (const p of procs.splice(0)) p.stop();
});

function boot(cardContext: any) {
  const frames: any[] = [];
  const stops: any[] = [];
  let onFrame: (m: any) => void = () => {};
  let ready = false;
  let clock = 5_000_000;
  const env = { base: { ...process.env }, bunBin: process.execPath, channelServer: join(REPO, "src/channel-server.ts"), mcpName: "claudestra", logsDir: tmpdir() };
  host = new AcpHost(
    { channelId: "local-acp-card", agentName: "agent-acp-card", sessionId: SID, cwd: REPO, mcpName: "claudestra",
      agentCmd: [process.execPath, join(REPO, "scripts/acp-stub.ts")], env, cardContext },
    {
      spawn: (cmd, e, cwd) => (procs.push(spawnAdapter(cmd, e, cwd, () => {})), procs[procs.length - 1]!),
      makeLink: (d) => ((onFrame = d.onFrame), {
        connect: () => void setTimeout(() => d.onRegistered(), 0),
        send: (f: any) => (frames.push(f), true),
        request: async (f: any) => (frames.push(f), f.type === "acp_entries" ? true : null),
        close: () => {},
        up: true,
      }) as any,
      startProxy: (d) => startToolProxy(d),
      postHook: async (b) => (stops.push(b), {}),
      markReady: async () => void (ready = true),
      rotateSession: async () => ({ ok: true }),
      log: () => {},
      now: () => clock,
    },
  );
  host.start();
  let n = 0;
  const call = async (body: Record<string, unknown>) => {
    const id = `card${++n}`;
    onFrame({ type: "acp_call", id, ...body });
    await until(() => frames.some((f) => f.type === "acp_call_result" && f.id === id), `回执 ${id}`);
    return frames.find((f) => f.type === "acp_call_result" && f.id === id);
  };
  const inbound = (content: string) => onFrame({ type: "message", content, meta: { chat_id: "api:owner", message_id: `m${++n}` } });
  const boundaries = () => frames.filter((f) => f.type === "acp_entries").flatMap((f) => f.entries).filter((e: any) => e.subtype === "compact_boundary");
  return { stops, call, inbound, boundaries, ready: () => ready, advance: (ms: number) => (clock += ms) };
}

const identity = (st: any) => ({ card: "CTXA", expectedSessionId: st.sessionId, hostId: st.hostId, attachGen: st.attachGen, turnGen: st.turnGen, slotGen: st.slotGen });

describe("CTXA 卡片压缩（真宿主 + stub）", () => {
  test("闲置线：闲置不满 3 分钟拒；满了受理，真的压缩完成后按 opId 查得到 done + compacted；旧 hostId 拒", async () => {
    const h = boot({ card: "CTXA", expectedSessionId: SID, mode: "on", limits: { idle: 1_000, hard: 100_000 } });
    await until(h.ready, "宿主就绪");
    h.inbound("hello");
    await until(() => h.stops.length === 1, "第一轮 Stop");
    const st = (await h.call({ op: "card_context" })).status;
    expect(st).toMatchObject({ cap: "card_compact_v1", mode: "on", sessionId: SID, usage: { state: "fresh" }, verdict: { ok: false, reason: "idle-wait" } });
    expect(await h.call({ op: "card_compact", opId: "early", ...identity(st) })).toMatchObject({ ok: false, reason: "idle-wait" });
    h.advance(3 * 60_000);
    expect(await h.call({ op: "card_compact", opId: "stale-host", ...identity(st), hostId: "000000000000" })).toMatchObject({ ok: false, reason: "old-host" });
    expect(await h.call({ op: "card_compact", opId: "go", ...identity(st) })).toMatchObject({ ok: true, accepted: true, kind: "idle" });
    await until(() => h.stops.length === 2, "压缩那一轮 Stop");
    expect(h.boundaries()).toHaveLength(1);
    expect((await h.call({ op: "card_context", opId: "go" })).status.op).toMatchObject({ opId: "go", outcome: "done", compacted: true });
    expect(await h.call({ op: "card_compact", opId: "go", ...identity(st) })).toMatchObject({ ok: true, duplicate: true }); // 不重放
    expect(h.stops).toHaveLength(2);
  }, 30_000);

  test("硬线：on 模式下一轮前先压缩一次，再开这一轮", async () => {
    const h = boot({ card: "CTXA", expectedSessionId: SID, mode: "on", limits: { idle: 1_000, hard: 1_000 } });
    await until(h.ready, "宿主就绪");
    h.inbound("first");
    await until(() => h.stops.length === 1, "第一轮 Stop");
    h.inbound("second");
    await until(() => h.stops.length === 3, "压缩 + 第二轮 Stop");
    expect(h.boundaries()).toHaveLength(1);
  }, 30_000);

  test("没有卡片身份 / 启动会话不一致：no-capability / startup-mismatch；默认 observe 不动会话", async () => {
    const none = boot(undefined);
    await until(none.ready, "宿主就绪");
    const st = (await none.call({ op: "card_context" })).status;
    expect(st).toMatchObject({ mode: "observe", card: null, verdict: { ok: false, reason: "no-capability" } });
    host!.stop();
    for (const p of procs.splice(0)) p.stop();
    const bad = boot({ card: "CTXA", expectedSessionId: "019a-boot-other" });
    await until(bad.ready, "宿主就绪");
    const st2 = (await bad.call({ op: "card_context" })).status;
    expect(await bad.call({ op: "card_compact", opId: "x", ...identity(st2) })).toMatchObject({ ok: false, reason: "startup-mismatch" });
  }, 30_000);
});
