/** web/features/chat/agent-skills-logic.ts：会话详情技能栏的排序搜索、技能库页「在哪些会话里没开」 */
import { describe, expect, test } from "bun:test";
import { displaySkillName, offAgentsBySkill, sortRows, type AgentSkillRow } from "@/features/chat/agent-skills-logic";

const row = (name: string, state: AgentSkillRow["state"] = "on", description = ""): AgentSkillRow => ({
  name, description, scope: "personal", dir: `/h/${name}`, state, userInvocable: true, modelInvocable: true,
});

describe("agent-skills-logic", () => {
  test("只按名字排（切开关后行不跳）；搜索看名字和说明", () => {
    const rows = [row("b"), row("a"), row("z", "off"), row("m", "name-only", "部署到线上")];
    expect(sortRows(rows, "").map((r) => r.name)).toEqual(["a", "b", "m", "z"]);
    expect(sortRows(rows, "部署").map((r) => r.name)).toEqual(["m"]);
  });
  test("overrides → 技能: 会话列表（排序，on 不算，老 bridge 没有 overrides）", () => {
    expect(offAgentsBySkill({ "agent-b": { pdf: "off" }, master: { pdf: "name-only", save: "on" } })).toEqual({ pdf: ["agent-b", "master"] });
    expect(offAgentsBySkill(undefined)).toEqual({});
  });
  test("同步技能显示短名，其它原样", () => {
    expect(displaySkillName({ name: "anthropic-skills:pdf", scope: "synced" })).toBe("pdf");
    expect(displaySkillName({ name: "discord:access", scope: "plugin" })).toBe("discord:access");
  });
});
