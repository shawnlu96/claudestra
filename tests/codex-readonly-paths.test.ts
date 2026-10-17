/**
 * agents-CODEXRO1 验收线 3：registry 里 permissionMode=readOnly 的 Codex agent，每条重新起进程的路径生成的启动参数 / 环境都是只读。
 * 进程启动全桩住（exec 引导、窗口、registry 都是假的）；每条路径按它在 manager / 调度器里拼 LaunchSpec 的样子单独断言，
 * 另断言「拼 spec 时漏了档位」也会被 registry 兜成只读（codex-readonly.ts effectiveCodexMode）。
 */
import { afterEach, describe, expect, test } from "bun:test";
import { createCodexAdapter, type CodexAdapterDeps } from "../src/lib/runtimes/codex.js";
import { buildAcpHostCommand, createCodexAcpAdapter } from "../src/lib/runtimes/codex-acp.js";
import { acpAgentCommand, adapterEnv } from "../src/lib/acp/adapter-proc.js";
import { parseAdapterEnv } from "../src/lib/acp/codex-adapter/session-config.js";
import { ACP_AGENT_ENV } from "../src/lib/acp/stub.js";
import { ACP_READONLY_PRESET, PERMISSION_MODE_ENV, resumePermissionMode } from "../src/lib/codex-readonly.js";
import type { LaunchSpec } from "../src/lib/runtimes/types.js";
import { REPO_ROOT } from "../src/lib/repo-root.js";

const SID = "019a0000-1111-7222-8333-444455556666";
const BYPASS = "dangerously-bypass-approvals-and-sandbox";
const RO_TUI = "--sandbox read-only --ask-for-approval never";
/** 假 registry：agent-ro 是只读，其它都是 bypass */
const REG: Record<string, string> = { "agent-ro": "readOnly", "agent-rw": "bypassPermissions" };
const lookup = (a: string) => REG[`agent-${a.replace(/^agent-/, "")}`];

let bootArgv: string[] = [];
function deps(): Partial<CodexAdapterDeps> {
  return {
    run: async (cmd: string[]) => ({ ok: true, out: cmd[1] === "queue" ? "Usage: codex queue [OPTIONS] --thread <THREAD>" : "", err: "" }),
    resolveBin: async () => "/opt/codex/bin/codex",
    execBootstrap: async (argv: string[]) => ((bootArgv = argv), { code: 0, out: `{"type":"thread.started","thread_id":"${SID}"}\n`, err: "" }),
    sessionCwd: () => "/work/from-rollout",
    bunBin: "/usr/local/bin/bun",
    repoRoot: REPO_ROOT,
    now: () => 0,
  };
}
const base = { channelId: "123", bridgeUrl: "ws://localhost:3999", sessionId: SID, cwd: "/work/dir" };
/** manager restart 拼的 spec：mode resume，档位取 registry 的 info.permissionMode，launchInWindow 再补 settingsName */
const restartSpec = (agent: string, permissionMode?: string): LaunchSpec => ({ ...base, mode: "resume", agentName: agent, settingsName: agent, permissionMode });
/** manager resume 拼的 spec：没有 agentName，只有 displayName（频道名）+ launchInWindow 补的 settingsName */
const resumeSpec = (agent: string, permissionMode?: string): LaunchSpec => ({ ...base, mode: "resume", displayName: agent.replace(/^agent-/, ""), settingsName: agent, permissionMode });

async function tmuxCommand(spec: LaunchSpec): Promise<string> {
  const a = createCodexAdapter(deps(), lookup);
  await a.available();
  return a.buildLaunchCommand(spec);
}
/** ACP：宿主命令的环境前缀 → 宿主起适配器时用的 argv 与环境（acp-host.ts 用 process.env 调这两个） */
function acpHost(spec: LaunchSpec) {
  const cmd = buildAcpHostCommand(spec, { bunBin: "/bin/bun", repoRoot: REPO_ROOT, codexBin: "/opt/codex/bin/codex", env: {}, permissionLookup: lookup });
  const mode = new RegExp(`${PERMISSION_MODE_ENV}=(\\S+)`).exec(cmd)?.[1];
  const hostEnv = { PATH: "/usr/bin", ...(mode ? { [PERMISSION_MODE_ENV]: mode } : {}) };
  const agent = acpAgentCommand(hostEnv, "/bin/bun", "/nonexistent-root", false, "upstream");
  const env = adapterEnv({ base: hostEnv, bunBin: "/bin/bun", channelServer: "/repo/src/channel-server.ts", mcpName: "claudestra", codexPath: "/bin/codex", logsDir: "/tmp/l" });
  return { cmd, agent, env, policy: parseAdapterEnv(env) };
}
function expectAcpReadOnly(h: ReturnType<typeof acpHost>) {
  expect(h.cmd).toContain(`${PERMISSION_MODE_ENV}=readOnly`);
  expect("error" in h.agent ? h.agent.error : h.agent.adapter).toBe("self");
  expect(h.env.INITIAL_AGENT_MODE).toBe(ACP_READONLY_PRESET);
  expect(h.policy.ok && h.policy.cfg.policy).toMatchObject({ approvalPolicy: "never", sandboxPolicy: { type: "readOnly" } });
}

describe("[验收线 3] tmux", () => {
  test("restart：registry 档位进 spec → 只读两项、无 bypass", async () => {
    const cmd = await tmuxCommand(restartSpec("agent-ro", "readOnly"));
    expect(cmd).toContain(RO_TUI);
    expect(cmd).not.toContain(BYPASS);
  });

  test("restart 拼 spec 漏了档位：registry 兜成只读", async () => {
    const cmd = await tmuxCommand(restartSpec("agent-ro", undefined));
    expect(cmd).toContain(RO_TUI);
    expect(cmd).not.toContain(BYPASS);
  });

  test("resume（定时唤醒 / 网页收编不带 --mode）：沿用旧条目的只读，spec 只有 displayName 也兜得住", async () => {
    const mode = resumePermissionMode(undefined, { permissionMode: "readOnly" });
    expect(mode).toBe("readOnly");
    expect(await tmuxCommand(resumeSpec("agent-ro", mode))).toContain(RO_TUI);
    const missed = await tmuxCommand(resumeSpec("agent-ro", undefined));
    expect(missed).toContain(RO_TUI);
    expect(missed).not.toContain(BYPASS);
  });

  test("生命周期重建（scheduler-wake-stopped：manager resume … --transport tmux，无 --mode）同上", async () => {
    const cmd = await tmuxCommand(resumeSpec("agent-ro", resumePermissionMode(undefined, { permissionMode: "readOnly" })));
    expect(cmd).toContain(RO_TUI);
  });

  test("fork 自愈（restart 里会话被占用 → fork）：codex fork 也只读", async () => {
    const cmd = await tmuxCommand({ ...restartSpec("agent-ro", "readOnly"), mode: "fork" });
    expect(cmd).toContain(" fork ");
    expect(cmd).toContain(RO_TUI);
    expect(cmd).not.toContain(BYPASS);
  });

  test("create 的 exec 引导轮只读", async () => {
    const a = createCodexAdapter(deps(), lookup);
    await a.prepareSession!({ ...base, mode: "new", agentName: "agent-new", permissionMode: "readOnly" });
    expect(bootArgv).toContain("read-only");
    expect(bootArgv.join(" ")).not.toContain(BYPASS);
  });

  test("对照：registry 不是只读的 agent 照旧 bypass（只收紧、不误伤）", async () => {
    const cmd = await tmuxCommand(restartSpec("agent-rw", "bypassPermissions"));
    expect(cmd).toContain(BYPASS);
    expect(cmd).not.toContain("--sandbox");
  });
});

describe("[验收线 3] ACP", () => {
  test("restart：宿主命令带档位 → 宿主只起自研、只读预设", () => expectAcpReadOnly(acpHost(restartSpec("agent-ro", "readOnly"))));

  test("bridge 启动时的 ACP 自动迁移（acp-migration：manager restart -- <name>，spec 来自 registry）", () => {
    expectAcpReadOnly(acpHost(restartSpec("agent-ro", "readOnly")));
    expectAcpReadOnly(acpHost(restartSpec("agent-ro", undefined))); // 漏了档位也兜住
  });

  test("resume / 生命周期重建：只有 displayName + settingsName 也兜住", () => {
    expectAcpReadOnly(acpHost(resumeSpec("agent-ro", undefined)));
  });

  test("对照：非只读 agent 的宿主命令不带档位，适配器仍是 agent-full-access", () => {
    const h = acpHost(restartSpec("agent-rw", "bypassPermissions"));
    expect(h.cmd).not.toContain(PERMISSION_MODE_ENV);
    expect(h.env.INITIAL_AGENT_MODE).toBe("agent-full-access");
  });
});

describe("[验收线 3] ACP 引导轮（create / fork）", () => {
  const prev = process.env[ACP_AGENT_ENV];
  afterEach(() => (prev === undefined ? delete process.env[ACP_AGENT_ENV] : (process.env[ACP_AGENT_ENV] = prev)));

  test("只读的引导轮走只读闸：手工覆盖的适配器被拒（证明引导用的是只读档的 argv，不是缺省上游）", async () => {
    process.env[ACP_AGENT_ENV] = JSON.stringify(["/bin/false"]);
    const a = createCodexAcpAdapter(deps());
    for (const mode of ["new", "fork"] as const) {
      await expect(a.prepareSession!({ ...base, mode, agentName: "agent-ro2", permissionMode: "readOnly" })).rejects.toThrow(/只读 agent 不认/);
    }
  });
});
