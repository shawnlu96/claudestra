/**
 * OpenCode 的启动配置必须生效（AcpRuntime.enforceLaunch）：registry 的模型会话不认时拒起、出失败卡、不标就绪——
 * 不然 OpenCode 会静默回落到它缺省的免费模型（OCR-4 第 1 轮 P1-1）。Codex / Pi 照旧只记日志。
 * 真 AcpHost + 本仓 stub（scripts/acp-stub.ts，模型选项 stub-sol / stub-luna），只有 bridge 连接与 /hook 是假的。
 */
import { afterEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { spawnAdapter, type AdapterProc } from "../src/lib/acp/adapter-proc.ts";
import { AcpHost } from "../src/lib/acp/host.ts";
import { acpRuntime } from "../src/lib/acp/host-runtime.ts";
import { startToolProxy } from "../src/lib/acp/tool-proxy.ts";

const REPO = join(import.meta.dir, "..");
const STUB = [process.execPath, join(REPO, "scripts/acp-stub.ts")];
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

function start(runtime: "opencode" | "codex", model: string, rt = acpRuntime(runtime)) {
  const persisted: string[] = [];
  const logs: string[] = [];
  const sent: any[] = [];
  let ready = false;
  host = new AcpHost(
    {
      channelId: "local-oc-test", agentName: "agent-oc-test", sessionId: "019a0000-0000-7000-8000-00000000c0de", cwd: REPO, mcpName: "claudestra",
      agentCmd: STUB, runtime: rt, model,
      env: { base: { ...process.env }, bunBin: process.execPath, channelServer: join(REPO, "src/channel-server.ts"), mcpName: "claudestra", logsDir: "/tmp" },
    },
    {
      spawn: (cmd, env, cwd) => {
        const p = spawnAdapter(cmd, env, cwd, (m) => logs.push(m));
        procs.push(p);
        return p;
      },
      makeLink: (d) => ({
        connect: () => void setTimeout(() => d.onRegistered(), 0),
        send: (f: any) => (sent.push(f), true),
        request: async (f: any) => (f.type === "acp_entries" ? true : null),
        close: () => {},
        up: true,
      }) as any,
      startProxy: (d) => startToolProxy(d),
      postHook: async () => ({}),
      markReady: async () => void (ready = true),
      rotateSession: async () => ({ ok: true }),
      persistModel: async (m) => void persisted.push(m),
      log: (m) => logs.push(m),
    },
  );
  host.start();
  return { logs, sent, persisted, isReady: () => ready };
}

describe("OpenCode 启动配置必须生效", () => {
  test("会话不认 registry 的模型：拒起、出失败卡、不标就绪、不重起", async () => {
    const h = start("opencode", "opencode/no-such-model");
    await until(() => h.sent.some((f) => f.type === "acp_failure"));
    await until(() => h.logs.some((l) => l.includes("不再重起")));
    expect(h.logs.join("\n")).toContain("opencode/no-such-model");
    expect(h.isReady()).toBe(false);
  }, 30_000);

  test("认得的模型：照常就绪", async () => {
    const h = start("opencode", "stub-luna");
    await until(h.isReady);
    expect(h.sent.filter((f) => f.type === "acp_failure")).toEqual([]);
  }, 30_000);

  test("运行时把裸 id 规范成完整 id：宿主回写 registry、之后按完整 id 用", async () => {
    const rt = { ...acpRuntime("opencode"), enforceLaunch: async () => "stub/luna-full" };
    const h = start("opencode", "luna", rt);
    await until(h.isReady);
    expect(h.persisted).toEqual(["stub/luna-full"]);
  }, 30_000);

  test("/clear 换代也走逐字核对：新会话里模型不被接受就换代失败，不静默跑在缺省模型上", async () => {
    const h = start("opencode", "stub-luna");
    await until(h.isReady);
    (host as any).cfg.model = "opencode/no-such-model";
    const r = await (host as any).clearSession();
    expect(r.ok).toBe(false);
    expect(String(r.error)).toContain("opencode/no-such-model");
  }, 30_000);

  test("Codex 不变：不认的模型只记日志、照常就绪", async () => {
    const h = start("codex", "no-such-model");
    await until(h.isReady);
    expect(h.logs.some((l) => l.includes("启动配置 model=no-such-model 没生效"))).toBe(true);
  }, 30_000);
});
