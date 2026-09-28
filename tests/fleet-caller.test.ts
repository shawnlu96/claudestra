/**
 * lib/fleet-caller.ts：ws 调 fleet 时的调用方判定矩阵，以及按调用方收窄候选（PM 只管自己的项目、不动大总管、不动自己）。
 */
import { describe, expect, test } from "bun:test";
import { FLEET_DENIED, identifyFleetCaller, scopeForCaller, visibleToCaller, type CallerInput, type FleetCaller } from "../src/lib/fleet-caller.js";
import { selectTargets, type Excluded, type FleetCandidate, type FleetSelect } from "../src/lib/fleet-plan.js";

const CONTROL = "ctl-1";
const PMS = new Map<string, string[]>([
  ["claude-orchestrator", ["agent-claudestra", "agent-pm-dispatch"]],
  ["side", ["agent-side-pm"]],
]);
const base = (o: Partial<CallerInput>): CallerInput => ({
  channels: ["ch-x"], mcp: true, controlChannelId: CONTROL, agent: null, pmsByProject: PMS, callers: [], ...o,
});

describe("调用方判定矩阵", () => {
  test("大总管：按控制频道认，管全部", () => {
    expect(identifyFleetCaller(base({ channels: [CONTROL] }))).toEqual({ kind: "ok", caller: { kind: "master", name: "master", projects: null } });
  });

  test("PM：台账 pms 上的 agent，只管自己是 PM 的项目", () => {
    const r = identifyFleetCaller(base({ agent: { name: "agent-claudestra" } }));
    expect(r).toEqual({ kind: "ok", caller: { kind: "pm", name: "agent-claudestra", projects: ["claude-orchestrator"] } });
  });

  test("同一个 agent 是多个项目的 PM：项目取并集", () => {
    const pms = new Map([["b", ["agent-x"]], ["a", ["x"]]]);
    const r = identifyFleetCaller(base({ agent: { name: "agent-x" }, pmsByProject: pms }));
    expect(r.kind === "ok" && r.caller.projects).toEqual(["a", "b"]);
  });

  test("fleet.callers：显式列出的管全部，带不带 agent- 前缀都认", () => {
    for (const callers of [["ops"], ["agent-ops"]]) {
      expect(identifyFleetCaller(base({ agent: { name: "agent-ops" }, callers }))).toEqual({ kind: "ok", caller: { kind: "caller", name: "agent-ops", projects: null } });
    }
  });

  test("普通 agent、执行者一律拒，报「只有大总管和 PM 能用」", () => {
    for (const name of ["agent-codex", "agent-task-t43"]) expect(identifyFleetCaller(base({ agent: { name } }))).toEqual({ kind: "deny", error: FLEET_DENIED });
  });

  test("开了 external（peer 能调进来）的：即使是 PM 或在 fleet.callers 里也拒", () => {
    for (const o of [{}, { callers: ["claudestra"] }]) {
      const r = identifyFleetCaller(base({ agent: { name: "agent-claudestra", external: true }, ...o }));
      expect(r.kind).toBe("deny");
      expect(r.kind === "deny" && r.error).toContain("external");
    }
  });

  test("注册了但 registry 里查不到的频道：拒", () => {
    const r = identifyFleetCaller(base({ agent: null }));
    expect(r.kind === "deny" && r.error).toContain("不在 registry 里");
  });

  test("没注册的连接：MCP 请求拒（不许掉进 CLI 分支），manager CLI 走 cli", () => {
    expect(identifyFleetCaller(base({ channels: [], mcp: true })).kind).toBe("deny");
    expect(identifyFleetCaller(base({ channels: [], mcp: false }))).toEqual({ kind: "cli" });
  });

  test("一条连接注册了多个频道：含控制频道算大总管，否则认不准、拒", () => {
    expect(identifyFleetCaller(base({ channels: ["ch-x", CONTROL] })).kind === "ok").toBe(true);
    const r = identifyFleetCaller(base({ channels: ["ch-x", "ch-y"], agent: { name: "agent-claudestra" } }));
    expect(r.kind === "deny" && r.error).toContain("认不准");
  });

  test("请求里自报的名字不参与判定：只看连接的频道", () => {
    // 输入里根本没有「自报名字」的位置；控制频道之外的频道不会因为名字叫 master 就成大总管
    expect(identifyFleetCaller(base({ agent: { name: "master" } })).kind).toBe("deny");
  });
});

const c = (name: string, o: Partial<FleetCandidate> = {}): FleetCandidate => ({ name, runtime: "claude-code", master: false, online: true, ...o });
const FLEET: FleetCandidate[] = [
  c("agent-claudestra", { project: "claude-orchestrator" }),
  c("agent-task-t43", { project: "claude-orchestrator" }),
  c("agent-task-t35", { project: "claude-orchestrator" }),
  c("agent-other", { project: "side" }),
  c("agent-loose"),
  c("master", { master: true }),
];
const PM: FleetCaller = { kind: "pm", name: "agent-claudestra", projects: ["claude-orchestrator"] };
const MASTER: FleetCaller = { kind: "master", name: "master", projects: null };
const OPS: FleetCaller = { kind: "caller", name: "agent-ops", projects: null };

function run(caller: FleetCaller, sel: FleetSelect, action: Parameters<typeof scopeForCaller>[1] = "lp-off"): { error?: string; targets: string[]; excluded: Excluded[] } {
  const s = scopeForCaller(caller, action, sel, FLEET);
  if (!s.ok) return { error: s.error, targets: [], excluded: [] };
  const r = selectTargets(s.cands, s.select);
  return { targets: r.targets.map((t) => t.name), excluded: [...s.excluded, ...r.excluded] };
}

describe("按调用方收窄", () => {
  test("PM 的 all 只展开到自己的项目，还剔掉自己并说明", () => {
    const r = run(PM, { all: true });
    expect(r.targets).toEqual(["agent-task-t43", "agent-task-t35"]);
    expect(r.excluded).toEqual([{ name: "claudestra", reason: expect.stringContaining("调用方自己") }]);
  });

  test("PM 点名别的项目的 agent：不做，附原因，不再报「没有这个 agent」", () => {
    const r = run(PM, { agents: ["other", "task-t43"] });
    expect(r.targets).toEqual(["agent-task-t43"]);
    expect(r.excluded).toEqual([{ name: "other", reason: "不在你管的项目里" }]);
  });

  test("PM 指定不归它管的项目：整个请求报错", () => {
    expect(run(PM, { project: "side" }).error).toContain("不是项目 side 的 PM");
  });

  test("没归属项目的 agent 不在 PM 范围里", () => {
    expect(run(PM, { agents: ["loose"] }).excluded).toEqual([{ name: "loose", reason: "不在你管的项目里" }]);
  });

  test("点名自己做压缩类动作：整个请求报错", () => {
    for (const a of ["compact", "lp-compact", "save-compact"] as const) {
      expect(run(PM, { agents: ["claudestra", "task-t43"] }, a).error).toContain("不能对自己压缩");
    }
    expect(run(MASTER, { agents: ["master"] }, "compact").error).toContain("不能动大总管"); // 大总管点名自己：先撞这一条
  });

  test("点名自己做非压缩动作：自己剔掉附原因，其余照做", () => {
    const r = run(PM, { agents: ["agent-claudestra", "task-t35"] }, "text");
    expect(r.targets).toEqual(["agent-task-t35"]);
    expect(r.excluded).toEqual([{ name: "claudestra", reason: expect.stringContaining("调用方自己") }]);
  });

  test("经 all / project 带进来的自己：放进 excluded，不报错", () => {
    expect(run(PM, { project: "claude-orchestrator" }, "compact").excluded.map((e) => e.name)).toEqual(["claudestra"]);
    expect(run(PM, { all: true }, "lp-compact").targets).not.toContain("agent-claudestra");
  });

  test("大总管永远不选：点名（带不带前缀）或 includeMaster 都整个报错，和 CLI 同一条线", () => {
    for (const sel of [{ agents: ["master", "loose"] }, { agents: ["agent-master"] }, { all: true, includeMaster: true }]) {
      expect(run(OPS, sel).error).toBe("fleet 不能动大总管：大总管只由 owner 在网页上操作");
    }
    expect(run(OPS, { all: true }).targets).not.toContain("master");
  });

  test("大总管 / fleet.callers 管全部（大总管自己和 master 除外）", () => {
    expect(run(MASTER, { all: true }).targets).toEqual(["agent-claudestra", "agent-task-t43", "agent-task-t35", "agent-other", "agent-loose"]);
    expect(run(OPS, { project: "side" }).targets).toEqual(["agent-other"]);
  });

  test("点名的全被收掉：一个都不选，但每个都有原因", () => {
    const r = run(PM, { agents: ["loose", "other"] });
    expect(r.targets).toEqual([]);
    expect(r.excluded.map((e) => e.name).sort()).toEqual(["loose", "other"]);
  });

  test("state 的可见范围和 run 一致", () => {
    expect(visibleToCaller(PM, FLEET).map((x) => x.name)).toEqual(["agent-claudestra", "agent-task-t43", "agent-task-t35"]);
    expect(visibleToCaller(MASTER, FLEET).map((x) => x.name)).not.toContain("master");
  });
});
