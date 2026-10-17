/**
 * OCR-2 验收 3：只在测试里登记一个假的 ACP 运行时（runtimes/ 以外一个文件都不改），证明契约够用——
 * 注册表 / transport 选择 / 策略 / 运行时目录都认它，启动命令点名它，真的 AcpHost + 本仓 stub 能起、能收发、能打断。
 */
import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { adapterEnv, spawnAdapter, type AdapterProc } from "../src/lib/acp/adapter-proc.ts";
import type { BridgeLinkDeps } from "../src/lib/acp/bridge-link.ts";
import { AcpHost } from "../src/lib/acp/host.ts";
import { acpRuntime } from "../src/lib/acp/host-runtime.ts";
import { startToolProxy } from "../src/lib/acp/tool-proxy.ts";
import { ACP_CONTROL } from "../src/lib/runtimes/acp-control.ts";
import { genericAcpRuntime } from "../src/lib/runtimes/acp-generic.ts";
import { runtimeCatalog } from "../src/lib/runtimes/catalog.ts";
import { ACP_RUNTIME_ENV, type AcpHostRuntime } from "../src/lib/runtimes/contract.ts";
import {
  checkAcpReadyFor, controlFor, isManageableRuntime, managedFor, manageableRuntimeIds, registerRuntimeForTest, requireManaged, transportsOf, type SessionSourceAdapter,
} from "../src/lib/runtimes/index.ts";
import { chooseCreateTransport, transportRefusal } from "../src/manager/acp-lifecycle.ts";

const REPO = join(import.meta.dir, "..");
const ID = "fakert";

const source: SessionSourceAdapter = {
  id: ID, label: "Fake", manageable: false,
  scanSessions: async () => [], sessionPath: () => null, findSessionById: () => null, listSessionsForCwd: () => [],
  ownsPath: () => false, sessionIdFromPath: () => null, translateLine: () => null,
};
// 适配器就是本仓的 ACP stub：像 Codex 一样按 CODEX_CONFIG 起 channel-server，所以环境照 adapterEnv 给、mcpServers 不传
const host: AcpHostRuntime = {
  id: ID, label: "Fake", logLabel: "fake-acp", translator: { compactFrom: "compaction-update" },
  agentCommand: (_env, bunBin) => ({ cmd: [bunBin, join(REPO, "scripts/acp-stub.ts")], stub: true }),
  adapterEnv,
  mcpServers: () => [],
};
const spec = genericAcpRuntime({ source, host, ready: async () => ({ ok: true }), isValidSessionId: (id) => /^[\w-]{1,64}$/.test(id) });
const unregister = registerRuntimeForTest({ source, acp: spec });
afterAll(unregister);

describe("假运行时：注册表一行就生效", () => {
  test("注册表：只有 ACP 版——没点名 transport 给 ACP 版，点名 tmux 不给；策略、目录、宿主描述都认它", async () => {
    expect(managedFor(ID)).toBe(spec.managed);
    expect(managedFor(ID, "acp")).toBe(spec.managed);
    expect(managedFor(ID, "tmux")).toBeNull();
    expect(() => requireManaged(ID, "tmux")).toThrow("只能走 transport=acp");
    expect(transportsOf(ID)).toEqual(["acp"]);
    expect(controlFor(ID)).toBe(ACP_CONTROL);
    expect(isManageableRuntime(ID)).toBe(true);
    expect(manageableRuntimeIds()).toContain(ID);
    expect(acpRuntime(ID)).toBe(host);
    expect(await checkAcpReadyFor(ID, true)).toEqual({ ok: true });
    expect((await runtimeCatalog()).find((e) => e.id === ID)).toEqual({ id: ID, label: "Fake", manageable: true, available: true });
  }, 30_000);

  test("manager：建 agent 缺省 acp；切 tmux 被拒、切 acp 放行；启动命令点名它、registry 记 acp", async () => {
    expect(await chooseCreateTransport(ID)).toEqual({ transport: "acp" });
    expect(transportRefusal({ runtime: ID }, "x", "tmux")).toContain("不支持 transport=tmux");
    expect(transportRefusal({ runtime: ID }, "x", "acp")).toBeNull();
    const cmd = spec.managed.buildLaunchCommand({ mode: "new", channelId: "c1", bridgeUrl: "ws://127.0.0.1:1", sessionId: "s1", agentName: "agent-f" });
    expect(cmd).toContain(`${ACP_RUNTIME_ENV}=${ID}`);
    expect(cmd).toEndWith(`${join(REPO, "src/acp-host.ts")}`);
    expect(spec.managed.registryFields({ mode: "new", channelId: "c1", bridgeUrl: "", sessionId: "s1" })).toEqual({ runtime: ID, transport: "acp" });
  });
});

const until = async (cond: () => boolean, ms = 15_000) => {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error("等超时");
    await new Promise((r) => setTimeout(r, 25));
  }
};
let running: AcpHost | null = null;
const procs: AdapterProc[] = [];
afterEach(() => {
  running?.stop();
  running = null;
  for (const p of procs.splice(0)) p.stop();
});

/** 真的 AcpHost（运行时描述从注册表取）+ 真的 stub 子进程 + 真的回环代理；只有 bridge 连接和 /hook 是假的 */
function startHost() {
  const sent: any[] = [];
  const stops: any[] = [];
  const requests: any[] = [];
  let link!: Omit<BridgeLinkDeps, "url">;
  let ready = false;
  const rt = acpRuntime(ID);
  const agent = rt.agentCommand(process.env, process.execPath, false);
  if ("error" in agent) throw new Error(agent.error);
  running = new AcpHost(
    {
      channelId: "local-fake", agentName: "agent-fake", sessionId: "019a0000-0000-7000-8000-00000000fa6e", cwd: REPO, mcpName: "claudestra",
      agentCmd: agent.cmd, runtime: rt,
      env: { base: process.env, bunBin: process.execPath, channelServer: join(REPO, "src/channel-server.ts"), mcpName: "claudestra", logsDir: "/tmp" },
    },
    {
      spawn: (cmd, env, cwd) => {
        const p = spawnAdapter(cmd, env, cwd, () => {}, rt.logLabel);
        procs.push(p);
        return p;
      },
      makeLink: (d) => {
        link = d;
        return {
          connect: () => void setTimeout(() => d.onRegistered(), 0),
          send: (f: any) => {
            sent.push(f);
            if (f.type === "reply") setTimeout(() => link.onFrame({ type: "response", requestId: f.requestId, result: { messageIds: ["m1"] } }), 0);
            return true;
          },
          request: async (f: any) => (requests.push(f), f.type === "acp_entries" ? true : null),
          close: () => {},
          up: true,
        } as any;
      },
      startProxy: (d) => startToolProxy(d),
      postHook: async (b) => (stops.push(b), {}),
      markReady: async () => void (ready = true),
      rotateSession: async () => ({ ok: true }),
      log: () => {},
    },
  );
  running.start();
  const inbound = (content: string) => link.onFrame({ type: "message", content, meta: { chat_id: "api:owner", message_id: "m0" } });
  const entries = () => [...sent, ...requests].filter((f) => f.type === "acp_entries").flatMap((f) => f.entries);
  return { sent, stops, entries, inbound, frame: (m: any) => link.onFrame(m), isReady: () => ready };
}

describe("假运行时：宿主整条链", () => {
  test("起得来、能收发：入站一条，reply 经 channel-server 出站，回合以 Stop 收尾", async () => {
    const h = startHost();
    await until(h.isReady);
    h.inbound("你好");
    await until(() => h.stops.length === 1);
    expect(h.stops[0]).toMatchObject({ event: "Stop" });
    expect(h.sent.filter((f) => f.type === "reply").at(-1)?.text).toContain("你好");
  }, 30_000);

  test("能打断：慢回合里收到 abort → abort_ack aborted，回合以 StopFailure+interrupt 收尾", async () => {
    const h = startHost();
    await until(h.isReady);
    h.inbound("[stub:slow] 慢慢来");
    await until(() => h.entries().some((e) => e.message?.content?.[0]?.name === "Bash")); // stub 的慢回合先出一条命令再等 cancel
    h.frame({ type: "abort", id: "abort_1" });
    await until(() => h.sent.some((f) => f.type === "abort_ack"));
    expect(h.sent.find((f) => f.type === "abort_ack")).toMatchObject({ type: "abort_ack", id: "abort_1", result: "aborted" });
    await until(() => h.stops.length === 1);
    expect(h.stops[0]).toMatchObject({ event: "StopFailure", interrupt: true });
  }, 30_000);
});
