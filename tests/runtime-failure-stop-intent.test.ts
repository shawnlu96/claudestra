/**
 * LKN-1：本机主动收 worker（出借结单 / 撤单 / 回收走 manager kill 或 stopRevokedWorkers）时关窗口，SIGHUP 让 ACP 适配器先退（exit 129），
 * 在途回合按失败收尾。这不是故障：registry 已置 stopped、宿主自己也收到停止信号 → 只记一行，不发 acp_failure（bridge 的「回合失败」/
 * 「要不要重发」卡），不写 isApiErrorMessage 条目（bridge 的 60s 自动续跑）。没被收、或 stopped 是关窗没成留下的，适配器崩了照旧报。
 * 真宿主 + 真 stub 适配器 + 临时 registry 文件；收 worker 走真的 runKill / stopRevokedWorkers，窗口由假件模拟（发 SIGHUP）。
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnAdapter, type AdapterProc } from "../src/lib/acp/adapter-proc.ts";
import { AcpHost } from "../src/lib/acp/host.ts";
import { startToolProxy } from "../src/lib/acp/tool-proxy.ts";
import { stopRevokedWorkers } from "../src/lib/lend-grant-spawn.ts";
import { runKill } from "../src/manager/agent-kill";
import type { AgentInfo, Registry } from "../src/manager/core";
import { makeWorld } from "./resumable-world";

const REPO = join(import.meta.dir, "..");
const NAME = "agent-lend-lkn1";
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

const ENTRY: AgentInfo = { project: "/p", purpose: "lend", created: "t0", status: "active", channelId: "ch1", notes: "", cwd: "/p", sessionId: "s1" };
const regFile = (reg: Registry) => {
  const path = join(mkdtempSync(join(tmpdir(), "lkn1-reg-")), "registry.json");
  writeFileSync(path, JSON.stringify(reg));
  return path;
};

/** 真宿主 + 真 stub 适配器，bridge 连接是假的；registry 从 path 读 */
function hostWith(registryPath: string, stopGraceMs = 3_000) {
  const frames: any[] = [];
  const logs: string[] = [];
  const shown: string[] = [];
  let onFrame!: (f: Record<string, any>) => void;
  let ready = false;
  host = new AcpHost({
    channelId: "local-lkn1", agentName: NAME, sessionId: "019a0000-0000-7000-8000-0000000c0de1", cwd: REPO, mcpName: "claudestra",
    agentCmd: [process.execPath, join(REPO, "scripts/acp-stub.ts")], registryPath, timings: { stopGraceMs },
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
    show: (s) => shown.push(s),
  });
  host.start();
  /** 进一轮慢回合，等它跑到工具调用 */
  const midTurn = async () => {
    await wait(() => ready);
    onFrame({ type: "message", content: "[stub:slow] 慢慢来", meta: { chat_id: "api:owner", message_id: "m1" } });
    await wait(() => frames.some((f) => f.type === "acp_entries" && f.entries.some((e: any) => e.message?.content?.[0]?.name === "Bash")));
  };
  /** 关窗口那一下的 SIGHUP 先打到适配器：返回它的退出码，等宿主看到它退出 */
  const hangUpAdapter = async () => {
    process.kill(adapters[0]!.pid!, "SIGHUP");
    const code = await adapters[0]!.exited;
    await wait(() => logs.some((l) => l.includes("适配器退出了")));
    return code;
  };
  const failures = () => frames.filter((f) => f.type === "acp_failure");
  const apiErrors = () => frames.filter((f) => f.type === "acp_entries").flatMap((f) => f.entries).filter((e: any) => e.isApiErrorMessage === true);
  return { midTurn, hangUpAdapter, failures, apiErrors, logs, shown };
}

describe("LKN-1 主动收 worker 时中断的回合", () => {
  test("回归：在途回合走 runKill 收 worker（先置 stopped 再关窗口，SIGHUP、exit 129）：不出卡、不写续跑条目、窗口不显示回合失败", async () => {
    const w = makeWorld({ reg: { socket: "s", agents: { [NAME]: ENTRY } }, windows: [NAME] });
    const path = regFile(w.st.reg);
    const h = hostWith(path);
    const save = w.deps.saveRegistry;
    w.deps.saveRegistry = async (r) => { await save(r); writeFileSync(path, JSON.stringify(r)); };
    let code = -1;
    const close = w.deps.killWindow;
    w.deps.killWindow = async (n) => {
      code = await h.hangUpAdapter();
      await Bun.sleep(200); // 适配器那条先到、宿主的 SIGHUP 稍后：失败此时已经报上来
      host!.stop();
      await close(n);
    };
    await h.midTurn();
    expect(await runKill(NAME, w.deps)).toMatchObject({ ok: true });
    await Bun.sleep(300);
    expect(code).toBe(129);
    expect(h.failures()).toEqual([]);
    expect(h.apiErrors()).toEqual([]);
    expect(h.logs.some((l) => l.startsWith("本机在收这个 agent：回合中断不报失败"))).toBe(true);
    expect(h.shown.some((s) => s.startsWith("❌ 回合失败"))).toBe(false); // 失败行换成中性一行（回合收尾的分隔线照旧）
    expect(h.shown).toContain("⏹ 本机在收这个 agent：回合中断，不算失败");
  }, 30_000);

  test("对照：没有收 worker 的意图（registry 仍 active），适配器 exit 129 照旧报失败", async () => {
    const h = hostWith(regFile({ socket: "s", agents: { [NAME]: ENTRY } }));
    await h.midTurn();
    expect(await h.hangUpAdapter()).toBe(129);
    await wait(() => h.failures().length > 0);
    expect(h.failures()[0].failure).toMatchObject({ kind: "error" });
    expect(h.logs.some((l) => l.startsWith("本机在收这个 agent"))).toBe(false);
  }, 30_000);

  test("对照：撤单关窗没成（unconfirmed，registry 留着 stopped），之后适配器自己 exit 129：宿主没收到停止，过了宽限照旧报", async () => {
    const path = regFile({ socket: "s", agents: { [NAME]: ENTRY } });
    const h = hostWith(path, 300);
    await h.midTurn();
    const report = await stopRevokedWorkers({
      workers: async () => [{ name: NAME }], stopReason: () => "收回", isCreate: () => false, signal: () => {},
      killWindows: async () => {}, probe: async () => "running", sleep: async () => {},
      markStopped: async () => writeFileSync(path, JSON.stringify({ socket: "s", agents: { [NAME]: { ...ENTRY, status: "stopped" } } })),
    });
    expect(report.unconfirmed.map((u) => u.name)).toEqual([NAME]);
    expect(await h.hangUpAdapter()).toBe(129);
    await wait(() => h.failures().length > 0);
    expect(h.logs.some((l) => l.startsWith("本机在收这个 agent"))).toBe(false);
  }, 30_000);
});
