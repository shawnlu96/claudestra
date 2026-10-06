import { afterEach, describe, expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnAdapter, type AdapterProc } from "../src/lib/acp/adapter-proc.ts";
import { AcpHost } from "../src/lib/acp/host.ts";
import { startToolProxy } from "../src/lib/acp/tool-proxy.ts";

// Codex 的 /compact 完成信号（docs/runtimes/codex-acp.md「压缩完成信号」）：真的 AcpHost + 真的 stub 子进程，走宿主收 slash →
// 命令槽独占一轮 session/prompt → stub 按 codex-acp 2.1.1 的形状发更新 → 宿主翻条目 → 「bridge」收 acp_entries / Stop。
// 只有 bridge 连接和 /hook 是假的。同步全靠事件（回执、条目、Stop 上报），不睡固定时长。

const REPO = join(import.meta.dir, "..");
const until = async (cond: () => boolean, what: string, ms = 15_000) => {
  for (const end = Date.now() + ms; !cond(); await new Promise((r) => setTimeout(r, 20))) if (Date.now() > end) throw new Error(`等不到：${what}`);
};

/** 压缩开始的条目：声明了 compaction 能力是进度句，没声明是「Compact conversation」工具调用（stub 两种形状都照 codex-acp） */
const started = (e: any) => /正在压缩上下文|Compact conversation/.test(JSON.stringify(e.message?.content ?? []));

let host: AcpHost | null = null;
const procs: AdapterProc[] = [];
afterEach(() => {
  host?.stop();
  host = null;
  for (const p of procs.splice(0)) p.stop();
});

/** 起宿主接 stub；返回「bridge」看到的帧和 Stop 上报 */
function boot() {
  const frames: any[] = [];
  const stops: any[] = [];
  let onFrame: (m: any) => void = () => {};
  let ready = false;
  const entries = () => frames.filter((f) => f.type === "acp_entries").flatMap((f) => f.entries);
  const boundaries = () => entries().filter((e) => e.type === "system" && e.subtype === "compact_boundary");
  const env = { base: { ...process.env }, bunBin: process.execPath, channelServer: join(REPO, "src/channel-server.ts"), mcpName: "claudestra", logsDir: tmpdir() };
  host = new AcpHost(
    {
      channelId: "local-acp-compact", agentName: "agent-acp-compact", sessionId: "019a0000-0000-7000-8000-0000000c0a1d", cwd: REPO, mcpName: "claudestra",
      agentCmd: [process.execPath, join(REPO, "scripts/acp-stub.ts")], env,
    },
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
      postHook: async (b) => (stops.push({ ...b, boundariesAtStop: boundaries().length }), {}), // 报 Stop 那一刻 bridge 已收到几条边界
      markReady: async () => void (ready = true),
      rotateSession: async () => ({ ok: true }),
      log: () => {},
    },
  );
  host.start();
  const slash = async (text: string) => {
    await until(() => ready, "宿主就绪");
    onFrame({ type: "acp_call", id: "c1", op: "slash", text });
    await until(() => frames.some((f) => f.type === "acp_call_result" && f.id === "c1"), "slash 回执");
    return frames.find((f) => f.type === "acp_call_result" && f.id === "c1");
  };
  return { stops, entries, boundaries, slash, frame: (m: any) => onFrame(m) };
}

describe("Codex /compact 完成信号 → compact_boundary（stub）", () => {
  test("compact-ok：压缩真的结束才出一次边界，且在 Stop 之前送到 bridge", async () => {
    const h = boot();
    expect(await h.slash("/compact")).toEqual({ channelId: "local-acp-compact", type: "acp_call_result", id: "c1", ok: true });
    await until(() => h.stops.length === 1, "Stop 上报");
    expect(h.stops[0]).toMatchObject({ event: "Stop", boundariesAtStop: 1 });
    expect(h.boundaries()).toEqual([{ type: "system", subtype: "compact_boundary", timestamp: expect.any(String), compactMetadata: { trigger: "manual" } }]);
  }, 20_000);

  test("同一次压缩的完成信号重复到达：只出一次边界", async () => {
    const h = boot();
    await h.slash("/compact [stub:compact-dup]");
    await until(() => h.stops.length === 1, "Stop 上报");
    expect(h.boundaries()).toHaveLength(1);
  }, 20_000);

  test("compact-fail：按 StopFailure 收尾，不出成功边界", async () => {
    const h = boot();
    await h.slash("/compact [stub:compact-fail]");
    await until(() => h.stops.length === 1, "Stop 上报");
    expect(h.stops[0]).toMatchObject({ event: "StopFailure" });
    expect(h.boundaries()).toEqual([]);
  }, 20_000);

  test("compact-slow：受理了、压缩开始了都不算完成；中途取消也不出边界", async () => {
    const h = boot();
    expect((await h.slash("/compact [stub:compact-slow]")).ok).toBe(true);
    await until(() => h.entries().some(started), "压缩开始的更新"); // stub 先报开始再等取消：此刻压缩在途、没结束
    expect(h.boundaries()).toEqual([]);
    expect(h.stops).toEqual([]);
    h.frame({ type: "abort", id: "a1" });
    await until(() => h.stops.length === 1, "Stop 上报");
    expect(h.stops[0]).toMatchObject({ event: "StopFailure", interrupt: true });
    expect(h.boundaries()).toEqual([]);
  }, 20_000);

  test("普通回合照旧：没有压缩就没有边界", async () => {
    const h = boot();
    await h.slash("/status");
    await until(() => h.stops.length === 1, "Stop 上报");
    expect(h.stops[0]).toMatchObject({ event: "Stop" });
    expect(h.entries().some((e) => e.type === "assistant")).toBe(true);
    expect(h.boundaries()).toEqual([]);
  }, 20_000);
});
