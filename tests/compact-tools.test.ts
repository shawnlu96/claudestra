import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { SAVE_HANDOFF_TOOL, saveHandoffTool } from "../src/lib/compact-tools.ts";

describe("save_handoff 工具声明", () => {
  test("只有 opId / text 两个参数，都必填，不收额外字段（没有路径 / 名字参数）", () => {
    expect(SAVE_HANDOFF_TOOL.name).toBe("save_handoff");
    expect(Object.keys(SAVE_HANDOFF_TOOL.inputSchema.properties).sort()).toEqual(["opId", "text"]);
    expect(SAVE_HANDOFF_TOOL.inputSchema.required).toEqual(["opId", "text"]);
    expect(SAVE_HANDOFF_TOOL.inputSchema.additionalProperties).toBe(false);
  });

  test("channel-server 的工具列表和 dispatch 都接上了（薄接线）", () => {
    const src = readFileSync(join(import.meta.dir, "../src/channel-server.ts"), "utf8");
    expect(src).toContain("FLEET_TOOL, SAVE_HANDOFF_TOOL, WHOAMI_TOOL");
    expect(src).toContain('case "save_handoff": return saveHandoffTool(bridgeRequest, args);');
  });
});

describe("saveHandoffTool", () => {
  test("参数原样交 bridge：只带 type / opId / text，调用方塞的 agent / path / callerCred 都不转", async () => {
    const sent: any[] = [];
    const r = await saveHandoffTool(async (m) => (sent.push(m), { path: "/s/handoff/a/HANDOFF.md", opId: "op-1", bytes: 3, savedAt: "t" }),
      { opId: "op-1", text: "abc", agent: "agent-pm", path: "/etc/x", callerCred: "f".repeat(64) });
    expect(sent).toEqual([{ type: "save_handoff", opId: "op-1", text: "abc" }]);
    expect(r.isError).toBeUndefined();
    expect(r.content[0]!.text).toContain("/s/handoff/a/HANDOFF.md");
    expect(r.content[0]!.text).toContain("压缩另行进行");
  });

  test("不在本地校验内容：空文本也交 bridge 判；bridge 报错原样当工具错误返回", async () => {
    const sent: any[] = [];
    const r = await saveHandoffTool(async (m) => { sent.push(m); throw new Error("交接正文不能为空"); }, { opId: "op-1", text: "" });
    expect(sent).toEqual([{ type: "save_handoff", opId: "op-1", text: "" }]);
    expect(r.isError).toBe(true);
    expect(r.content[0]!.text).toContain("交接正文不能为空");
  });
});
