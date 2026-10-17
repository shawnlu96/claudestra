/**
 * agents-CODEXRO1 验收线 2：ACP 路径的只读档。adapterEnv 按档位选预设、parseAdapterEnv 认新预设、认不出的预设拒起；
 * 只读 agent 只许起自研适配器（上游遇到不认识的预设会静默退回可写的 agent 档），且没有可退的上游。
 */
import { describe, expect, test } from "bun:test";
import { acpAgentCommand, adapterEnv, type AdapterEnvSpec } from "../src/lib/acp/adapter-proc.js";
import { parseAdapterEnv } from "../src/lib/acp/codex-adapter/session-config.js";
import { ACP_READONLY_PRESET, PERMISSION_MODE_ENV } from "../src/lib/codex-readonly.js";
import { ACP_AGENT_ENV } from "../src/lib/acp/stub.js";

const spec = (over: Partial<AdapterEnvSpec> = {}): AdapterEnvSpec => ({
  base: { PATH: "/usr/bin", HOME: "/home/u" }, bunBin: "/bin/bun", channelServer: "/repo/src/channel-server.ts", mcpName: "claudestra",
  codexPath: "/bin/codex", logsDir: "/tmp/logs", channel: { channelId: "c1", proxyUrl: "ws://127.0.0.1:1/p?t=x", agentName: "agent-ro", sessionId: "s1" },
  ...over,
});
const config = (env: Record<string, string>) => JSON.parse(env.CODEX_CONFIG!) as Record<string, unknown>;

describe("adapterEnv", () => {
  test("[验收线 2] readOnly（显式档位）→ 只读预设；线程级默认也压成只读；channel-server 拿得到档位", () => {
    const env = adapterEnv(spec({ permissionMode: "readOnly" }));
    expect(env.INITIAL_AGENT_MODE).toBe(ACP_READONLY_PRESET);
    expect(config(env)).toMatchObject({ sandbox_mode: "read-only", approval_policy: "never" });
    expect(env[PERMISSION_MODE_ENV]).toBe("readOnly");
  });

  test("只读档：claudestra server 只放行回复类工具的审批，非只读不加", () => {
    const ro = config(adapterEnv(spec({ permissionMode: "readOnly" }))) as { mcp_servers: Record<string, { tools?: Record<string, unknown> }> };
    const tools = ro.mcp_servers.claudestra!.tools!;
    expect(tools.reply).toEqual({ approval_mode: "approve" });
    expect(Object.keys(tools).sort()).toEqual(["check_inbox", "edit_message", "fetch_messages", "forward_to_agent", "react", "reply", "send_to_agent", "whoami"]);
    const rw = config(adapterEnv(spec())) as { mcp_servers: Record<string, { tools?: unknown }> };
    expect(rw.mcp_servers.claudestra!.tools).toBeUndefined();
  });

  test("[验收线 2] readOnly（宿主命令带进来的环境变量）→ 同样只读预设", () => {
    const env = adapterEnv(spec({ base: { PATH: "/usr/bin", [PERMISSION_MODE_ENV]: "readOnly" } }));
    expect(env.INITIAL_AGENT_MODE).toBe(ACP_READONLY_PRESET);
  });

  test("[验收线 2] 其他 agent 仍是 agent-full-access，config 里没有只读项", () => {
    for (const s of [spec(), spec({ permissionMode: "bypassPermissions" }), spec({ channel: undefined })]) {
      const env = adapterEnv(s);
      expect(env.INITIAL_AGENT_MODE).toBe("agent-full-access");
      expect(config(env).sandbox_mode).toBeUndefined();
      expect(env[PERMISSION_MODE_ENV]).toBeUndefined();
    }
  });

  test("出借 worker 不支持只读：直接抛，不起", () => {
    expect(() => adapterEnv(spec({ permissionMode: "readOnly", clean: true, workerRoot: "/tmp/w" }))).toThrow(/出借 worker 不支持只读/);
  });
});

describe("parseAdapterEnv", () => {
  test("[验收线 2] 新预设解析成 readOnly 沙箱（无网络）+ approval never", () => {
    const r = parseAdapterEnv({ CODEX_PATH: "/bin/codex", INITIAL_AGENT_MODE: ACP_READONLY_PRESET });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.cfg.policy.approvalPolicy).toBe("never");
    expect(r.cfg.policy.sandboxPolicy).toEqual({ type: "readOnly", networkAccess: false });
  });

  test("[验收线 2] adapterEnv 给只读 agent 的环境，适配器解析出来就是只读 + never", () => {
    const r = parseAdapterEnv(adapterEnv(spec({ permissionMode: "readOnly" })));
    expect(r.ok && r.cfg.policy).toMatchObject({ approvalPolicy: "never", sandboxPolicy: { type: "readOnly" } });
  });

  test("[验收线 2] 认不出的预设名拒起，不降级", () => {
    for (const m of ["read-only-forever", "readOnly", "full"]) {
      const r = parseAdapterEnv({ CODEX_PATH: "/bin/codex", INITIAL_AGENT_MODE: m });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.why).toContain("不降级");
    }
  });
});

describe("acpAgentCommand：只读只起自研适配器", () => {
  const ro = { PATH: "/usr/bin", [PERMISSION_MODE_ENV]: "readOnly" };

  test("选择开关是 upstream 也强制 self，且没有可退的上游", () => {
    for (const selected of ["upstream", "self"] as const) {
      const r = acpAgentCommand(ro, "/bin/bun", "/nonexistent-root", false, selected);
      expect("error" in r).toBe(false);
      if ("error" in r) return;
      expect(r.adapter).toBe("self");
      expect(r.upstream).toBeNull();
      expect(r.cmd.at(-1)).toMatch(/codex-adapter\/main\.ts$/);
    }
  });

  test("手工覆盖认不出是谁 → 拒；出借 worker → 拒", () => {
    const o = acpAgentCommand({ ...ro, [ACP_AGENT_ENV]: '["bun","x.ts"]' }, "/bin/bun");
    expect("error" in o && o.error).toContain("只读 agent 不认");
    const c = acpAgentCommand(ro, "/bin/bun", undefined, true);
    expect("error" in c && c.error).toContain("出借 worker 不支持只读");
  });

  test("非只读照旧：没装上游时报安装提示，不会偷偷换成自研", () => {
    const r = acpAgentCommand({ PATH: "/usr/bin" }, "/bin/bun", "/nonexistent-root");
    expect("error" in r).toBe(true);
  });
});
