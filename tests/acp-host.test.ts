import { afterEach, describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { spawnAdapter, type AdapterProc } from "../src/lib/acp/adapter-proc.ts";
import type { BridgeLinkDeps } from "../src/lib/acp/bridge-link.ts";
import { AcpHost } from "../src/lib/acp/host.ts";
import { startToolProxy } from "../src/lib/acp/tool-proxy.ts";
import type { StopReport } from "../src/lib/acp/turn.ts";
import { createTtyScreen } from "../src/lib/acp/tty-screen.ts";
import { termText } from "./helpers/acp-tty-term.ts";
import { activityPath, readActivity, stuckSince } from "../src/lib/agent-supervisor-activity.ts";

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

function start(
  extraEnv: Record<string, string> = {},
  rotate: (oldId: string, newId: string) => Promise<{ ok: boolean; error?: string }> = async () => ({ ok: true }),
  rebind: () => Promise<boolean> = async () => true,
  beforeSpawn?: () => Promise<void>,
  show?: (item: string) => void,
  showUpdate?: (u: Record<string, unknown>) => void,
) {
  const sent: any[] = [];
  const requests: any[] = [];
  const stops: (StopReport & { channelId: string })[] = [];
  const logs: string[] = [];
  const rebinds: string[] = [];
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
      clearPreamble: "[claudestra:context] 清理后前言",
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
          request: async (f: any) => (requests.push(f), f.type === "acp_rebind" ? (rebinds.push(f.sessionId), rebind()) : f.type === "acp_entries" ? true : null),
          close: () => {},
          up: true,
        } as any;
      },
      startProxy: (d) => startToolProxy(d),
      postHook: async (b) => (stops.push(b), {}),
      markReady: async () => void (ready = true),
      rotateSession: rotate,
      log: (m) => logs.push(m),
      show,
      showUpdate,
    },
  );
  host.start();
  const entries = () => [...sent, ...requests].filter((f) => f.type === "acp_entries").flatMap((f) => f.entries);
  const inbound = (content: string, meta: Record<string, string> = { chat_id: "api:owner", message_id: "msg1" }) => link.onFrame({ type: "message", content, meta });
  return { sent, requests, stops, logs, rebinds, entries, inbound, frame: (m: any) => link.onFrame(m), isReady: () => ready };
}

describe("ACP 宿主整条链（stub）", () => {
  test("窗口会话只读条目：推给 bridge 的条目有没有 show（含 show 抛错）都逐条一致，窗口拿到可读会话", async () => {
    const norm = (es: unknown[]) => JSON.parse(JSON.stringify(es).replace(/"timestamp":"[^"]+"/g, '"timestamp":"T"').replace(/(call|mcp)-[0-9a-f]{8}/g, "$1-X"));
    const run = async (show?: (item: string) => void) => {
      const h = start({}, undefined, undefined, undefined, show);
      await until(h.isReady);
      h.inbound("你好", { chat_id: "api:owner", message_id: "msg1", user: "owner" });
      await until(() => h.stops.length === 1);
      const es = norm(h.entries());
      expect(h.stops[0]).toMatchObject({ event: "Stop" });
      host!.stop();
      host = null;
      procs.splice(0).forEach((p) => p.stop());
      return { es, logs: h.logs };
    };
    const shown: string[] = [];
    const plain = (await run()).es;
    expect((await run((item) => shown.push(item))).es).toEqual(plain);
    const broken = await run(() => { throw new Error("渲染炸了"); }); // 窗口只是旁路：显示出错不能挡出站、回合收尾
    expect(broken.es).toEqual(plain);
    expect(broken.logs.some((m) => m.includes("窗口会话渲染出错") && m.includes("渲染炸了"))).toBe(true);
    expect(plain).toEqual(STUB_TURN_ENTRIES);
    expect(shown).toEqual([
      "> owner：你好",
      "● stub 收到了，看一眼再回。",
      "● Bash(echo stub)",
      "  ⎿ stub",
      "● 回复：stub 回复（stub-luna / medium）：[claudestra:context] 前言\n\n\n  你好",
      '  ⎿ Sent message(s): ["m1"]',
      "── 回合结束 ──",
    ]);
  }, 60_000); // 串行起三次宿主 + stub，机器忙时 20 秒不够

  test("TTY 窗口（tty-screen.ts）：真宿主喂条目和原始增量，正文不重复、底部状态行回到空闲；状态行读的 turnState 跟着回合走", async () => {
    let out = "", sawBusy = false, chunks = 0;
    const screen = createTtyScreen({ write: (x) => void (out += x), columns: () => 100 }, () => {
      const st = host?.turnState ?? { busy: false, queued: 0, permissions: 0 };
      sawBusy ||= st.busy;
      return st;
    });
    const h = start({}, undefined, undefined, undefined, (i) => screen.show(i), (u) => (u.sessionUpdate === "agent_message_chunk" && chunks++, screen.update(u)));
    await until(h.isReady);
    h.inbound("你好", { chat_id: "api:owner", message_id: "msg1", user: "owner" });
    await until(() => h.stops.length === 1);
    expect(chunks).toBeGreaterThan(0);
    expect(sawBusy).toBe(true);
    expect(host!.turnState).toEqual({ busy: false, queued: 0, permissions: 0 });
    screen.tick();
    const view = termText(out).replace(/^(\[\d\d:\d\d:\d\d\] | {11})/gm, "");
    expect(view.match(/stub 收到了/g)).toHaveLength(1);
    expect(view).toContain("● Bash(echo stub)\n  ⎿ stub");
    expect(view).toEndWith("── 回合结束 ──\n· 空闲");
  }, 30_000);

  test("beforeSpawn（探 codex 版本）等完才起适配器；等的时候宿主被停了就不再起", async () => {
    let release!: () => void;
    const gate = () => new Promise<void>((r) => { release = r; });
    const h = start({}, undefined, undefined, gate);
    await new Promise((r) => setTimeout(r, 50));
    expect(procs.length).toBe(0);
    release();
    await until(h.isReady);
    host!.stop();
    host = null;
    procs.splice(0).forEach((p) => p.stop());
    start({}, undefined, undefined, gate);
    await new Promise((r) => setTimeout(r, 50));
    host!.stop();
    release();
    await new Promise((r) => setTimeout(r, 50));
    expect(procs.length).toBe(0);
  }, 20_000);

  test("beforeSpawn reject 了：只记日志，照常起适配器（宿主不能卡在半开）", async () => {
    const h = start({}, undefined, undefined, async () => { throw new Error("探测炸了"); });
    await until(h.isReady);
    expect(h.logs.some((m) => m.includes("按未知照常起") && m.includes("探测炸了"))).toBe(true);
  }, 20_000);

  test("/clear 忙时拒绝；空闲时新线程引导后换 registry，轮换中的人类消息排队到新线程", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const rotations: [string, string][] = [];
    const h = start({}, async (oldId, newId) => (rotations.push([oldId, newId]), await gate, { ok: true }));
    await until(h.isReady);
    h.inbound("[stub:pause] 第一轮");
    await until(() => h.entries().some((e) => e.message?.content?.[0]?.name === "Bash"));
    h.frame({ type: "acp_call", id: "busy", op: "clear" });
    await until(() => h.sent.some((f) => f.id === "busy"));
    expect(h.sent.find((f) => f.id === "busy")).toMatchObject({ ok: false });
    await until(() => h.stops.length === 1);
    h.frame({ type: "acp_call", id: "clear", op: "clear" });
    await until(() => rotations.length === 1);
    h.inbound("轮换时发来的消息", { chat_id: "api:owner", message_id: "after-clear" });
    expect(h.stops).toHaveLength(1);
    release();
    await until(() => h.sent.some((f) => f.id === "clear"));
    const result = h.sent.find((f) => f.id === "clear");
    expect(result).toMatchObject({ ok: true, sessionId: rotations[0]![1] });
    expect(rotations[0]![0]).toBe(SID);
    expect(h.rebinds).toEqual([rotations[0]![1]]);
    await until(() => h.stops.length === 2);
    expect(h.sent.filter((f) => f.type === "reply").at(-1).text).toContain("轮换时发来的消息");
  }, 30_000);

  test("/clear registry 拒绝后不报成功，旧线程由适配器重起接回", async () => {
    const h = start({}, async () => ({ ok: false, error: "并发轮转" }));
    await until(h.isReady);
    h.frame({ type: "acp_call", id: "clear-fail", op: "clear" });
    await until(() => h.sent.some((f) => f.id === "clear-fail"));
    expect(h.sent.find((f) => f.id === "clear-fail")).toMatchObject({ ok: false, error: "registry 未换代：并发轮转" });
    await until(() => procs.length === 2, 20_000);
    expect(h.logs.filter((l) => l.includes("已接上线程")).at(-1)).toContain(SID.slice(0, 8));
  }, 30_000);

  test("/clear 写 registry 前适配器退出：自动重起必须等新 id 已提交", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let newId = "";
    const h = start({}, async (_old, fresh) => ((newId = fresh), await gate, { ok: true }));
    await until(h.isReady);
    h.frame({ type: "acp_call", id: "race", op: "clear" });
    await until(() => !!newId);
    procs[0].stop();
    await procs[0].exited;
    await new Promise((r) => setTimeout(r, 3_200));
    expect(procs).toHaveLength(1);
    release();
    await until(() => h.sent.some((f) => f.id === "race"));
    expect(h.sent.find((f) => f.id === "race")).toMatchObject({ ok: true, sessionId: newId });
    await until(() => procs.length === 2 && h.logs.some((l) => l.includes(`已接上线程 ${newId.slice(0, 8)}`)), 20_000);
  }, 30_000);

  test("/clear 新线程拒绝钉住的模型：不写 registry，不报成功，接回旧线程", async () => {
    const rotations: string[] = [];
    const h = start({}, async (_old, fresh) => (rotations.push(fresh), { ok: true }));
    await until(h.isReady);
    (host as any).cfg.model = "not-in-new-session";
    h.frame({ type: "acp_call", id: "config-fail", op: "clear" });
    await until(() => h.sent.some((f) => f.id === "config-fail"));
    expect(h.sent.find((f) => f.id === "config-fail")).toMatchObject({ ok: false });
    expect(rotations).toEqual([]);
    await until(() => procs.length === 2, 20_000);
    expect(h.logs.filter((l) => l.includes("已接上线程")).at(-1)).toContain(SID.slice(0, 8));
  }, 30_000);

  test("registry 已换但 watcher 未确认：排队消息等重绑成功才进入新线程", async () => {
    let rebindReady = false;
    const h = start({}, async () => ({ ok: true }), async () => rebindReady);
    await until(h.isReady);
    h.frame({ type: "acp_call", id: "rebind-fail", op: "clear" });
    await until(() => h.sent.some((f) => f.id === "rebind-fail"));
    expect(h.sent.find((f) => f.id === "rebind-fail")).toMatchObject({ ok: false });
    expect(h.sent.find((f) => f.id === "rebind-fail").error).toContain("watcher 尚未就绪");
    h.inbound("重绑后再说");
    await Bun.sleep(500);
    expect(h.stops).toHaveLength(0);
    rebindReady = true;
    await until(() => h.rebinds.length >= 2 && h.stops.length === 1, 10_000);
    expect(h.sent.filter((f) => f.type === "reply").at(-1).text).toContain("重绑后再说");
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
    expect([typeof f[0].sessionId, typeof f[0].failedAt]).toEqual(["string", "number"]); // 出借停单按它们认当前会话、当前回合（lend-turn-failure.ts）
    expect(h.entries().some((e) => e.error && e.isApiErrorMessage === false)).toBe(true);
    expect(h.stops[0].event).toBe("StopFailure");
  }, 30_000);

  test("停止：慢回合里收到 abort → session/cancel、回 abort_ack aborted，回合以 StopFailure+interrupt 收尾", async () => {
    const h = start();
    await until(h.isReady);
    h.inbound("[stub:slow] 慢慢来");
    await until(() => h.entries().some((e) => e.message?.content?.[0]?.name === "Bash"));
    h.frame({ type: "abort", id: "abort_1" });
    await until(() => h.sent.some((f) => f.type === "abort_ack")); // 回执在 cancel 之后发（Pi 适配器要先清队列；codex-acp 只差一个微任务）
    expect(h.sent.find((f) => f.type === "abort_ack")).toEqual({ type: "abort_ack", id: "abort_1", result: "aborted", voided: [], inEditor: 0 });
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

  test("acp_call turn：答回合在不在途（升级闸的权威来源），回合跑完回到空闲", async () => {
    const h = start();
    await until(h.isReady);
    const turn = async (id: string) => {
      h.frame({ type: "acp_call", id, op: "turn" });
      await until(() => h.sent.some((f) => f.type === "acp_call_result" && f.id === id));
      return h.sent.find((f) => f.id === id);
    };
    expect(await turn("t1")).toMatchObject({ ok: true, busy: false });
    h.inbound("[stub:pause] 停一下");
    expect(await turn("t2")).toMatchObject({ ok: true, busy: true });
    await until(() => h.stops.length === 1);
    expect(await turn("t3")).toMatchObject({ ok: true, busy: false });
  }, 20_000);

  test("回合心跳（i28-S1b）：开一轮写 busy、update 推进、Stop 写 busy=false；/clear 后写新 sessionId，旧 id 不判卡住", async () => {
    rmSync(activityPath("agent-acp-test"), { force: true });
    const h = start({}, async () => ({ ok: true }));
    await until(h.isReady);
    h.inbound("[stub:pause] 停一下");
    await until(() => readActivity("agent-acp-test")?.busy === true);
    const r1 = readActivity("agent-acp-test")!;
    expect(r1).toMatchObject({ sessionId: SID, hostPid: process.pid });
    expect(r1.updateAt).toBeGreaterThanOrEqual(r1.turnAt);
    expect(stuckSince(r1, SID, r1.updateAt + 60_000, 60_000)).toBe(Math.max(r1.updateAt, r1.turnAt));
    await until(() => h.stops.length === 1);
    expect(readActivity("agent-acp-test")).toMatchObject({ sessionId: SID, busy: false });
    h.frame({ type: "acp_call", id: "hb-clear", op: "clear" });
    await until(() => h.sent.some((f) => f.id === "hb-clear"));
    const newId = h.sent.find((f) => f.id === "hb-clear").sessionId;
    expect(newId).not.toBe(SID);
    h.inbound("[stub:pause] 新会话");
    await until(() => readActivity("agent-acp-test")?.sessionId === newId && readActivity("agent-acp-test")!.busy);
    expect(stuckSince(readActivity("agent-acp-test"), SID, Date.now() + 3_600_000, 60_000)).toBeNull();
    await until(() => h.stops.length === 2);
    expect(readActivity("agent-acp-test")).toMatchObject({ sessionId: newId, busy: false });
  }, 30_000);

  test("没登录：接线程回 -32000 → 出 auth 卡（不出条目），prompt 按失败收尾", async () => {
    const h = start({ STUB_AUTH_REQUIRED: "1" });
    await until(() => h.sent.some((f) => f.type === "acp_failure"));
    expect(h.sent.find((f) => f.type === "acp_failure").failure).toMatchObject({ kind: "auth" });
    await until(h.isReady); // 没登录也标就绪：restart / 切 transport 不用白等超时，卡已经说明了
    h.inbound("在吗");
    await until(() => h.stops.length === 1);
    expect(h.stops[0].event).toBe("StopFailure");
  }, 20_000);

  const incompatible: [string, object, string][] = [
    ["protocolVersion 2", { protocolVersion: 2 }, "protocolVersion 是 2"],
    ["没有 protocolVersion", { protocolVersion: null }, "没回 protocolVersion"],
    ["resume 与 loadSession 都没有", { agentCapabilities: { loadSession: false, sessionCapabilities: { resume: null } } }, "接不回已有线程"],
  ];
  for (const [what, patch, why] of incompatible) {
    test(`协议不兼容（${what}）：拒起——一张写明原因的卡、不标就绪、不重起，回合当场按失败收尾`, async () => {
      const h = start({ STUB_INITIALIZE: JSON.stringify(patch) });
      await until(() => h.sent.some((f) => f.type === "acp_failure"));
      const { failure } = h.sent.find((f) => f.type === "acp_failure");
      expect(failure).toMatchObject({ kind: "error", key: "incompatible", retry: false }); // 不带匹配器：bun 的 toMatchObject 会把匹配器写回被测对象
      expect(failure.message).toContain("协议不兼容，拒绝启动");
      expect(failure.message).toContain(why);
      await procs[0]!.exited;
      await until(() => h.logs.some((l) => l.includes("协议不兼容，不再重起")));
      h.inbound("在吗");
      await until(() => h.stops.length === 1);
      expect(h.stops[0]!.event).toBe("StopFailure");
      expect(h.entries().some((e) => e.error === failure.message && e.isApiErrorMessage === false)).toBe(true); // 不触发 60s 自动续跑
      expect(h.sent.filter((f) => f.type === "acp_failure")).toHaveLength(1);
      expect(h.isReady()).toBe(false); // manager 等不到就绪 → recoverFailedAcpLaunch 按启动失败处理
      expect(procs).toHaveLength(1);
    }, 20_000);
  }

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

/** stub 一轮（acp-stub.ts turn）推给 bridge 的条目，改窗口显示前后逐条一致；时间戳、调用 id 归一 */
const STUB_TURN_ENTRIES: unknown[] = [
  { type: "system", subtype: "model_state", timestamp: "T", model: "stub-luna", effort: "medium" },
  { type: "assistant", timestamp: "T", message: { content: [{ type: "text", text: "stub 收到了，看一眼再回。" }] } },
  { type: "assistant", timestamp: "T", message: { content: [{ type: "tool_use", id: "call-X", name: "Bash", input: { command: "echo stub" } }] } },
  { type: "user", timestamp: "T", message: { content: [{ type: "tool_result", tool_use_id: "call-X", content: "stub\n" }] } },
  { type: "assistant", timestamp: "T", message: { content: [{ type: "tool_use", id: "mcp-X", name: "mcp__claudestra__reply",
    input: { chat_id: "api:owner", text: "stub 回复（stub-luna / medium）：[claudestra:context] 前言\n\n\n你好" } }] } },
  { type: "user", timestamp: "T", message: { content: [{ type: "tool_result", tool_use_id: "mcp-X", content: 'Sent message(s): ["m1"]' }] } },
  { type: "system", subtype: "context_usage", timestamp: "T", tokens: 1407, window: 272000 },
];
