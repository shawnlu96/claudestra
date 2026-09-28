/**
 * src/manager/team.ts 的纯函数：--parent / --task 解析、parent 校验（不存在 / 自指 / 环 / none / master）、
 * 按 DISCORD_CHANNEL_ID 自动反查派发者（只在带 --task 时）、resume 保留字段、rename / remove 同步子 agent。不碰真实 registry。
 */
import { describe, expect, test } from "bun:test";
import {
  autoParent, extractTeamFlags, keepOnResume, parentKey, repointParentRefs, resolveTeamFields, validateParent, validateTask,
} from "../src/manager/team";
import type { AgentInfo, Registry } from "../src/manager/core";

const agents = {
  "agent-claudestra": { channelId: "c-pm" },
  "agent-t1": { channelId: "c-t1", parent: "agent-claudestra" },
  "agent-t1a": { channelId: "c-t1a", parent: "agent-t1" },
  "agent-orphan": { channelId: "c-o", parent: "agent-gone" }, // 祖先已被 remove
  "agent-loop1": { parent: "agent-loop2" },
  "agent-loop2": { parent: "agent-loop1" }, // 历史脏数据里已有的环
};
const env = { channelId: undefined as string | undefined };

describe("extractTeamFlags", () => {
  test("--parent x / --parent=x / --task 多词 / 其余参数原样留下", () => {
    const r = extractTeamFlags(["t9", "--parent", "claudestra", "/repo", "--task", "T9 值守卡片", "--external"]);
    expect(r.flags).toEqual({ parent: "claudestra", task: "T9 值守卡片" });
    expect(r.rest).toEqual(["t9", "/repo", "--external"]);
    expect(extractTeamFlags(["--parent=master", "--task=x"]).flags).toEqual({ parent: "master", task: "x" });
  });
  test("没写 = undefined（create 走自动反查）；--task 空串保留（team-link 用来清除）", () => {
    expect(extractTeamFlags(["a", "b"])).toEqual({ rest: ["a", "b"], flags: {}, error: undefined });
    expect(extractTeamFlags(["a", "--task", ""]).flags).toEqual({ task: "" });
    expect(extractTeamFlags(["a", "--task="]).flags).toEqual({ task: "" });
  });
  test("缺值 → error，不悄悄当成「不挂」覆盖自动反查的结果", () => {
    expect(extractTeamFlags(["a", "b", "--task", "T", "--parent"]).error).toContain("--parent");
    expect(extractTeamFlags(["a", "--parent="]).error).toContain("--parent");
    expect(extractTeamFlags(["a", "--parent", "  "]).error).toContain("--parent");
    expect(extractTeamFlags(["a", "--task"]).error).toContain("--task");
    expect(extractTeamFlags(["a", "--parent", "none"]).error).toBeUndefined();
  });
});

describe("validateParent / parentKey", () => {
  test("存在的 agent、大总管（不在 registry 也合法）、已停止的都可以当派发者", () => {
    expect(validateParent(agents, "agent-new", "agent-claudestra")).toBeNull();
    expect(validateParent(agents, "agent-new", "master")).toBeNull();
    expect(validateParent({ "agent-s": { parent: undefined } }, "agent-new", "agent-s")).toBeNull();
  });
  test("不存在 / 自指 / 成环 → 拒绝", () => {
    expect(validateParent(agents, "agent-new", "agent-nope")).toContain("不存在");
    expect(validateParent(agents, "agent-t1", "agent-t1")).toContain("自己");
    expect(validateParent(agents, "agent-claudestra", "agent-t1a")).toContain("成环"); // t1a → t1 → claudestra
    expect(validateParent(agents, "agent-t1", "agent-t1a")).toContain("成环");
  });
  test("祖先悬空、链上已有别的环：停在原地不死循环，也不误报", () => {
    expect(validateParent(agents, "agent-new", "agent-orphan")).toBeNull();
    expect(validateParent(agents, "agent-new", "agent-loop1")).toBeNull();
  });
  test("大总管不能当子 agent；名字归一（master 各种写法、裸名补前缀、大小写）", () => {
    expect(validateParent(agents, "agent-master", "agent-claudestra")).toContain("大总管");
    expect(parentKey("master")).toBe("master");
    expect(parentKey("agent-master")).toBe("master");
    expect(parentKey("Claudestra")).toBe("agent-claudestra");
    expect(parentKey("agent-t1")).toBe("agent-t1");
  });
  test("task：≤40 字、不含控制 / 方向控制符", () => {
    expect(validateTask("T3 值守卡片")).toBeNull();
    expect(validateTask("字".repeat(41))).toContain("40");
    expect(validateTask("a‮b")).toContain("控制");
  });
});

describe("autoParent（按调用者的 DISCORD_CHANNEL_ID 反查）", () => {
  test("频道对上某个 agent → 它", () => {
    expect(autoParent(agents, "c-pm", "agent-new")).toBe("agent-claudestra");
  });
  test("没有变量 / 反查不到 / 大总管的控制频道（不在 registry）→ 不设", () => {
    expect(autoParent(agents, undefined, "agent-new")).toBeUndefined();
    expect(autoParent(agents, "c-unknown", "agent-new")).toBeUndefined();
    expect(autoParent(agents, "c-control", "agent-new")).toBeUndefined();
  });
  test("反查到的是自己（同名重建）→ 不设，免得自指", () => {
    expect(autoParent(agents, "c-t1", "agent-t1")).toBeUndefined();
  });
});

describe("resolveTeamFields（create 前）", () => {
  test("自动反查只在带 --task 时生效：普通建会话（大总管建常驻 agent 的标准做法）不挂", () => {
    const e = { channelId: "c-pm" };
    expect(resolveTeamFields(agents, "agent-new", {}, e)).toEqual({});
    expect(resolveTeamFields(agents, "agent-new", { task: "T9" }, e)).toEqual({ parent: "agent-claudestra", task: "T9" });
  });
  test("大总管只认显式 --parent master（从控制频道带 --task 建也不自动挂）", () => {
    expect(resolveTeamFields(agents, "agent-new", { task: "T" }, { channelId: "c-control" })).toEqual({ task: "T" });
    expect(resolveTeamFields(agents, "agent-new", { parent: "master" }, { channelId: "c-control" })).toEqual({ parent: "master" });
  });
  test("显式 --parent 覆盖自动值；none 显式不挂", () => {
    const e = { channelId: "c-pm" };
    expect(resolveTeamFields(agents, "agent-new", { parent: "t1", task: " T9 " }, e)).toEqual({ parent: "agent-t1", task: "T9" });
    expect(resolveTeamFields(agents, "agent-new", { parent: "none", task: "T9" }, e)).toEqual({ task: "T9" });
  });
  test("自动反查的结果也过校验：重建一个已停止的同名 agent 时会成环 → 不挂（不拒绝 create）", () => {
    // agent-x 挂在已停止的 agent-new 下；在 agent-x 的会话里重建同名 agent-new → 反查到 agent-x，挂上就成环
    const withOrphan = { ...agents, "agent-x": { channelId: "c-x", parent: "agent-new" } };
    expect(resolveTeamFields(withOrphan, "agent-new", { task: "T" }, { channelId: "c-x" })).toEqual({ task: "T" });
  });
  test("不合法 → error（调用方在拉起 agent 之前拒绝 create）", () => {
    expect(resolveTeamFields(agents, "agent-new", { parent: "nope" }, env)).toHaveProperty("error");
    expect(resolveTeamFields(agents, "agent-new", { task: "字".repeat(41) }, env)).toHaveProperty("error");
  });
});

describe("keepOnResume / repointParentRefs", () => {
  const info = (x: Partial<AgentInfo>) => ({ project: "", purpose: "", created: "", status: "active", channelId: "", notes: "", cwd: "", ...x }) as AgentInfo;
  test("resume 重写条目时保留 parent / task / label；没有的不凭空加键", () => {
    expect(keepOnResume(info({ parent: "master", task: "T", label: "L", purpose: "旧" }), "s2")).toEqual({ parent: "master", task: "T", label: "L" });
    expect(keepOnResume(info({}), "s1")).toEqual({});
    expect(keepOnResume(undefined, "s1")).toEqual({});
  });
  test("external 只在接的还是同一个会话时保留：resume 到无关 sessionId 不能让 peer scope 覆盖到新会话", () => {
    const prior = info({ external: true, sessionId: "s1", parent: "agent-p" });
    expect(keepOnResume(prior, "s1")).toEqual({ parent: "agent-p", external: true });
    expect(keepOnResume(prior, "s-other")).toEqual({ parent: "agent-p" });
  });
  test("rename：挂在旧名下的子 agent 一起改指新名，别的不动", () => {
    const reg: Registry = {
      socket: "",
      agents: { "agent-new": info({}), "agent-c1": info({ parent: "agent-old" }), "agent-c2": info({ parent: "agent-other" }) },
    };
    repointParentRefs(reg, "agent-old", "agent-new");
    expect(reg.agents["agent-c1"].parent).toBe("agent-new");
    expect(reg.agents["agent-c2"].parent).toBe("agent-other");
  });
  test("kill 后同名重建（create 覆盖已停止的条目）：旧子 agent 不认新 agent 作父", () => {
    const reg: Registry = { socket: "", agents: { "agent-x": info({ status: "stopped" }), "agent-oldkid": info({ parent: "agent-x", task: "旧任务" }) } };
    repointParentRefs(reg, "agent-x"); // cmdCreate 写新条目前的同一调用
    expect("parent" in reg.agents["agent-oldkid"]).toBe(false);
  });
  test("remove：清掉指向被删 agent 的 parent（键本身删掉），别的不动", () => {
    const reg: Registry = { socket: "", agents: { "agent-c1": info({ parent: "agent-gone", task: "T" }), "agent-c2": info({ parent: "agent-other" }) } };
    repointParentRefs(reg, "agent-gone");
    expect("parent" in reg.agents["agent-c1"]).toBe(false);
    expect(reg.agents["agent-c1"].task).toBe("T");
    expect(reg.agents["agent-c2"].parent).toBe("agent-other");
  });
});
