/**
 * agents-CODEXRO1 验收线 2：ACP 路径的只读档。adapterEnv 按档位选预设、parseAdapterEnv 认新预设、认不出的预设拒起；
 * 只读 agent 只许起自研适配器（上游遇到不认识的预设会静默退回可写的 agent 档），且没有可退的上游。
 */
import { describe, expect, test } from "bun:test";
import { acpAgentCommand, adapterEnv, type AdapterEnvSpec } from "../src/lib/acp/adapter-proc.js";
import { parseAdapterEnv, readOnlyPolicyMismatch } from "../src/lib/acp/codex-adapter/session-config.js";
import { fakeApp, harness } from "./helpers/codex-fake-app.ts";
import { ACP_READONLY_PRESET, PERMISSION_MODE_ENV } from "../src/lib/codex-readonly.js";
import { ACP_AGENT_ENV } from "../src/lib/acp/stub.js";

const spec = (over: Partial<AdapterEnvSpec> = {}): AdapterEnvSpec => ({
  base: { PATH: "/usr/bin", HOME: "/home/u" }, bunBin: "/bin/bun", channelServer: "/repo/src/channel-server.ts", mcpName: "claudestra",
  codexPath: "/bin/codex", logsDir: "/tmp/logs", channel: { channelId: "c1", proxyUrl: "ws://127.0.0.1:1/p?t=x", agentName: "agent-ro", sessionId: "s1" },
  ...over,
});
const config = (env: Record<string, string>) => JSON.parse(env.CODEX_CONFIG!) as Record<string, unknown>;
/** PM 点名不放行的工具（规格「PM 补」ask_mvcasmjceab61a99dd） */
const DENIED_TOOLS = ["ask_codex", "start_node", "plan_feature", "rewrite_dag", "record_memory", "mark_memory", "save_handoff",
  "take_order", "take_review", "submit_verdict", "deliver", "forward_to_agent", "edit_message", "react", "fleet"];

describe("adapterEnv", () => {
  test("[验收线 2] readOnly（显式档位）→ 只读预设；线程级默认也压成只读；channel-server 拿得到档位", () => {
    const env = adapterEnv(spec({ permissionMode: "readOnly" }));
    expect(env.INITIAL_AGENT_MODE).toBe(ACP_READONLY_PRESET);
    expect(config(env)).toMatchObject({ sandbox_mode: "read-only", approval_policy: "never" });
    expect(env[PERMISSION_MODE_ENV]).toBe("readOnly");
  });

  test("只读档：只在 claudestra 这一个 server 上放行白名单工具的审批；点名的工具一个都不放行；非只读不注入任何审批配置", () => {
    const ro = config(adapterEnv(spec({ permissionMode: "readOnly" }))) as { mcp_servers: Record<string, Record<string, unknown>> };
    expect(Object.keys(ro.mcp_servers)).toEqual(["claudestra"]);
    const tools = ro.mcp_servers.claudestra!.tools as Record<string, unknown>;
    expect(tools).toEqual(Object.fromEntries(["reply", "send_to_agent", "check_inbox", "fetch_messages", "whoami"].map((t) => [t, { approval_mode: "approve" }])));
    for (const t of DENIED_TOOLS) expect(tools[t]).toBeUndefined();
    const raw = adapterEnv(spec({ permissionMode: "readOnly" })).CODEX_CONFIG!;
    expect(raw).not.toContain("default_tools_approval_mode");
    expect(raw).not.toContain("readOnlyHint");
    const rw = adapterEnv(spec()).CODEX_CONFIG!;
    expect(rw).not.toContain("approval_mode");
    expect(rw).not.toContain('"tools"');
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

describe("会话建好后读回生效策略（PM 补 ask_mvcaa4ue7b42c6d2e3 (B)）", () => {
  const RO = { CODEX_PATH: "/c", INITIAL_AGENT_MODE: ACP_READONLY_PRESET };
  const policyOf = (env: Record<string, string>) => {
    const r = parseAdapterEnv(env);
    if (!r.ok) throw new Error(r.why);
    return r.cfg.policy;
  };
  const opened = (id: string, sandbox: unknown, approvalPolicy: unknown) => ({ thread: { id }, model: "gpt-x", modelProvider: "fake", reasoningEffort: null, sandbox, approvalPolicy });
  const RO_OK = [{ type: "readOnly", networkAccess: false }, "never"] as const;

  test("纯函数：只读预设下只认「readOnly 沙箱、不联网、never」；其它预设不核", () => {
    const p = policyOf(RO);
    expect(readOnlyPolicyMismatch(p, opened("t", ...RO_OK))).toBeNull();
    expect(readOnlyPolicyMismatch(p, opened("t", { type: "readOnly" }, "never"))).toBeNull(); // networkAccess 缺省 false
    for (const [sb, ap] of [[{ type: "dangerFullAccess" }, "never"], [{ type: "readOnly", networkAccess: true }, "never"], [{ type: "readOnly" }, "on-request"],
      [{ type: "workspaceWrite", writableRoots: [] }, "never"], [undefined, undefined]] as const) {
      expect(readOnlyPolicyMismatch(p, opened("t", sb, ap))).toContain("不是只读 + never");
    }
    expect(readOnlyPolicyMismatch(policyOf({ CODEX_PATH: "/c", INITIAL_AGENT_MODE: "agent-full-access" }), opened("t", undefined, undefined))).toBeNull();
    expect(readOnlyPolicyMismatch(policyOf({ CODEX_PATH: "/c", INITIAL_AGENT_MODE: "read-only" }), opened("t", { type: "readOnly" }, "on-request"))).toBeNull();
  });

  test("适配器：session/new 读回是只读 + never 才接上", async () => {
    const f = fakeApp();
    f.on("thread/start", () => opened(f.thread, ...RO_OK));
    const h = harness({ fake: f, env: { INITIAL_AGENT_MODE: ACP_READONLY_PRESET } });
    await h.session.initialize();
    expect(await h.session.create("/w")).toBe("th-1");
    expect(h.causes).toEqual([]);
  });

  test("适配器：new / resume / fork 读回不符 → 拒这次打开、带 fatal、停掉适配器", async () => {
    for (const kind of ["new", "resume", "fork"] as const) {
      const f = fakeApp();
      const bad = () => opened(kind === "fork" ? "fork-1" : f.thread, { type: "dangerFullAccess" }, "never");
      f.on(`thread/${kind === "new" ? "start" : kind}`, bad);
      const h = harness({ fake: f, env: { INITIAL_AGENT_MODE: ACP_READONLY_PRESET } });
      await h.session.initialize();
      const err = await (kind === "new" ? h.session.create("/w") : kind === "resume" ? h.session.attach("th-1", "/w", true) : h.session.fork("th-1", "/w")).catch((e) => e);
      expect(err).toBeInstanceOf(Error);
      expect(err.message).toContain("不是只读 + never");
      expect(err.data).toMatchObject({ fatal: true });
      expect(h.causes).toEqual([{ kind: "protocol", why: expect.stringContaining("dangerFullAccess") }]);
    }
  });
});
