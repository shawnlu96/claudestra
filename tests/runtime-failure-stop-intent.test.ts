/**
 * LKN-1：本机主动收 worker（出借结单 / 撤单 / 回收、manager kill）时关窗口，SIGHUP 让 ACP 适配器先退，在途回合按失败收尾。
 * 这不是故障：宿主认出「正在被收」（registry 已置 stopped）就只记一行，不发 acp_failure（bridge 的「回合失败」/「要不要重发」卡），
 * 也不写 isApiErrorMessage 条目（bridge 的 60s 自动续跑）。没被收时适配器照样崩就照旧报。
 */
import { afterEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { spawnAdapter, type AdapterProc } from "../src/lib/acp/adapter-proc.ts";
import { AcpHost } from "../src/lib/acp/host.ts";
import { startToolProxy } from "../src/lib/acp/tool-proxy.ts";
import { runKill } from "../src/manager/agent-kill";
import { makeWorld } from "./resumable-world";

const REPO = join(import.meta.dir, "..");
const wait = async (ok: () => boolean, ms = 15_000) => {
  for (const end = Date.now() + ms; !ok(); await Bun.sleep(25)) if (Date.now() > end) throw new Error("等超时");
};

let host: AcpHost | null = null;
const adapters: AdapterProc[] = [];
afterEach(() => {
  host?.stop();
  host = null;
  adapters.splice(0).forEach((p) => p.stop());
});

/** 真宿主 + 真 stub 适配器，bridge 连接是假的；stopIntended 由用例给 */
function hostWith(stopIntended: () => boolean) {
  const frames: any[] = [];
  const logs: string[] = [];
  let onFrame!: (f: Record<string, any>) => void;
  let ready = false;
  host = new AcpHost({
    channelId: "local-lkn1", agentName: "agent-lend-lkn1", sessionId: "019a0000-0000-7000-8000-0000000c0de1", cwd: REPO, mcpName: "claudestra",
    agentCmd: [process.execPath, join(REPO, "scripts/acp-stub.ts")],
    env: { base: process.env, bunBin: process.execPath, channelServer: join(REPO, "src/channel-server.ts"), mcpName: "claudestra", logsDir: "/tmp" },
  }, {
    spawn: (cmd, env, cwd) => { const p = spawnAdapter(cmd, env, cwd, (m) => logs.push(m)); adapters.push(p); return p; },
    makeLink: (d) => {
      onFrame = d.onFrame;
      return { connect: () => void setTimeout(() => d.onRegistered(), 0), send: (f: any) => (frames.push(f), true),
        request: async (f: any) => (frames.push(f), f.type === "acp_entries" ? true : null), close: () => {}, up: true } as any;
    },
    startProxy: (d) => startToolProxy(d),
    postHook: async () => ({}),
    markReady: async () => void (ready = true),
    rotateSession: async () => ({ ok: true }),
    log: (m) => logs.push(m),
    stopIntended,
  });
  host.start();
  /** 进一轮慢回合，等它跑到工具调用，再像关窗口那样把适配器杀掉 */
  const killMidTurn = async () => {
    await wait(() => ready);
    onFrame({ type: "message", content: "[stub:slow] 慢慢来", meta: { chat_id: "api:owner", message_id: "m1" } });
    await wait(() => frames.some((f) => f.type === "acp_entries" && f.entries.some((e: any) => e.message?.content?.[0]?.name === "Bash")));
    adapters[0]!.stop();
    await adapters[0]!.exited;
    await Bun.sleep(300);
  };
  const failures = () => frames.filter((f) => f.type === "acp_failure");
  const apiErrors = () => frames.filter((f) => f.type === "acp_entries").flatMap((f) => f.entries).filter((e: any) => e.isApiErrorMessage === true);
  return { killMidTurn, failures, apiErrors, logs };
}

describe("LKN-1 主动收 worker 时中断的回合", () => {
  test("registry 已置 stopped（正在被收）：不出失败卡、不写续跑条目，只记一行", async () => {
    const h = hostWith(() => true);
    await h.killMidTurn();
    expect(h.failures()).toEqual([]);
    expect(h.apiErrors()).toEqual([]);
    expect(h.logs.some((l) => l.startsWith("本机在收这个 agent：回合中断不报失败"))).toBe(true);
  }, 30_000);

  test("对照：没有收 worker 的意图，适配器自己退出照旧报失败（卡 + 续跑条目）", async () => {
    const h = hostWith(() => false);
    await h.killMidTurn();
    await wait(() => h.failures().length > 0);
    expect(h.failures()[0].failure).toMatchObject({ kind: "error" });
    expect(h.logs.some((l) => l.startsWith("本机在收这个 agent"))).toBe(false);
  }, 30_000);

  test("出借结单收 worker 走 manager kill：关窗口那一刻 registry 已是 stopped（宿主据此认）", async () => {
    const name = "agent-lend-lkn1";
    const entry = { project: "/p", purpose: "lend", created: "t0", status: "active" as const, channelId: "ch1", notes: "", cwd: "/p", sessionId: "s1" };
    const w = makeWorld({ reg: { socket: "s", agents: { [name]: entry } }, windows: [name] });
    const seen: (string | undefined)[] = [];
    const kill = w.deps.killWindow;
    w.deps.killWindow = async (n) => { seen.push(w.st.reg.agents[n]?.status); await kill(n); };
    expect(await runKill(name, w.deps)).toMatchObject({ ok: true });
    expect(seen).toEqual(["stopped"]);
  });
});
