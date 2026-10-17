/**
 * agents-CODEXRO1 验收线 1：tmux 路径的只读档。codexPermissionFlags("readOnly") = 只读沙箱 + 从不审批，任何形状都不带 bypass；
 * 老两档逐字不变、未知档位照旧报错；启动命令与 exec 引导都按档位拼。
 */
import { describe, expect, test } from "bun:test";
import { bootstrapArgs, buildCodexCommand, CODEX_MCP_ENV_VARS, codexPermissionFlags, type CodexLaunchSpec } from "../src/lib/codex-launch.js";
import { PERMISSION_MODE_ENV, READ_ONLY_MCP_TOOLS } from "../src/lib/codex-readonly.js";

const BYPASS = "--dangerously-bypass-approvals-and-sandbox";
/** PM 点名不放行的工具（规格「PM 补」ask_mvcasmjceab61a99dd） */
const DENIED_TOOLS = ["ask_codex", "start_node", "plan_feature", "rewrite_dag", "record_memory", "mark_memory", "save_handoff",
  "take_order", "take_review", "submit_verdict", "deliver", "forward_to_agent", "edit_message", "react", "fleet"];
const SID = "01a0ca4b-ebca-7b23-b5a2-87941f333018";
const spec = (over: Partial<CodexLaunchSpec> = {}): CodexLaunchSpec => ({
  mode: "resume", sessionId: SID, agentName: "agent-x", channelId: "999000111", bridgeUrl: "ws://127.0.0.1:3847", bridgePort: "3847",
  cwd: "/tmp/work dir", codexBin: "/opt/homebrew/bin/codex", bunBin: "/opt/homebrew/bin/bun", claudestraHome: "/repo", ...over,
});
const boot = (permissionMode?: string) => bootstrapArgs({ codexBin: "/bin/codex", cwd: "/tmp/w", permissionMode, channelRules: "rules" });

describe("codexPermissionFlags", () => {
  test("[验收线 1] readOnly：TUI 是 --sandbox read-only --ask-for-approval never，不带 bypass", () => {
    const f = codexPermissionFlags("readOnly");
    expect(f).toEqual(["--sandbox", "read-only", "--ask-for-approval", "never"]);
    expect(f).not.toContain(BYPASS);
    expect(codexPermissionFlags(" readOnly ")).toEqual(f);
  });

  test("[验收线 1] readOnly 的 exec 形状：exec 没有 -a，审批走 -c approval_policy，同样不带 bypass", () => {
    const f = codexPermissionFlags("readOnly", "exec");
    expect(f).toEqual(["--sandbox", "read-only", "-c", 'approval_policy="never"']);
    expect(f).not.toContain(BYPASS);
  });

  test("[验收线 1] bypassPermissions / auto / 缺省逐字不变", () => {
    for (const m of ["bypassPermissions", "auto", undefined, "", "  "]) {
      expect(codexPermissionFlags(m)).toEqual([BYPASS]);
      expect(codexPermissionFlags(m, "exec")).toEqual([BYPASS]);
    }
  });

  test("[验收线 1] 未知档位照旧报错（含大小写不对的 readonly）", () => {
    for (const m of ["default", "plan", "acceptEdits", "dontAsk", "readonly", "read-only"]) expect(() => codexPermissionFlags(m)).toThrow(/不支持权限模式/);
  });
});

describe("启动命令与引导", () => {
  test("readOnly 的 TUI 命令：带只读两项、不带 bypass，前缀报档位给 channel-server", () => {
    const cmd = buildCodexCommand(spec({ permissionMode: "readOnly" }), "rules");
    expect(cmd).toContain(" --sandbox read-only --ask-for-approval never ");
    expect(cmd).not.toContain(BYPASS.slice(2));
    expect(cmd).toContain(`${PERMISSION_MODE_ENV}=readOnly `);
  });

  test("fork 同样只读", () => {
    const cmd = buildCodexCommand(spec({ mode: "fork", permissionMode: "readOnly" }), "rules");
    expect(cmd).toContain(" fork ");
    expect(cmd).toContain("--sandbox read-only --ask-for-approval never");
    expect(cmd).not.toContain(BYPASS.slice(2));
  });

  test("非只读的命令不带档位变量、仍是 bypass", () => {
    const cmd = buildCodexCommand(spec(), "rules");
    expect(cmd).toContain(BYPASS);
    expect(cmd).not.toContain(`${PERMISSION_MODE_ENV}=`);
    expect(cmd).not.toContain("--sandbox");
  });

  test("[验收线 1] exec 引导那一轮也只读", () => {
    const a = boot("readOnly");
    expect(a).not.toContain(BYPASS);
    const i = a.indexOf("--sandbox");
    expect(a.slice(i, i + 4)).toEqual(["--sandbox", "read-only", "-c", 'approval_policy="never"']);
    expect(boot()).toContain(BYPASS);
  });

  test("只读档只给 claudestra 这一个 server 的白名单工具放行审批（never 下其余工具即拒），非只读不注入任何审批配置", () => {
    expect([...READ_ONLY_MCP_TOOLS]).toEqual(["reply", "send_to_agent", "check_inbox", "fetch_messages", "whoami"]);
    const cmd = buildCodexCommand(spec({ permissionMode: "readOnly" }), "rules");
    const approved = [...cmd.matchAll(/'mcp_servers\.([\w-]+)\.tools\.([\w-]+)\.approval_mode="approve"'/g)].map((m) => `${m[1]}.${m[2]}`);
    expect(approved).toEqual(READ_ONLY_MCP_TOOLS.map((t) => `claudestra.${t}`));
    for (const t of DENIED_TOOLS) expect(cmd).not.toContain(`tools.${t}.`);
    expect(cmd).not.toContain("default_tools_approval_mode");
    expect(cmd).not.toContain("readOnlyHint");
    const rw = buildCodexCommand(spec(), "rules");
    expect(rw).not.toContain("approval_mode");
    expect(rw).not.toContain(".tools.");
  });

  test("channel-server 的环境白名单带档位变量（whoami 读得到）", () => {
    expect(CODEX_MCP_ENV_VARS as readonly string[]).toContain(PERMISSION_MODE_ENV);
  });
});
