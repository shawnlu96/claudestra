/** i28-W4 lend 档 MCP：出借 worker 只看得见、只调得了派单五个工具 + whoami（src/lib/lend-mcp-profile.ts） */
import { describe, expect, test } from "bun:test";
import { LEND_MCP_TOOLS, mcpProfile, profileRefusal, profileTools } from "../src/lib/lend-mcp-profile.js";
import { ORDER_TOOLS } from "../src/lib/order-tools.js";

const ALL = ["reply", "fetch_messages", "react", "edit_message", "project_info", "list_shared_channels", "forward_to_agent", "send_to_agent",
  "check_inbox", "fleet", "whoami", "ask_codex", ...ORDER_TOOLS.map((t) => t.name)].map((name) => ({ name, inputSchema: {} }));
const LEND = { CLAUDESTRA_MCP_PROFILE: "lend", CLAUDESTRA_AGENT: "agent-lend-0123456789" };

describe("lend 档的工具列表", () => {
  test("lend 档只列六个：派单五个 + whoami，DAG / PM / 频道类一个不列", () => {
    expect(profileTools(ALL, LEND).map((t) => t.name).sort()).toEqual(["ask", "deliver", "submit_verdict", "take_order", "take_review", "whoami"]);
    expect(LEND_MCP_TOOLS.size).toBe(6);
  });

  test("档位变量丢了也不退回全量：agent 名是出借 worker 就开 lend 档", () => {
    expect(mcpProfile({ CLAUDESTRA_AGENT: "agent-lend-x" })).toBe("lend");
    expect(profileTools(ALL, { CLAUDESTRA_AGENT: "agent-lend-x" }).length).toBe(6);
  });

  test("认不出的档 = 一个工具都不给；没设档的本机 agent 原样全量（回归）", () => {
    expect(profileTools(ALL, { CLAUDESTRA_MCP_PROFILE: "full", CLAUDESTRA_AGENT: "agent-codex" })).toEqual([]);
    expect(profileTools(ALL, { CLAUDESTRA_AGENT: "agent-codex" })).toBe(ALL);
    expect(profileTools(ALL, {})).toBe(ALL);
  });

  test("lend 档里 submit_verdict 的 reportPath 描述换成工作副本里的报告，别的字段原样", () => {
    const sv = profileTools(ORDER_TOOLS, LEND).find((t) => t.name === "submit_verdict")!;
    const props = (sv.inputSchema as unknown as { properties: Record<string, { description?: string }> }).properties;
    expect(props.reportPath.description).toContain("工作副本");
    expect(Object.keys(props)).toEqual(Object.keys((ORDER_TOOLS.find((t) => t.name === "submit_verdict")!.inputSchema as { properties: object }).properties));
  });
});

describe("lend 档的调用拦截", () => {
  test("白名单外的调用一律回 isError（reply / route / fleet / check_inbox / DAG 工具都拒）", () => {
    for (const name of ["reply", "send_to_agent", "forward_to_agent", "fleet", "project_info", "check_inbox", "plan_feature", "start_node", "show_dag", "ask_codex"]) {
      const r = profileRefusal(name, LEND);
      expect(r?.isError).toBe(true);
      expect(r?.content[0].text).toContain(name);
    }
  });

  test("白名单内放行；本机 agent 什么都不拦；认不出的档全拒", () => {
    for (const name of LEND_MCP_TOOLS) expect(profileRefusal(name, LEND)).toBeNull();
    expect(profileRefusal("reply", { CLAUDESTRA_AGENT: "agent-codex" })).toBeNull();
    expect(profileRefusal("whoami", { CLAUDESTRA_MCP_PROFILE: "weird" })?.isError).toBe(true);
  });
});
