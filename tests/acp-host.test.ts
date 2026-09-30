import { afterEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { spawnAdapter, type AdapterProc } from "../src/lib/acp/adapter-proc.ts";
import type { BridgeLinkDeps } from "../src/lib/acp/bridge-link.ts";
import { AcpHost } from "../src/lib/acp/host.ts";
import { startToolProxy } from "../src/lib/acp/tool-proxy.ts";
import type { StopReport } from "../src/lib/acp/turn.ts";

// 整条宿主链：真的 AcpHost + 真的 stub 子进程（scripts/acp-stub.ts）+ stub 按 CODEX_CONFIG 起的真 channel-server +
// 真的回环代理；只有 bridge（假的连接）和 /hook 是假的。reply 真的从 channel-server 经代理走到「bridge」。

const REPO = join(import.meta.dir, "..");
const SID = "019a0000-0000-7000-8000-00000000abcd";
const CH = "local-acp-test";
const until = async (cond: () => boolean, ms = 15_000) => {
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

function start(extraEnv: Record<string, string> = {}, beforeSpawn?: () => Promise<void>) {
  const sent: any[] = [];
  const requests: any[] = [];
  const stops: (StopReport & { channelId: string })[] = [];
  const logs: string[] = [];
  let link!: Omit<BridgeLinkDeps, "url">;
  let ready = false;
  host = new AcpHost(
    {
      channelId: CH,
      agentName: "agent-acp-test",
      sessionId: SID,
      cwd: REPO,
      mcpName: "claudestra",
      preamble: "[claudestra:context] 前言",
      model: "stub-luna",
      agentCmd: [process.execPath, join(REPO, "scripts/acp-stub.ts")],
      env: { base: { ...process.env, ...extraEnv }, bunBin: process.execPath, channelServer: join(REPO, "src/channel-server.ts"), mcpName: "claudestra", logsDir: "/tmp" },
    },
    {
      spawn: (cmd, env, cwd) => {
        const p = spawnAdapter(cmd, env, cwd, (m) => logs.push(m));
        procs.push(p);
        return p;
      },
      beforeSpawn,
      makeLink: (d) => {
        link = d;
        return {
          connect: () => void setTimeout(() => d.onRegistered(), 0),
          send: (f: any) => {
            sent.push(f);
            // 代理转上来的 reply：像 bridge 一样回包
            if (f.type === "reply") setTimeout(() => link.onFrame({ type: "response", requestId: f.requestId, result: { messageIds: ["m1"] } }), 0);
            return true;
          },
          request: async (f: any) => (requests.push(f), f.type === "acp_entries" ? true : null), // 像 bridge 一样确认收下了条目
          close: () => {},
          up: true,
        } as any;
      },
      startProxy: (d) => startToolProxy(d),
      postHook: async (b) => (stops.push(b), {}),
      markReady: async () => void (ready = true),
      log: (m) => logs.push(m),
    },
  );
  host.start();
  const entries = () => [...sent, ...requests].filter((f) => f.type === "acp_entries").flatMap((f) => f.entries);
  const inbound = (content: string, meta: Record<string, string> = { chat_id: "api:owner", message_id: "msg1" }) => link.onFrame({ type: "message", content, meta });
  return { sent, requests, stops, logs, entries, inbound, frame: (m: any) => link.onFrame(m), isReady: () => ready };
}

describe("ACP 宿主整条链（stub）", () => {
  test("beforeSpawn（探 codex 版本）等完才起适配器；等的时候宿主被停了就不再起", async () => {
    let release!: () => void;
    const gate = () => new Promise<void>((r) => { release = r; });
    const h = start({}, gate);
    await new Promise((r) => setTimeout(r, 50));
    expect(procs.length).toBe(0);
    release();
    await until(h.isReady);
    host!.stop();
    host = null;
    procs.splice(0).forEach((p) => p.stop());
    start({}, gate);
    await new Promise((r) => setTimeout(r, 50));
    host!.stop();
    release();
    await new Promise((r) => setTimeout(r, 50));
    expect(procs.length).toBe(0);
  }, 20_000);

  test("起步：登记 + 接上线程 → 标就绪；启动钉的模型经 set_config_option 生效，顶栏条目跟上", async () => {
    const h = start();
    await until(h.isReady);
    const cfg = h.sent.filter((f) => f.type === "acp_config").at(-1);
    expect(cfg.configOptions.find((o: any) => o.id === "model").currentValue).toBe("stub-luna");
    expect(h.entries().some((e) => e.subtype === "model_state" && e.model === "stub-luna")).toBe(true);
  }, 20_000);

  test("一轮：入站按 <channel> 包好（第一条附前言）→ 流式条目 → channel-server 经代理真的调了 reply → 回合末 Stop", async () => {
    const h = start();
    await until(h.isReady);
    h.inbound("在吗");
    await until(() => h.stops.length === 1);
    const reply = h.sent.find((f) => f.type === "reply");
    expect(reply).toMatchObject({ chatId: "api:owner" });
    expect(reply.text).toContain("stub 回复（stub-luna");
    expect(reply.text).toContain("在吗");
    expect(reply.requestId).toStartWith("acp"); // 代理改写过的 id
    const es = h.entries();
    const tools = es.flatMap((e) => e.message?.content ?? []).filter((b: any) => b.type === "tool_use").map((b: any) => b.name);
    expect(tools).toContain("Bash");
    expect(tools).toContain("mcp__claudestra__reply");
    expect(es.some((e) => e.type === "assistant" && e.message.content[0]?.text === "stub 收到了，看一眼再回。")).toBe(true);
    expect(h.stops[0]).toEqual({ channelId: CH, event: "Stop", stopHookActive: false });
  }, 30_000);

  test("忙时人类消息走 steering：原回合不停，补充送进当前回合，最后只报一次 Stop", async () => {
    const h = start();
    await until(h.isReady);
    h.inbound("[stub:pause] 先做任务 A");
    await until(() => h.entries().some((e) => e.message?.content?.[0]?.name === "Bash"));
    h.inbound("补充事实 B", { chat_id: "api:owner", message_id: "msg2" });
    await until(() => h.logs.some((line) => line.includes("msg2") && line.includes("插进当前回合")));
    await until(() => h.stops.length === 1);
    expect(h.sent.find((f) => f.type === "reply")?.text).toContain("途中插话 1 条");
    expect(h.sent.some((f) => f.type === "abort_ack")).toBe(false);
    expect(h.stops).toEqual([{ channelId: CH, event: "Stop", stopHookActive: false }]);
  }, 30_000);

  test("撞额度（注入）：出 acp_failure quota + ⛔ 条目，StopFailure，同一个失败只出一次", async () => {
    const h = start();
    await until(h.isReady);
    h.inbound("[stub:quota] 干活");
    await until(() => h.stops.length === 1);
    const f = h.sent.filter((x) => x.type === "acp_failure");
    expect(f.length).toBe(1);
    expect(f[0].failure).toMatchObject({ kind: "quota" });
    expect(f[0].configOptions.length).toBeGreaterThan(0);
    expect(h.entries().some((e) => e.error && e.isApiErrorMessage === false)).toBe(true);
    expect(h.stops[0].event).toBe("StopFailure");
  }, 30_000);

  test("停止：慢回合里收到 abort → session/cancel、回 abort_ack aborted，回合以 StopFailure+interrupt 收尾", async () => {
    const h = start();
    await until(h.isReady);
    h.inbound("[stub:slow] 慢慢来");
    await until(() => h.entries().some((e) => e.message?.content?.[0]?.name === "Bash"));
    h.frame({ type: "abort", id: "abort_1" });
    expect(h.sent.find((f) => f.type === "abort_ack")).toMatchObject({ id: "abort_1", result: "aborted" });
    await until(() => h.stops.length === 1);
    expect(h.stops[0]).toMatchObject({ event: "StopFailure", interrupt: true });
  }, 30_000);

  test("不重启改推理强度：acp_call set_config → 结果回包 + 配置广播；非法值本地拒", async () => {
    const h = start();
    await until(h.isReady);
    h.frame({ type: "acp_call", id: "c1", op: "set_config", configId: "reasoning_effort", value: "high" });
    await until(() => h.sent.some((f) => f.type === "acp_call_result" && f.id === "c1"));
    expect(h.sent.find((f) => f.id === "c1")).toMatchObject({ ok: true });
    h.frame({ type: "acp_call", id: "c2", op: "set_config", configId: "reasoning_effort", value: "ultra" });
    await until(() => h.sent.some((f) => f.type === "acp_call_result" && f.id === "c2"));
    expect(h.sent.find((f) => f.id === "c2")).toMatchObject({ ok: false });
  }, 20_000);

  test("没登录：接线程回 -32000 → 出 auth 卡（不出条目），prompt 按失败收尾", async () => {
    const h = start({ STUB_AUTH_REQUIRED: "1" });
    await until(() => h.sent.some((f) => f.type === "acp_failure"));
    expect(h.sent.find((f) => f.type === "acp_failure").failure).toMatchObject({ kind: "auth" });
    await until(h.isReady); // 没登录也标就绪：restart / 切 transport 不用白等超时，卡已经说明了
    h.inbound("在吗");
    await until(() => h.stops.length === 1);
    expect(h.stops[0].event).toBe("StopFailure");
  }, 20_000);

  test("适配器被杀：在途回合以失败收尾，退避后重起、接回同一个线程", async () => {
    const h = start();
    await until(h.isReady);
    h.inbound("[stub:slow] 慢慢来");
    await until(() => h.entries().some((e) => e.message?.content?.[0]?.name === "Bash"));
    procs[0].stop();
    await until(() => h.stops.length === 1);
    expect(h.stops[0].event).toBe("StopFailure");
    await until(() => h.logs.some((l) => l.includes("已接上线程")) && procs.length === 2, 20_000);
    h.inbound("回来了吗");
    await until(() => h.stops.length === 2, 20_000);
    expect(h.stops[1].event).toBe("Stop");
  }, 45_000);
});
