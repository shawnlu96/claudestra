/**
 * 经 ACP 跑的 agent 起的进程写台账，身份是它自己的 registry 键（AID1）：按宿主真实拼环境的路径（acpRuntime.adapterEnv，
 * Pi 再过 piChildEnv——pi 的 bash 工具原样继承它），在子进程里跑 resolveActor 的默认参数（读 process.env，和 ledger CLI 一样）。
 */
import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AdapterEnvSpec } from "../src/lib/acp/adapter-proc.ts";
import { acpRuntime } from "../src/lib/acp/host-runtime.ts";
import { piChildEnv } from "../src/lib/acp/pi-adapter/main.ts";
import { BUN_NO_AUTOLOAD } from "../src/lib/runtimes/clean-env.ts";

const AGENTS = { "agent-pi-w": { channelId: "ch-pi" }, "agent-cx-w": { channelId: "ch-cx" }, "agent-lend-ab12": { channelId: "ch-lend" } };
const IDENTITY = join(import.meta.dir, "../src/manager/ledger-identity.ts");

/** 子进程（干净 cwd、不读 .env）里按 ledger CLI 的方式推身份 */
function actorIn(env: Record<string, string>): unknown {
  const script = `import { resolveActor } from ${JSON.stringify(IDENTITY)};
console.log(JSON.stringify(resolveActor({ channelId: process.env.DISCORD_CHANNEL_ID, controlChannelId: "ch-ctl" }, ${JSON.stringify(AGENTS)})));`;
  const r = Bun.spawnSync([process.execPath, ...BUN_NO_AUTOLOAD, "-e", script], { env, cwd: mkdtempSync(join(tmpdir(), "aid1-")) });
  if (r.exitCode !== 0) throw new Error(r.stderr.toString());
  return JSON.parse(r.stdout.toString());
}

/** acp-host 自己的环境：manager 的启动命令给的（runtimes/pi-acp.ts / codex-acp.ts），acp-host 起步就要求 CLAUDESTRA_AGENT */
function hostSpec(agent: string, channelId: string, extra: Partial<AdapterEnvSpec> = {}): AdapterEnvSpec {
  return {
    base: { PATH: process.env.PATH!, HOME: process.env.HOME!, DISCORD_CHANNEL_ID: channelId, CLAUDESTRA_AGENT: agent, BRIDGE_URL: "ws://127.0.0.1:9", TMUX_PANE: "%1" },
    bunBin: process.execPath,
    channelServer: "/repo/src/channel-server.ts",
    mcpName: "claudestra",
    logsDir: "/l",
    channel: { channelId, proxyUrl: "ws://127.0.0.1:9/?token=T", agentName: agent, sessionId: "s-1" },
    ...extra,
  };
}

describe("ACP 宿主起的适配器及其子进程写台账的身份", () => {
  test("Pi：适配器环境刻意不带频道号（tmux 版扩展保持惰性），pi 的 shell 凭 CLAUDESTRA_AGENT 认成自己", () => {
    const adapter = acpRuntime("pi").adapterEnv(hostSpec("agent-pi-w", "ch-pi"));
    expect(adapter.DISCORD_CHANNEL_ID).toBeUndefined();
    expect(actorIn(adapter)).toEqual({ ok: true, actor: "agent-pi-w" });
    expect(actorIn(piChildEnv(adapter, {}, "/tmp"))).toEqual({ ok: true, actor: "agent-pi-w" });
  });

  test("Codex：同一条宿主路径，适配器环境带频道号（channel-server 用），认成自己", () => {
    const adapter = acpRuntime("codex").adapterEnv(hostSpec("agent-cx-w", "ch-cx"));
    expect(adapter.DISCORD_CHANNEL_ID).toBe("ch-cx");
    expect(actorIn(adapter)).toEqual({ ok: true, actor: "agent-cx-w" });
  });

  test("出借 worker（Codex 干净模式）照旧被拒；没有任何标记的终端照旧是 owner", () => {
    const workerRoot = mkdtempSync(join(tmpdir(), "aid1-lend-"));
    const lend = acpRuntime("codex").adapterEnv(hostSpec("agent-lend-ab12", "ch-lend", { clean: true, workerRoot }));
    expect(actorIn(lend)).toMatchObject({ ok: false });
    expect(actorIn({ PATH: process.env.PATH!, HOME: process.env.HOME! })).toEqual({ ok: true, actor: "owner" });
  });
});
