import { expect, test } from "bun:test";
import { migrateCodexTransports, type MigratingAgent } from "../src/lib/acp/migration.ts";
import { checkAcpReady, type AcpReadyDeps } from "../src/lib/acp/readiness.ts";
import { acpDoctorChecks } from "../src/lib/doctor-acp.ts";
import { restartMigrated, runMigrateMode } from "../src/manager/acp-migration.ts";
import { chooseCreateTransport, chooseResumeTransport, persistManualTmux, prepareAcpFork, recoverFailedAcpLaunch } from "../src/manager/acp-lifecycle.ts";
import { managedFor } from "../src/lib/runtimes/index.ts";
import type { RegistryAgent } from "../src/lib/registry.ts";
import type { LaunchSpec } from "../src/lib/runtimes/types.ts";

const healthy: AcpReadyDeps = {
  env: {}, resolveBin: async () => "/usr/bin/codex",
  run: async () => ({ ok: true, out: "Usage: codex app-server [OPTIONS]", err: "" }),
  installed: () => ({ ok: true, path: "/state/acp/index.js" }),
};

test("旧 updater 的无参数 migrate 只搬 worker，不在 daemon reload 前启动 ACP 宿主", async () => {
  const calls: string[] = [];
  const worker = async () => { calls.push("worker"); return { migrated: true, entries: 1 }; };
  const acp = async (_automatic: boolean): ReturnType<typeof import("../src/manager/acp-migration.ts").migrateAll> => {
    calls.push("acp");
    throw new Error("旧 bridge 尚未 reload，不得迁移 ACP");
  };
  expect(await runMigrateMode(undefined, worker, acp)).toEqual({ ok: true, migrated: true, entries: 1 });
  expect(await runMigrateMode("--pre-reload", worker, acp)).toEqual({ ok: true, migrated: true, entries: 1 });
  expect(calls).toEqual(["worker", "worker"]);
});

test("bridge 重启时探测抖动不改已有 ACP agent，也不重启其进行中的回合", () => {
  const agents: Record<string, MigratingAgent> = {
    busy: { runtime: "codex", transport: "acp", status: "active", acpRestartPending: true },
    old: { runtime: "codex", status: "active" },
  };
  const unavailable = { ok: false as const, reason: "Codex CLI 暂时不可用" };
  expect(migrateCodexTransports(agents, unavailable, false)).toMatchObject({ changed: ["old"], restart: [] });
  expect(agents.busy).toMatchObject({ transport: "acp", acpRestartPending: true });
  expect(agents.old).toMatchObject({ transport: "tmux", acpPending: true });
  expect(migrateCodexTransports(agents, { ok: true }, false)).toMatchObject({ changed: [], restart: [] });
  expect(agents.busy.transport).toBe("acp");
});

test("ACP 闸门识别旧 CLI 打印顶层 help 后 exit 0，不能误判可用", async () => {
  expect(await checkAcpReady(false, { ...healthy, run: async () => ({ ok: true, out: "Usage: codex [OPTIONS]", err: "" }) }))
    .toEqual({ ok: false, reason: "Codex CLI 太旧或缺少 app-server" });
  expect(await checkAcpReady(false, healthy)).toEqual({ ok: true, codexBin: "/usr/bin/codex" });
});

test("缺适配器才按固定安装器下载；下载失败留在 tmux，doctor 说明", async () => {
  let installs = 0;
  const deps: AcpReadyDeps = { ...healthy,
    installed: () => ({ ok: false, hint: "缺适配器" }),
    install: async () => { installs++; return { ok: false, error: "sha256 不匹配" }; },
  };
  expect(await checkAcpReady(false, deps)).toEqual({ ok: false, reason: "缺适配器" });
  expect(installs).toBe(0);
  const failed = await checkAcpReady(true, deps);
  expect(failed).toEqual({ ok: false, reason: "sha256 不匹配" });
  expect(installs).toBe(1);
  const agents: Record<string, MigratingAgent> = { old: { runtime: "codex", status: "active" } };
  expect(migrateCodexTransports(agents, failed)).toMatchObject({ changed: ["old"], pending: ["old"], restart: [] });
  expect(agents.old).toMatchObject({ transport: "tmux", acpPending: true });
  expect(agents.old.acpRestartPending).toBeUndefined();
  expect(acpDoctorChecks([{ name: "old", runtime: "codex", acpPending: true } as RegistryAgent], failed)
    .some((c) => c.name === "tmux 暂退" && c.status === "warn")).toBe(true);
});

test("迁移可重跑：条件恢复接回旧会话，显式 tmux 回退不再自动改，失败重启可重试", () => {
  const agents: Record<string, MigratingAgent> = {
    old: { runtime: "codex", status: "active" },
    manual: { runtime: "codex", transport: "tmux", status: "active" },
    pi: { runtime: "pi", status: "active" },
  };
  const unavailable = { ok: false as const, reason: "无适配器" };
  migrateCodexTransports(agents, unavailable);
  expect(migrateCodexTransports(agents, unavailable)).toMatchObject({ changed: [], restart: [] });
  const recovered = migrateCodexTransports(agents, { ok: true, codexBin: "/usr/bin/codex" });
  expect(recovered).toMatchObject({ changed: ["old"], restart: ["old"], pending: [] });
  expect(agents.old).toMatchObject({ transport: "acp", acpRestartPending: true, acpRestartFrom: "tmux" });
  expect(agents.old.acpPending).toBeUndefined();
  expect(agents.manual).toMatchObject({ transport: "tmux" });
  expect(agents.pi.transport).toBeUndefined();
  delete agents.old.acpRestartPending; // 成功重启后 manager 清标记
  expect(migrateCodexTransports(agents, { ok: true })).toMatchObject({ changed: [], restart: [] });
});

test("bridge 启动时跳过暂退 tmux，人工重跑迁移才能重试；旧记录仍会升级", () => {
  const agents: Record<string, MigratingAgent> = {
    pending: { runtime: "codex", transport: "tmux", acpPending: true, status: "active" },
    legacy: { runtime: "codex", status: "active" },
  };
  expect(migrateCodexTransports(agents, { ok: true }, false)).toMatchObject({ changed: ["legacy"], restart: ["legacy"] });
  expect(agents.pending).toMatchObject({ transport: "tmux", acpPending: true });
  delete agents.legacy.acpRestartPending; // 模拟 bridge 启动迁移已完成重启
  expect(migrateCodexTransports(agents, { ok: true })).toMatchObject({ changed: ["pending"], restart: ["pending"] });
});

test("沙箱只认仓库 stub，不探测本机 Codex 或下载安装包", async () => {
  expect(await checkAcpReady(true, { env: { CLAUDESTRA_SANDBOX: "1", CLAUDESTRA_SANDBOX_ROOT: "/tmp/sb" }, stub: () => "/repo/scripts/acp-stub.ts",
    resolveBin: async () => { throw new Error("不应碰 Codex"); } })).toEqual({ ok: true });
});

test("自动迁移接旧线程失败会重起 tmux；两次都失败就保留待重启标记", async () => {
  const agents: Record<string, MigratingAgent> = {
    old: { runtime: "codex", transport: "acp", acpRestartPending: true },
    broken: { runtime: "codex", transport: "acp", acpRestartPending: true },
  };
  const calls: string[] = [];
  const result = await restartMigrated(new Map([["old", "acp"], ["broken", "acp"]]), async (name) => {
    calls.push(`${name}:${agents[name].transport}`);
    return { ok: name === "old" && agents[name].transport === "tmux" };
  }, async (name, mutate) => { mutate(agents[name] as any); return true; });
  expect(calls).toEqual(["old:acp", "old:tmux", "broken:acp", "broken:tmux"]);
  expect(result).toEqual({ restarted: ["old"], fellBack: ["old"], failed: ["broken"] });
  expect(agents.old).toMatchObject({ transport: "tmux", acpPending: true });
  expect(agents.old.acpRestartPending).toBeUndefined();
  expect(agents.old.acpRestartFrom).toBeUndefined();
  expect(agents.broken).toMatchObject({ transport: "tmux", acpPending: true, acpRestartPending: true, acpRestartFrom: "acp" });
});

test("一个 restart 子进程抛错不挡住后续 Codex 迁移，失败者保留重试标记", async () => {
  const agents: Record<string, MigratingAgent> = {
    broken: { runtime: "codex", transport: "acp", acpRestartPending: true },
    good: { runtime: "codex", transport: "acp", acpRestartPending: true },
  };
  const calls: string[] = [];
  const result = await restartMigrated(new Map([["broken", "acp"], ["good", "acp"]]), async (name) => {
    calls.push(name);
    if (name === "broken") throw new Error("spawn failed");
    return { ok: true };
  }, async (name, mutate) => { mutate(agents[name] as any); return true; });
  expect(calls).toEqual(["broken", "broken", "good"]);
  expect(result).toEqual({ restarted: ["good"], fellBack: [], failed: ["broken"] });
  expect(agents.broken).toMatchObject({ transport: "tmux", acpPending: true, acpRestartPending: true });
  expect(agents.good.acpRestartPending).toBeUndefined();
});

test("旧记录缺 transport 时 owner 选 tmux 会落成显式值，后续迁移不覆盖", () => {
  const old: MigratingAgent = { runtime: "codex", status: "active" };
  expect(persistManualTmux(old)).toBe(true);
  expect(old.transport).toBe("tmux");
  expect(persistManualTmux(old)).toBe(false);
  expect(migrateCodexTransports({ old }, { ok: true })).toMatchObject({ changed: [], restart: [] });
  const pending: MigratingAgent = { runtime: "codex", transport: "tmux", acpPending: true, acpRestartPending: true, acpRestartFrom: "acp" };
  expect(persistManualTmux(pending)).toBe(true);
  expect(pending).toEqual({ runtime: "codex", transport: "tmux" });
});

test("新建显式 --transport tmux 会记成人工选择", async () => {
  expect(await chooseCreateTransport("codex", "tmux")).toEqual({ transport: "tmux", manualTmux: true });
});

test("ACP fork 在启动前换成新线程 id；相同或非法 id 不能落 registry", async () => {
  const source = "019a0000-0000-7000-8000-000000000001";
  const fresh = "019a0000-0000-7000-8000-000000000002";
  const spec: LaunchSpec = { mode: "fork", sessionId: source, cwd: "/w", channelId: "ch", bridgeUrl: "ws://localhost:3847" };
  const base = managedFor("codex", "acp")!;
  expect(await prepareAcpFork(spec, { ...base, prepareSession: async () => ({ sessionId: fresh }) }, "acp"))
    .toEqual({ ...spec, mode: "resume", sessionId: fresh });
  expect(await prepareAcpFork(spec, base, "tmux")).toBe(spec);
  await expect(prepareAcpFork(spec, { ...base, prepareSession: async () => ({ sessionId: source }) }, "acp"))
    .rejects.toThrow("新的合法 sessionId");
  await expect(prepareAcpFork(spec, { ...base, prepareSession: async () => ({ sessionId: "bad" }) }, "acp"))
    .rejects.toThrow("新的合法 sessionId");
});

test("resume 同名人工 tmux 不被 ACP 默认值冲掉；暂退 tmux 可以重试 ACP", async () => {
  expect(await chooseResumeTransport("codex", { transport: "tmux" })).toEqual({ transport: "tmux", manualTmux: true });
});

test("普通 restart 自己完成 tmux 回退时，迁移输出也如实标记", async () => {
  const state: MigratingAgent = { runtime: "codex", transport: "acp", acpRestartPending: true };
  const result = await restartMigrated(new Map([["old", "acp"]]), async () => {
    state.transport = "tmux"; state.acpPending = true; delete state.acpRestartPending;
    return { ok: true };
  }, async (_name, mutate) => { mutate(state as any); return true; });
  expect(result).toEqual({ restarted: ["old"], fellBack: ["old"], failed: [] });
});

test("普通 restart 的 ACP 接线程失败也回退 tmux，成功后保留待迁移而清待重启", async () => {
  const state: MigratingAgent = { runtime: "codex", transport: "acp", status: "active" };
  const calls: string[] = [];
  const result = await recoverFailedAcpLaunch("agent-old", state, managedFor("codex", "acp")!, { ready: false, reason: "timeout" },
    async (adapter) => { calls.push(adapter.control.idleSource); return { ready: true }; }, {
      exit: async () => true,
      patch: async (_name, mutate) => { mutate(state as any); return true; },
    });
  expect(result.started.ready).toBe(true);
  expect(result.adapter.control.idleSource).toBe("hook");
  expect(calls).toEqual(["hook"]);
  expect(state).toMatchObject({ transport: "tmux", acpPending: true });
  expect(state.acpRestartPending).toBeUndefined();
});
