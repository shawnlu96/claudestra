import { describe, expect, test } from "bun:test";
import { isPendingLive, PENDING_STALE_MS, scanResidues, type PendingOp, type ScanInput } from "../src/lib/pending-ops";
import { residueChecks } from "../src/lib/doctor-pending";
import { tmuxErrorMeansNoWindows } from "../src/lib/agent-windows";

const NOW = Date.parse("2026-09-28T12:00:00Z");
const at = (msAgo: number) => new Date(NOW - msAgo).toISOString();
const input = (agents: ScanInput["agents"], extra: Partial<ScanInput> = {}): ScanInput =>
  ({ agents, windows: [], channels: new Set(), now: NOW, alive: (pid) => pid === 42, ...extra });

describe("isPendingLive", () => {
  test("持有者活着且未超时 = 在途", () => {
    expect(isPendingLive({ pid: 42, startedAt: at(1000) }, NOW, (p) => p === 42)).toBe(true);
  });
  test("持有者死了 / 超时（防 pid 复用）/ pid 0（欠账）/ 时间坏了 = 残留", () => {
    const alive = () => true;
    expect(isPendingLive({ pid: 7, startedAt: at(1000) }, NOW, () => false)).toBe(false);
    expect(isPendingLive({ pid: 42, startedAt: at(PENDING_STALE_MS + 1) }, NOW, alive)).toBe(false);
    expect(isPendingLive({ pid: 0, startedAt: at(1000) }, NOW, alive)).toBe(false);
    expect(isPendingLive({ pid: 42, startedAt: "garbage" }, NOW, alive)).toBe(false);
  });
});

describe("scanResidues", () => {
  const create = (pid: number, channelId?: string): PendingOp => ({ op: "create", pid, startedAt: at(1000), channelName: "x", ...(channelId ? { channelId } : {}) });

  test("四类残留各报一次", () => {
    const r = scanResidues(input({
      "agent-c": { status: "creating", pending: create(7, "c1") },
      "agent-k": { status: "stopped", pending: { op: "kill", pid: 0, startedAt: at(1000), left: ["channel"] } },
      "agent-r": { status: "active", pending: { op: "rename", pid: 7, startedAt: at(1000), from: "agent-old" } },
      "agent-s": { status: "stopped", channelId: "s1" },
      "agent-w": { status: "stopped", channelId: "local-1" },
    }, { windows: ["agent-w", "agent-hand", "agent-old"], channels: new Set(["s1", "c1"]) }));
    expect(r.map((x) => `${x.kind}:${x.agent}`).sort()).toEqual([
      "orphan-channel:agent-s", "orphan-window:agent-hand", "orphan-window:agent-w",
      "stale-create:agent-c", "stale-kill:agent-k", "stale-rename:agent-r",
    ]);
    expect(r.find((x) => x.agent === "agent-hand")).toMatchObject({ registered: false });
  });

  test("在途操作只报 busy，它的频道不算孤儿", () => {
    const r = scanResidues(input({
      "agent-c": { status: "creating", pending: create(42, "c1") },
      "agent-s": { status: "stopped", channelId: "c1" },
    }, { windows: ["agent-c"], channels: new Set(["c1"]) }));
    expect(r).toEqual([{ kind: "busy", agent: "agent-c", op: "create", pid: 42 }]);
  });

  test("active 条目引用的频道不算孤儿；查不到频道（bridge 不在）就不报频道", () => {
    const agents = { "agent-s": { status: "stopped", channelId: "c1" }, "agent-a": { status: "active", channelId: "c1" } };
    expect(scanResidues(input(agents, { windows: ["agent-a"], channels: new Set(["c1"]) }))).toEqual([]);
    expect(scanResidues(input({ "agent-s": { status: "stopped", channelId: "c1" } }, { channels: null }))).toEqual([]);
  });

  test("residueChecks：干净时一行 ok；bridge 不在时说明没查频道", () => {
    expect(residueChecks([], true)).toEqual([expect.objectContaining({ status: "ok", name: "半截操作" })]);
    const c = residueChecks([], false);
    expect(c.some((x) => x.status === "warn" && x.detail.includes("bridge 连不上"))).toBe(true);
  });

  test("residueChecks：可修的指向 repair，未登记窗口给 tmux 命令", () => {
    const c = residueChecks([
      { kind: "stale-kill", agent: "agent-k" },
      { kind: "orphan-window", agent: "agent-hand", registered: false },
    ], true);
    expect(c.find((x) => x.name === "做到一半的操作")!.fix).toContain("repair --apply");
    expect(c.find((x) => x.name === "未登记窗口")!.fix).toContain("kill-window");
  });
});

describe("tmuxErrorMeansNoWindows", () => {
  test("没起 / 没 session / socket 不在或没人听 = 没有窗口", () => {
    expect(tmuxErrorMeansNoWindows("no server running on /tmp/x/master.sock")).toBe(true);
    expect(tmuxErrorMeansNoWindows("can't find session: master")).toBe(true);
    expect(tmuxErrorMeansNoWindows("error connecting to /tmp/x/master.sock (No such file or directory)")).toBe(true);
    expect(tmuxErrorMeansNoWindows("error connecting to /tmp/x/master.sock (Connection refused)")).toBe(true);
  });
  test("权限 / 路径过长等 = 不知道（窗口可能都在）", () => {
    expect(tmuxErrorMeansNoWindows("error connecting to rt/master.sock (Permission denied)")).toBe(false);
    expect(tmuxErrorMeansNoWindows("error connecting to /very/long (File name too long)")).toBe(false);
    expect(tmuxErrorMeansNoWindows("server exited unexpectedly")).toBe(false);
  });
});
