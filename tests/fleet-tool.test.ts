/**
 * lib/fleet-tool.ts：MCP 工具参数 → ws 请求（dryRun 默认 true、不收 keep、text 限长）、结果排版、错误原样返回。
 */
import { describe, expect, test } from "bun:test";
import { MCP_TEXT_MAX } from "../src/lib/fleet-caller.js";
import { buildFleetRequest, FLEET_TOOL, fleetTool, formatFleetRun, formatFleetState } from "../src/lib/fleet-tool.js";

const msgOf = (args: Record<string, unknown>) => {
  const b = buildFleetRequest(args);
  if (!b.ok) throw new Error(b.error);
  return b.msg;
};

describe("参数 → 请求", () => {
  test("state", () => {
    expect(msgOf({ op: "state" })).toEqual({ type: "fleet_state", via: "mcp" });
  });

  test("dryRun 默认 true：不传、传 true、传字符串 \"false\" 都是预演；只有布尔 false 才真执行", () => {
    const run = (dryRun?: unknown) => msgOf({ op: "run", action: "lp_off", select: { all: true }, ...(dryRun === undefined ? {} : { dryRun }) }).dryRun;
    expect(run()).toBe(true);
    expect(run(true)).toBe(true);
    expect(run("false")).toBe(true);
    expect(run(0)).toBe(true);
    expect(run(false)).toBe(false);
  });

  test("动作名映射到 T35 的 kind", () => {
    const kinds = ["lp_on", "lp_off", "lp_compact", "compact", "save_compact"].map((a) => (msgOf({ op: "run", action: a, select: { all: true } }).action as { kind: string }).kind);
    expect(kinds).toEqual(["lp-on", "lp-off", "lp-compact", "compact", "save-compact"]);
    for (const bad of ["clear", "lp-on", "", undefined]) expect(buildFleetRequest({ op: "run", action: bad, select: { all: true } }).ok).toBe(false);
  });

  test("请求里没有任何身份字段：调用方只由 bridge 按连接认", () => {
    const m = msgOf({ op: "run", action: "compact", select: { all: true }, actor: "owner", caller: "master", via: "cli" });
    expect(m.via).toBe("mcp");
    expect(Object.keys(m).sort()).toEqual(["action", "dryRun", "select", "type", "via"]);
  });

  test("不收 keep", () => {
    const b = buildFleetRequest({ op: "run", action: "compact", select: { all: true }, keep: "只留这些" });
    expect(b.ok === false && b.error).toContain("keep");
  });

  test("text：必须非空、不超过上限", () => {
    expect(buildFleetRequest({ op: "run", action: "text", select: { all: true } }).ok).toBe(false);
    expect(buildFleetRequest({ op: "run", action: "text", select: { all: true }, text: "  " }).ok).toBe(false);
    expect(buildFleetRequest({ op: "run", action: "text", select: { all: true }, text: "x".repeat(MCP_TEXT_MAX + 1) }).ok).toBe(false);
    expect((msgOf({ op: "run", action: "text", select: { all: true }, text: "请同步一下进度" }).action as { text: string }).text).toBe("请同步一下进度");
  });

  test("select 必须是对象；op 必须是 state / run", () => {
    expect(buildFleetRequest({ op: "run", action: "compact" }).ok).toBe(false);
    expect(buildFleetRequest({ op: "run", action: "compact", select: ["a"] }).ok).toBe(false);
    expect(buildFleetRequest({ op: "kill" }).ok).toBe(false);
    expect(buildFleetRequest({}).ok).toBe(false);
  });
});

describe("工具说明与排版", () => {
  test("说明里写清谁能调、先 state 再预演再执行", () => {
    expect(FLEET_TOOL.description).toContain("只有大总管和 PM");
    expect(FLEET_TOOL.description).toContain("dryRun 默认就是 true");
    expect(FLEET_TOOL.inputSchema.properties).not.toHaveProperty("keep");
  });

  test("state：每个 agent 一行", () => {
    const text = formatFleetState({
      agents: [
        {
          name: "agent-task-t43", project: "claude-orchestrator", runtime: "claude-code", online: true,
          lowPriority: "on", lp: { resetsAt: "3:20am", allowancePct: 91, busy: true }, contextTokens: 182_400,
        },
        { name: "agent-b", runtime: "claude-code", online: true, lowPriority: "off", walled: true, lp: { resetsAt: "4am", offer: true, busy: false } },
        { name: "agent-pi", runtime: "pi", online: false },
      ],
    });
    expect(text).toContain("- task-t43 [claude-orchestrator]：在线 · 忙 · LP 开（到 3:20am），LP 额度余 91% · 上下文 182k");
    expect(text).toContain("- b：在线 · 闲 · 撞墙等待（4am 恢复），可开 LP");
    expect(text).toContain("- pi：离线 · pi");
    expect(formatFleetState({ agents: [] })).toContain("没有 agent");
  });

  test("预演：列出不做的和原因，提示下一步", () => {
    const t = formatFleetRun({ dryRun: true, summary: "预演：会对 1 个 agent 执行（a）", targets: ["agent-a"], excluded: [{ name: "claudestra", reason: "调用方自己" }] });
    expect(t).toContain("- claudestra：不做（调用方自己）");
    expect(t).toContain("dryRun:false");
    expect(formatFleetRun({ dryRun: true, targets: [], excluded: [] })).toContain("没有选中任何 agent");
  });

  test("bridge 拒绝：原样当工具错误返回", async () => {
    const r = await fleetTool(async () => { throw new Error("只有大总管和 PM 能用 fleet"); }, { op: "state" });
    expect(r).toEqual({ content: [{ type: "text", text: "只有大总管和 PM 能用 fleet" }], isError: true });
  });

  test("run 给 10 分钟超时、state 给 1 分钟", async () => {
    const seen: number[] = [];
    const req = async (_m: unknown, t?: number) => { seen.push(t ?? 0); return { dryRun: false, summary: "ok" }; };
    await fleetTool(req, { op: "run", action: "lp_off", select: { all: true } });
    await fleetTool(req, { op: "state" });
    expect(seen).toEqual([600_000, 60_000]);
  });
});
