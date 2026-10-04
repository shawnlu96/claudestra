import { describe, expect, test } from "bun:test";
import { applySnapshotMissing, bgConfirmedSuccess, bgSweepable, reviveUnknownShell, shellEndOnDone, shellQuietMs, shellTone } from "../web/features/chat/bg-shell-state";
import { bgTaskBadge } from "../web/features/chat/bg-task-badge";
import type { BgTaskView } from "../web/features/chat/type";

const MIN = 60_000;
const NOW = 1_800_000_000_000;
const shell = (o: Partial<BgTaskView> = {}): BgTaskView => ({ id: "s", kind: "shell", title: "🐚 bg shell s", lines: [], status: "running", lastEventAt: NOW, ...o });
const sub = (o: Partial<BgTaskView> = {}): BgTaskView => ({ ...shell(o), kind: "subagent", id: "agent-x" });

describe("bg-shell-state：shell 只有退出行算结束", () => {
  test("任何静默时长都不被前端兜底收敛；subagent 仍按 31 分钟", () => {
    for (const m of [3, 4, 12, 60, 24 * 60]) expect(bgSweepable(shell({ lastEventAt: NOW - m * MIN }), NOW)).toBe(false);
    expect(bgSweepable(sub({ lastEventAt: NOW - 30 * MIN }), NOW)).toBe(false);
    expect(bgSweepable(sub({ lastEventAt: NOW - 32 * MIN }), NOW)).toBe(true);
  });

  test("completed：bridge 判 done 且末行是独立退出行 → 退出码；其余（idle 老 bridge / 文件消失 / 提到相似字样）→ 未知", () => {
    expect(shellEndOnDone(["x", "[exited with code 0]"], "done")).toEqual({ kind: "exited", code: 0 });
    expect(shellEndOnDone(["[exited with code 2]\r"], "done")).toEqual({ kind: "exited", code: 2 });
    expect(shellEndOnDone(["[exited with code 0]"], "idle")).toEqual({ kind: "unknown" });
    expect(shellEndOnDone(["[exited with code 0]"], undefined)).toEqual({ kind: "unknown" });
    expect(shellEndOnDone(["[exited with code 0]", "more"], "done")).toEqual({ kind: "unknown" });
    expect(shellEndOnDone(["echo [exited with code 0]"], "done")).toEqual({ kind: "unknown" });
    expect(shellEndOnDone([], "done")).toEqual({ kind: "unknown" });
  });

  test("非 0 不是成功，未知不是成功；subagent 成功口径不变", () => {
    expect(shellTone({ kind: "exited", code: 0 })).toBe("success");
    expect(shellTone({ kind: "exited", code: 1 })).toBe("failed");
    expect(shellTone({ kind: "unknown" })).toBe("unknown");
    expect(shellTone(undefined)).toBe("unknown");
    expect(bgConfirmedSuccess(shell({ status: "done", shellEnd: { kind: "exited", code: 0 } }))).toBe(true);
    expect(bgConfirmedSuccess(shell({ status: "done", shellEnd: { kind: "exited", code: 137 } }))).toBe(false);
    expect(bgConfirmedSuccess(shell({ status: "done" }))).toBe(false);
    expect(bgConfirmedSuccess(shell())).toBe(false);
    expect(bgConfirmedSuccess(sub({ status: "done", endStatus: "done" }))).toBe(true);
    expect(bgConfirmedSuccess(sub({ status: "done", endStatus: "idle" }))).toBe(false);
  });

  test("快照缺失：shell → 状态未知；subagent → 原样完成；再有输出 → 回到运行（已确认的退出不动）", () => {
    const s = shell();
    applySnapshotMissing(s);
    expect(s).toMatchObject({ status: "done", shellEnd: { kind: "unknown" } });
    expect(bgTaskBadge([s]).running).toBe(0);
    reviveUnknownShell(s);
    expect(s.status).toBe("running");
    expect(s.shellEnd).toBeUndefined();
    const a = sub();
    applySnapshotMissing(a);
    expect(a.status).toBe("done");
    expect(a.shellEnd).toBeUndefined();
    const exited = shell({ status: "done", shellEnd: { kind: "exited", code: 0 } });
    reviveUnknownShell(exited);
    expect(exited.status).toBe("done");
  });

  test("已多久无输出：优先 bridge 的 lastTs（刷新后仍准），没有退回本地事件时刻", () => {
    expect(shellQuietMs(shell({ progress: { startedTs: NOW - 20 * MIN, lastTs: NOW - 12 * MIN }, lastEventAt: NOW }), NOW)).toBe(12 * MIN);
    expect(shellQuietMs(shell({ lastEventAt: NOW - 4 * MIN }), NOW)).toBe(4 * MIN);
    expect(shellQuietMs(shell({ lastEventAt: undefined }), NOW)).toBe(0);
  });
});
