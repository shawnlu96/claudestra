/**
 * 新建 / 收编的 Pi 缺省走 ACP（docs/architecture/pi-acp-migration.md）：点名 --transport 照用；没点名探测通过 → acp，
 * 不通过 → tmux 并说明原因；ACP 起不来在同一窗口回退 tmux，不留死窗口。沙箱行为见 tests/pi-acp-sandbox.test.ts。
 */
import { afterEach, describe, expect, test } from "bun:test";
import type { AcpReady } from "../src/lib/acp/readiness.ts";
import { managedFor } from "../src/lib/runtimes/index.ts";
import type { LaunchSpec, ReadyResult, WindowOps } from "../src/lib/runtimes/types.ts";
import {
  adoptTransport, chooseCreateTransport, chooseResumeTransport, launchWithPiFallback, prepareAcpResume, recoverFailedAcpLaunch, transportReport,
} from "../src/manager/acp-lifecycle.ts";

const saved = process.env.CLAUDESTRA_SANDBOX;
afterEach(() => {
  if (saved === undefined) delete process.env.CLAUDESTRA_SANDBOX;
  else process.env.CLAUDESTRA_SANDBOX = saved;
});

const piAcp = managedFor("pi", "acp")!;
const piTmux = managedFor("pi", "tmux")!;
const pass = async (): Promise<AcpReady> => ({ ok: true });
const fail = async (): Promise<AcpReady> => ({ ok: false, reason: "pi 0.98.0 太旧：acp 要 0.99.0 以上（内置 MCP）" });
const never = async (): Promise<AcpReady> => { throw new Error("点名了 transport 不该再探测"); };

describe("选 transport", () => {
  test("没点名：探测通过 → acp，探测按会话目录和能力档查", async () => {
    const seen: unknown[] = [];
    const probe = async (cwd?: string, piEnv?: unknown) => (seen.push(cwd, piEnv), pass());
    expect(await chooseCreateTransport("pi", undefined, { cwd: "/w", piEnv: { base: "minimal" } }, probe)).toEqual({ transport: "acp" });
    expect(seen).toEqual(["/w", { base: "minimal" }]);
  });

  test("没点名：探测不通过 → tmux，原因进 note，记 acpPending 让下次收编再试", async () => {
    const r = await chooseCreateTransport("pi", undefined, {}, fail);
    expect(r).toMatchObject({ transport: "tmux", acpPending: true });
    expect(r.note).toContain("0.98.0 太旧");
  });

  test("点名照用、不探测：tmux 记成人工选择，acp 直接走", async () => {
    expect(await chooseCreateTransport("pi", "tmux", {}, never)).toEqual({ transport: "tmux", manualTmux: true });
    expect(await chooseCreateTransport("pi", "acp", {}, never)).toEqual({ transport: "acp" });
    await expect(chooseCreateTransport("pi", "ssh", {}, never)).rejects.toThrow("只能是 tmux 或 acp");
  });

  test("resume：同名旧记录的人工 tmux 保持；暂退 tmux 的接着探测；点名优先；能力档取旧记录", async () => {
    expect(await chooseResumeTransport("pi", { transport: "tmux" }, undefined, "/w", never)).toEqual({ transport: "tmux", manualTmux: true });
    expect(await chooseResumeTransport("pi", { transport: "tmux" }, "acp", "/w", never)).toEqual({ transport: "acp" });
    let piEnv: unknown;
    const probe = async (_cwd?: string, p?: unknown) => ((piEnv = p), pass());
    expect(await chooseResumeTransport("pi", { transport: "tmux", acpPending: true, piEnv: { base: "inherit" } }, undefined, "/w", probe)).toEqual({ transport: "acp" });
    expect(piEnv).toEqual({ base: "inherit" });
    expect(await chooseResumeTransport("pi", undefined, undefined, undefined, fail)).toMatchObject({ transport: "tmux" });
  });

  test("Pi 收编 fork 同 tmux 版：按原 id 接着开，不要 fork 准备方法", async () => {
    const spec: LaunchSpec = { mode: "fork", sessionId: "s1", cwd: "/w", channelId: "ch", bridgeUrl: "ws://localhost:3847" };
    expect(await prepareAcpResume(spec, piAcp, "acp", "agent-p")).toEqual({ ...spec, agentName: "agent-p" });
  });
});

describe("ACP 起不来回退 tmux（create / resume）", () => {
  const win = { name: "agent-p" } as WindowOps;
  const notReady: ReadyResult = { ready: false, reason: "exited" };

  test("没就绪：停宿主后同一窗口改起 tmux 版，带回退原因", async () => {
    const calls: string[] = [];
    const r = await launchWithPiFallback(piAcp, async (a) => (calls.push(a === piAcp ? "acp" : "tmux"), { result: a === piAcp ? notReady : { ready: true as const } }),
      win, async () => (calls.push("stop"), true));
    expect(calls).toEqual(["acp", "stop", "tmux"]);
    expect(r.adapter).toBe(piTmux);
    expect(r.result.ready).toBe(true);
    expect(r.note).toContain("已回退 tmux");
    const spec: LaunchSpec = { mode: "new", sessionId: "s1", channelId: "ch", bridgeUrl: "ws://x" };
    expect(transportReport(r.adapter, spec, r.note)).toEqual({ transport: "tmux", transportNote: r.note });
  });

  test("启动命令就抛（撞名 MCP）也回退；宿主停不下就报错、不在同一窗口再起一份", async () => {
    const thrown = await launchWithPiFallback(piAcp, async (a) => {
      if (a === piAcp) throw new Error("mcp.json 里有名为「claudestra」的 MCP server");
      return { result: { ready: true as const } };
    }, win, async () => true);
    expect(thrown.adapter).toBe(piTmux);
    expect(thrown.note).toContain("claudestra");
    let second = false;
    await expect(launchWithPiFallback(piAcp, async (a) => ((second ||= a === piTmux), { result: notReady }), win, async () => false))
      .rejects.toThrow("停不下来");
    expect(second).toBe(false);
  });

  test("就绪、非 Pi、沙箱都不回退", async () => {
    const stop = async () => { throw new Error("不该停宿主"); };
    expect((await launchWithPiFallback(piAcp, async () => ({ result: { ready: true as const } }), win, stop)).adapter).toBe(piAcp);
    const codex = managedFor("codex", "acp")!;
    expect((await launchWithPiFallback(codex, async () => ({ result: notReady }), win, stop)).adapter).toBe(codex);
    process.env.CLAUDESTRA_SANDBOX = "1";
    const r = await launchWithPiFallback(piAcp, async () => ({ result: notReady }), win, stop);
    expect(r.adapter).toBe(piAcp);
    expect(r.result.ready).toBe(false);
  });
});

describe("adopt", () => {
  test("老 Pi 记录（没 transport）探测通过切 acp，记下从 tmux 退旧窗口", async () => {
    const info: Record<string, unknown> = { runtime: "pi", cwd: "/w" };
    expect(await adoptTransport(info, undefined, pass)).toBeUndefined();
    expect(info).toMatchObject({ transport: "acp", acpRestartPending: true, acpRestartFrom: "tmux" });
  });

  test("人工 tmux 保持；点名 acp 照切；探测不过留 tmux 记 acpPending；非 Pi 点名就拒", async () => {
    const manual: Record<string, unknown> = { runtime: "pi", transport: "tmux" };
    await adoptTransport(manual, undefined, never);
    expect(manual).toEqual({ runtime: "pi", transport: "tmux" });
    await adoptTransport(manual, "acp", never);
    expect(manual).toMatchObject({ transport: "acp", acpRestartFrom: "tmux" });
    const old: Record<string, unknown> = { runtime: "pi" };
    expect(await adoptTransport(old, undefined, fail)).toContain("本次用 tmux");
    expect(old).toEqual({ runtime: "pi", acpPending: true });
    await expect(adoptTransport({ runtime: "codex" }, "acp")).rejects.toThrow("只给 Pi agent 用");
    expect(await adoptTransport({ runtime: "codex" })).toBeUndefined();
  });

  test("adopt 后的 restart：Pi 的 ACP 起不来也回退 tmux，记 acpPending", async () => {
    const state: Record<string, unknown> = { runtime: "pi", transport: "acp", acpRestartPending: true, acpRestartFrom: "tmux" };
    const used: unknown[] = [];
    const r = await recoverFailedAcpLaunch("agent-p", state, piAcp, { ready: false, reason: "timeout" },
      async (a) => (used.push(a), { ready: true }), { exit: async () => true, patch: async (_n, mutate) => (mutate(state as never), true) });
    expect(used).toEqual([piTmux]);
    expect(r.adapter).toBe(piTmux);
    expect(state).toMatchObject({ transport: "tmux", acpPending: true });
    expect(state.acpRestartPending).toBeUndefined();
  });
});
