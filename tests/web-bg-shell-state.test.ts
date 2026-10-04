import { describe, expect, test } from "bun:test";
import {
  applySnapshotMissing, bgConfirmedSuccess, bgSweepable, markBgDone, reviveUnknownShell, shellExited, shellExitOnDone, shellQuietMs, shellTone, shellUnknown,
} from "../web/features/chat/bg-shell-state";
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

  test("completed：bridge 判 done 且末行是独立退出行 → 退出码；其余（idle 老 bridge / 文件消失 / 提到相似字样）→ null", () => {
    expect(shellExitOnDone(["x", "[exited with code 0]"], "done")).toBe(0);
    expect(shellExitOnDone(["[exited with code 2]\r"], "done")).toBe(2);
    expect(shellExitOnDone(["[exited with code 0]"], "idle")).toBeNull();
    expect(shellExitOnDone(["[exited with code 0]"], undefined)).toBeNull();
    expect(shellExitOnDone(["[exited with code 0]", "more"], "done")).toBeNull();
    expect(shellExitOnDone(["echo [exited with code 0]"], "done")).toBeNull();
    expect(shellExitOnDone([], "done")).toBeNull();
  });

  test("markBgDone：shell 只有退出行才进已结束；没退出行留在运行组标不再跟踪（计数 / 停止语义不变）；subagent 原样", () => {
    const ok = shell({ lines: ["[exited with code 0]"] });
    markBgDone(ok, 5, "done");
    expect(ok).toMatchObject({ status: "done", shellEnd: { kind: "exited", code: 0 }, durationMs: 5 });
    const gone = shell({ lines: ["serving"] });
    markBgDone(gone, 5, undefined); // bridge 报 unknown（文件消失）→ bgEndStatusOf 映射成 undefined
    expect(gone.status).toBe("running");
    expect(gone.shellEnd).toBeUndefined();
    expect(shellUnknown(gone)).toBe("untracked");
    expect(bgTaskBadge([gone])).toMatchObject({ running: 1, done: 0, muted: false });
    const a = sub();
    markBgDone(a, 5, "idle");
    expect(a).toMatchObject({ status: "done", endStatus: "idle" });
  });

  test("非 0 不是成功，未知不是成功；subagent 成功口径不变", () => {
    expect(shellTone({ kind: "exited", code: 0 })).toBe("success");
    expect(shellTone({ kind: "exited", code: 1 })).toBe("failed");
    expect(shellTone(undefined)).toBe("unknown");
    expect(bgConfirmedSuccess(shell({ status: "done", shellEnd: { kind: "exited", code: 0 } }))).toBe(true);
    expect(bgConfirmedSuccess(shell({ status: "done", shellEnd: { kind: "exited", code: 137 } }))).toBe(false);
    expect(bgConfirmedSuccess(shell({ status: "done" }))).toBe(false);
    expect(bgConfirmedSuccess(shell({ shellUntracked: true }))).toBe(false);
    expect(bgConfirmedSuccess(shell())).toBe(false);
    expect(bgConfirmedSuccess(sub({ status: "done", endStatus: "done" }))).toBe(true);
    expect(bgConfirmedSuccess(sub({ status: "done", endStatus: "idle" }))).toBe(false);
  });

  test("快照缺失：shell → 仍在运行组、状态未知（徽标不弱化）；subagent → 原样完成；再有输出 → 恢复跟踪（已确认的退出不动）", () => {
    const s = shell();
    applySnapshotMissing(s);
    expect(s.status).toBe("running");
    expect(shellUnknown(s)).toBe("untracked");
    expect(bgTaskBadge([s])).toMatchObject({ running: 1, count: 1, muted: false });
    reviveUnknownShell(s);
    expect(s.status).toBe("running");
    expect(shellUnknown(s)).toBeNull();
    const a = sub();
    applySnapshotMissing(a);
    expect(a.status).toBe("done");
    expect(a.shellUntracked).toBeUndefined();
    const exited = shell({ status: "done", shellEnd: { kind: "exited", code: 0 } });
    expect(shellExited(exited)).toBe(true);
    reviveUnknownShell(exited);
    expect(exited.status).toBe("done");
    expect(shellUnknown(exited)).toBeNull();
  });

  test("读不到输出（bridge 进度带 unreadable）→ 状态未知；进度恢复后回到正常跟踪", () => {
    const s = shell({ progress: { startedTs: NOW, lastTs: NOW, unreadable: true } });
    expect(shellUnknown(s)).toBe("unreadable");
    s.progress = { startedTs: NOW, lastTs: NOW };
    expect(shellUnknown(s)).toBeNull();
    expect(shellUnknown(sub({ progress: { unreadable: true } }))).toBeNull();
  });

  test("已多久无输出：优先 bridge 的 lastTs（刷新后仍准），没有退回本地事件时刻", () => {
    expect(shellQuietMs(shell({ progress: { startedTs: NOW - 20 * MIN, lastTs: NOW - 12 * MIN }, lastEventAt: NOW }), NOW)).toBe(12 * MIN);
    expect(shellQuietMs(shell({ lastEventAt: NOW - 4 * MIN }), NOW)).toBe(4 * MIN);
    expect(shellQuietMs(shell({ lastEventAt: undefined }), NOW)).toBe(0);
  });
});
