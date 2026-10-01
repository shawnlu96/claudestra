/** i28-W4 ACP clean 宿主挂 lend 档 channel-server（src/lib/acp/adapter-proc.ts adapterEnv） */
import { describe, expect, test } from "bun:test";
import { adapterEnv, type AdapterEnvSpec } from "../src/lib/acp/adapter-proc.js";
import { MCP_PROFILE_ENV } from "../src/lib/lend-mcp-profile.js";
import { BUN_NO_AUTOLOAD } from "../src/lib/runtimes/clean-env.js";

const BASE = { PATH: "/usr/bin", HOME: "/Users/b", GH_TOKEN: "gh-secret", BRIDGE_CONTROL_TOKEN: "ctl-secret", CLAUDESTRA_MCP_PROFILE: "full" };
const spec = (clean: boolean): AdapterEnvSpec => ({
  base: BASE, bunBin: "/b/bun", channelServer: "/r/src/channel-server.ts", mcpName: "claudestra", logsDir: "/l", clean,
  channel: { channelId: "123", proxyUrl: "ws://127.0.0.1:9/?t=tok", agentName: clean ? "agent-lend-0123456789" : "agent-codex", sessionId: "thr-1" },
});
const server = (env: Record<string, string>) => JSON.parse(env.CODEX_CONFIG).mcp_servers.claudestra as { command: string; args: string[]; env_vars: string[] };

describe("clean 宿主的 channel-server", () => {
  test("挂上 channel-server，设 lend 档；档位变量在 env_vars 里传得到 channel-server", () => {
    const env = adapterEnv(spec(true));
    expect(env[MCP_PROFILE_ENV]).toBe("lend");
    const s = server(env);
    expect(s.env_vars).toContain(MCP_PROFILE_ENV);
    expect(s.env_vars).toContain("BRIDGE_URL");
    expect(s.env_vars).toContain("CLAUDESTRA_AGENT"); // 档位变量丢了也能按名字开 lend 档
  });

  test("channel-server 在外来 clone 里起：bun 不读 cwd 的 .env* 与 bunfig.toml", () => {
    expect(server(adapterEnv(spec(true))).args).toEqual([...BUN_NO_AUTOLOAD, "/r/src/channel-server.ts"]);
  });

  test("宿主环境里自带的档位变量（哪怕是 full）不会漏进 clean：白名单之外的一概不带，档位只由这里设成 lend", () => {
    const env = adapterEnv(spec(true));
    expect(env[MCP_PROFILE_ENV]).toBe("lend");
    expect(JSON.stringify(env)).not.toContain("gh-secret");
    expect(JSON.stringify(env)).not.toContain("ctl-secret");
  });

  test("本机 ACP agent 照旧（回归）：channel-server 不加 bun 参数、不设档、env_vars 不带档位变量", () => {
    const env = adapterEnv(spec(false));
    const s = server(env);
    expect(s.args).toEqual(["/r/src/channel-server.ts"]);
    expect(s.env_vars).not.toContain(MCP_PROFILE_ENV);
    expect(env[MCP_PROFILE_ENV]).toBe("full"); // 继承来的原样留着；channel-server 拿不到它（不在 env_vars 里）
  });

  test("没有频道（create 的引导）：clean 与否都不挂 channel-server", () => {
    const { channel: _c, ...noChannel } = spec(true);
    expect(JSON.parse(adapterEnv(noChannel).CODEX_CONFIG).mcp_servers).toBeUndefined();
  });
});
