/**
 * 新建 / 收编的 Pi 缺省走 ACP（docs/architecture/pi-acp-migration.md）：点名 --transport 照用；没点名探测通过 → acp，
 * 不通过 → tmux 并说明原因；ACP 起不来在同一窗口回退 tmux，不留死窗口；ACP 版不接 --fork。沙箱行为见 tests/pi-acp-sandbox.test.ts。
 */
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { AcpReady } from "../src/lib/acp/readiness.ts";
import { launchWithCallerCred } from "../src/lib/caller-cred-launch.ts";
import { managedFor } from "../src/lib/runtimes/index.ts";
import type { LaunchSpec, ReadyResult, WindowOps } from "../src/lib/runtimes/types.ts";
import {
  adoptTransport, chooseCreateTransport, chooseResumeTransport, launchWithPiFallback, prepareAcpResume, recoverFailedAcpLaunch, refusePiAcpFork, transportReport,
} from "../src/manager/acp-lifecycle.ts";
import { testChildEnv } from "./test-env.ts";

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

});

describe("Pi + ACP + --fork 拒绝（Pi 没有真正的会话分叉）", () => {
  test("ACP 版带 --fork 抛错；tmux 版、不带 --fork、Codex ACP 都放行", async () => {
    expect(() => refusePiAcpFork(piAcp, true)).toThrow("Pi 没有真正的会话分叉");
    expect(() => refusePiAcpFork(piTmux, true)).not.toThrow();
    expect(() => refusePiAcpFork(piAcp, false)).not.toThrow();
    expect(() => refusePiAcpFork(managedFor("codex", "acp")!, true)).not.toThrow();
    const spec: LaunchSpec = { mode: "fork", sessionId: "s1", cwd: "/w", channelId: "ch", bridgeUrl: "ws://localhost:3847" };
    await expect(prepareAcpResume(spec, piAcp, "acp", "agent-p")).rejects.toThrow(); // 兜底：绕过 resume 的拒绝也不会当成分叉起
  });

  test("manager resume --runtime pi --transport acp --fork：退出码非零，不建窗口、不写 registry", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-acp-fork-"));
    const runtime = mkdtempSync("/tmp/cstra-paf-"); // tmux socket 路径有长度上限
    try {
      const state = join(dir, "state");
      const proc = Bun.spawn([process.execPath, "--no-env-file", resolve(import.meta.dir, "../src/manager.ts"), "resume", "pf", "s-fork", dir, "--runtime", "pi", "--transport", "acp", "--fork"], {
        env: testChildEnv({ CLAUDESTRA_STATE_DIR: state, CLAUDESTRA_RUNTIME_DIR: runtime }), stdout: "pipe", stderr: "pipe",
      });
      const out = await new Response(proc.stdout).text();
      expect(await proc.exited).not.toBe(0);
      expect(JSON.parse(out.trim().split("\n").pop() || "{}")).toMatchObject({ ok: false, error: expect.stringContaining("不支持 --fork") });
      const reg = join(state, "registry.json");
      expect(existsSync(reg) ? Object.keys(JSON.parse(readFileSync(reg, "utf8")).agents ?? {}) : []).toEqual([]);
      expect(existsSync(join(runtime, "master.sock"))).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
      rmSync(runtime, { recursive: true, force: true });
    }
  }, 60_000);
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

  test("人工 tmux 保持；点名 acp 先过探测再切；探测不过留 tmux 记 acpPending；非 Pi 点名就拒", async () => {
    const manual: Record<string, unknown> = { runtime: "pi", transport: "tmux" };
    await adoptTransport(manual, undefined, never);
    expect(manual).toEqual({ runtime: "pi", transport: "tmux" });
    await adoptTransport(manual, "acp", pass);
    expect(manual).toMatchObject({ transport: "acp", acpRestartFrom: "tmux" });
    const old: Record<string, unknown> = { runtime: "pi" };
    expect(await adoptTransport(old, undefined, fail)).toContain("本次用 tmux");
    expect(old).toEqual({ runtime: "pi", acpPending: true });
    await expect(adoptTransport({ runtime: "codex" }, "acp")).rejects.toThrow("只给 Pi agent 用");
    expect(await adoptTransport({ runtime: "codex" })).toBeUndefined();
  });

  test("R1-01 点名 acp 但探测不过（能力档禁了 reply / MCP 撞名）：拒，info 一个字段都不动（调用方不落盘、不 restart）", async () => {
    const info: Record<string, unknown> = { runtime: "pi", transport: "tmux", cwd: "/w", piEnv: { excludeTools: ["reply"] } };
    let seen: unknown;
    const probe = async (_cwd?: string, piEnv?: unknown): Promise<AcpReady> => ((seen = piEnv), { ok: false, reason: "Pi 能力档禁用了 reply" });
    await expect(adoptTransport(info, "acp", probe)).rejects.toThrow("registry 和旧 agent 都没动");
    expect(seen).toEqual({ excludeTools: ["reply"] });
    expect(info).toEqual({ runtime: "pi", transport: "tmux", cwd: "/w", piEnv: { excludeTools: ["reply"] } });
  });

  test("R1-01 restart：真实启动包装里 buildLaunchCommand 同步抛（能力档禁了 reply）也回退，transport 恢复 tmux、tmux 版起来", async () => {
    const spec: LaunchSpec = {
      mode: "resume", sessionId: "s-r1", channelId: "ch", bridgeUrl: "ws://127.0.0.1:9", agentName: "agent-p", cwd: tmpdir(),
      extras: { piEnv: { excludeTools: ["reply"] } },
    };
    const sent: string[] = [];
    const sendLine = async (cmd: string) => { sent.push(cmd); };
    // 与 manager launchInWindow 的 send 同形：非 async 箭头，buildLaunchCommand 在求值实参时就抛
    const launch = (a: typeof piAcp) => launchWithCallerCred("agent-p", a, spec,
      (file) => sendLine(a.buildLaunchCommand({ ...spec, callerCredFile: file })), async () => ({ ready: true }));
    await expect(launch(piAcp)).rejects.toThrow("禁用了 reply"); // 前提：同步抛穿过 launchWithCallerCred 成了 reject，不是 not-ready
    const state: Record<string, unknown> = { runtime: "pi", transport: "acp", acpRestartPending: true, acpRestartFrom: "tmux" };
    const r = await recoverFailedAcpLaunch("agent-p", state, piAcp, launch(piAcp), launch,
      { exit: async () => true, patch: async (_n, mutate) => (mutate(state as never), true) });
    expect(r.adapter).toBe(piTmux);
    expect(r.started.ready).toBe(true);
    expect(state).toMatchObject({ transport: "tmux", acpPending: true });
    expect(state.acpRestartPending).toBeUndefined();
    expect(sent).toHaveLength(1);
    expect(sent[0]).not.toContain("acp-host.ts");
  });

  test("restart 首次启动抛错：非 ACP 原样抛给调用方（不吞成回退）", async () => {
    const boom = Promise.reject(new Error("tmux 炸了"));
    await expect(recoverFailedAcpLaunch("agent-p", { runtime: "pi" }, piTmux, boom, async () => ({ ready: true }))).rejects.toThrow("tmux 炸了");
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
