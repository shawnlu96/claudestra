/** runRemove 的 archive-only 分支（出借 B 终态退休专用，src/manager/agent-kill.ts）：内存世界（tests/resumable-world.ts）里核零 kill / 零频道 / 零归档与各拒绝 */
import { describe, expect, test } from "bun:test";
import { makeWorld, normalize, type WorldState } from "./resumable-world";
import { runRemove } from "../src/manager/agent-kill";
import type { AgentInfo } from "../src/manager/core";
describe("runRemove archive-only 分支", () => {
  const info = (o: Partial<AgentInfo> = {}): AgentInfo => ({ project: "/w", purpose: "lend", created: "now", status: "stopped", channelId: "c1", notes: "",
    cwd: "/w", sessionId: "s1", kind: "worker", ...o });
  const world = (o: Partial<AgentInfo> = {}, more: Partial<WorldState> = {}) =>
    makeWorld({ reg: { socket: "s", agents: { "agent-x": info(o), "agent-y": info({ channelId: "c2", parent: "agent-x" } as Partial<AgentInfo>) } }, channels: new Set(["c1", "c2"]), ...more });
  const guard = (w: ReturnType<typeof makeWorld>, verify: (i: AgentInfo) => void = () => {}) =>
    ({ sessionId: "s1", verify, save: (reg: WorldState["reg"]) => w.deps.saveRegistry(reg) });

  test("archive-only：只删这一条 registry 记录；不关窗口、不归档、不删频道、不清子 agent parent", async () => {
    const w = world();
    expect(await runRemove("agent-x", w.deps, { archiveOnly: guard(w) })).toMatchObject({ ok: true, archiveOnly: true });
    expect(w.st.reg.agents["agent-x"]).toBeUndefined();
    expect(w.st.reg.agents["agent-y"]).toMatchObject({ parent: "agent-x" });
    expect([...w.st.channels].sort()).toEqual(["c1", "c2"]);
    expect(w.st.archived).toEqual([]);
    expect(w.st.cleanups).toEqual([]);
  });

  test.each([
    ["窗口还在", {}, { windows: ["agent-x"] }, "窗口还在"],
    ["条目 active", { status: "active" }, {}, "不是已停的会话"],
    ["会话已换", { sessionId: "s2" }, {}, "不是已停的会话"],
    ["pending 残留", { pending: { op: "kill", pid: 0, startedAt: "2026-09-28T11:00:00Z", left: ["channel"] } }, {}, "未完成"],
    ["restart 中", {}, { restarting: ["agent-x"] }, "restart"],
  ] as const)("archive-only 拒绝：%s，世界不变，不退化成普通 remove", async (_n, o, more, why) => {
    const w = world(o as Partial<AgentInfo>, more as Partial<WorldState>);
    const snap = normalize(w.st);
    expect(await runRemove("agent-x", w.deps, { archiveOnly: guard(w) })).toMatchObject({ ok: false, error: expect.stringContaining(why) });
    expect(normalize(w.st)).toEqual(snap);
    expect(w.st.archived).toEqual([]);
  });

  test("archive-only：大小写变体歧义拒绝，verify 抛错拒绝；普通 remove 不受影响见 resumable-ops", async () => {
    const variant = makeWorld({ reg: { socket: "s", agents: { "agent-x": info(), "Agent-X": info({ channelId: "c9" }) } } });
    const snap = normalize(variant.st);
    expect(await runRemove("agent-x", variant.deps, { archiveOnly: guard(variant) })).toMatchObject({ ok: false, error: expect.stringContaining("大小写") });
    expect(normalize(variant.st)).toEqual(snap);
    const w = world();
    const refused = await runRemove("agent-x", w.deps, { archiveOnly: guard(w, () => { throw new Error("B 终态已变"); }) });
    expect(refused).toMatchObject({ ok: false, error: expect.stringContaining("B 终态已变") });
    expect(w.st.reg.agents["agent-x"]).toBeDefined();
  });
});
