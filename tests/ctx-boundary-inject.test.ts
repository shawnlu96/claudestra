import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, readFileSync, rmSync } from "fs";
import {
  agentWindowName, compactInjectedRecently, injectCompact, loadInjectState, resetInjectState, sweepPendingEcho,
} from "../src/bridge/ctx-boundary-inject.js";
import { resetCtxBoundaryState } from "../src/bridge/ctx-boundary.js";
import { DEFAULT_KEEP_LIST } from "../src/lib/ctx-boundary-policy.js";
import { statePath } from "../src/lib/paths.js";
import { windowTarget } from "../src/lib/tmux-helper.js";
import type { PaneQuotaState } from "../src/lib/lp-state.js";
import { BUSY_PANE, harness, MIN, tgt } from "./ctx-boundary-harness.js";

const EXEC_LINE = `/compact ${DEFAULT_KEEP_LIST}`;
const GUARD_FILE = statePath("ctx-boundary-injected.json");
const PENDING_FILE = statePath("ctx-boundary-pending-echo.json");

beforeEach(() => resetCtxBoundaryState());
afterAll(() => {
  rmSync(GUARD_FILE, { force: true });
  rmSync(PENDING_FILE, { force: true });
});

describe("injectCompact：先看画面", () => {
  test("画面状态不允许 → skipped 带原因文字，不敲键", async () => {
    for (const [s, reason] of [
      [{ compacting: true }, "compacting"],
      [{ wall: true, lp: "unknown" }, "quota-wall"],
      [{ menu: true }, "menu"],
      [{ draft: true }, "draft"],
      [{ exhausted: true, wall: true, lp: "on" }, "quota-wall"],
    ] as const) {
      const h = harness([], { state: s as Partial<PaneQuotaState> });
      const r = await injectCompact(tgt("x"), { action: "compact" }, h.deps);
      expect(r).toMatchObject({ status: "skipped", reason });
      expect((r as { text: string }).text.length).toBeGreaterThan(0);
      expect(h.win("master:x").box).toBe("");
    }
    const h = harness([], { panes: { "master:x": null } });
    expect(await injectCompact(tgt("x"), { action: "compact" }, h.deps)).toMatchObject({ status: "skipped", reason: "pane-unknown" });
  });

  test("CC 已退出只剩 shell（adv1 P2-4）、有人在 copy-mode（P2-3）、压缩途中 API 在重试（P2-1）→ 一个键都不发", async () => {
    const h = harness([], { panes: { "master:retry": "✻ No response from the API · retrying in 12s\n❯ \n" } });
    h.win("master:shell").command = "zsh";
    h.win("master:mode").inMode = true;
    expect(await injectCompact(tgt("shell"), { action: "compact" }, h.deps)).toMatchObject({ status: "skipped", reason: "not-cc" });
    expect(await injectCompact(tgt("mode"), { action: "compact" }, h.deps)).toMatchObject({ status: "skipped", reason: "copy-mode" });
    expect(await injectCompact(tgt("retry"), { action: "compact" }, h.deps)).toMatchObject({ status: "skipped", reason: "api-retry" });
    for (const t of ["shell", "mode", "retry"]) expect(h.win(`master:${t}`).box).toBe("");
    // 老装法 node、原生安装器的版本号文件名也认得是 CC
    for (const command of ["claude", "node", "2.1.283"]) {
      resetInjectState();
      h.win("master:ok").command = command;
      expect((await injectCompact(tgt("ok"), { action: "compact" }, h.deps)).status).toBe("executed");
    }
  });

  test("排队（lp-state 同时报 draft）→ 跳过，原因写「已排队」，和草稿分开", async () => {
    const h = harness([], { state: { draft: true }, panes: { "master:q": "❯ /compact x\n  Press up to edit queued messages\n" } });
    expect(await injectCompact(tgt("q"), { action: "compact" }, h.deps)).toMatchObject({ status: "skipped", reason: "queued" });
    expect(await injectCompact(tgt("d"), { action: "compact" }, h.deps)).toMatchObject({ status: "skipped", reason: "draft" });
    expect(h.sent.length).toBe(0);
  });
});

describe("injectCompact：敲字 → 再看一眼 → 回车（adv1 P2-9）", () => {
  test("闲着 = executed，忙 = queued；执行者的 save-compact 改成 compact", async () => {
    const h = harness([], { panes: { "master:busy": BUSY_PANE } });
    expect(await injectCompact(tgt("idle"), { action: "compact", keep: "只留卡号" }, h.deps)).toEqual({ status: "executed", line: "/compact 只留卡号" });
    expect(await injectCompact(tgt("busy"), { action: "save-compact" }, h.deps)).toEqual({ status: "queued", line: "/save-compact" });
    expect(await injectCompact(tgt("agent-foo", true), { action: "save-compact" }, h.deps)).toMatchObject({ line: EXEC_LINE });
    expect(h.sent.map((s) => s.line)).toEqual(["/compact 只留卡号", "/save-compact", EXEC_LINE]);
  });

  test("CC 按词折行、吃掉折行处的空格：去掉空白后一致就算对上", async () => {
    const h = harness([]);
    h.win("master:w").onType = (w) => void (w.box = w.box.replace("worktree、当前 head", "worktree、当前\nhead"));
    expect((await injectCompact(tgt("w", true), { action: "compact" }, h.deps)).status).toBe("executed");
  });

  test("敲完弹出权限框 / 进了 copy-mode / CC 退出 → 不回车、不按任何键，字留着等之后删", async () => {
    for (const change of [
      (w: { pane: string | null }) => void (w.pane = "Do you want to proceed?\n[menu]"),
      (w: { inMode: boolean }) => void (w.inMode = true),
      (w: { command: string }) => void (w.command = "zsh"),
    ]) {
      resetInjectState();
      const h = harness([]);
      const w = h.win("master:x");
      w.onType = change as (w: object) => void;
      const r = await injectCompact(tgt("x", true), { action: "compact" }, h.deps);
      expect(r).toMatchObject({ status: "failed", leftover: true });
      expect([h.sent.length, w.box]).toEqual([0, EXEC_LINE]);
      expect(compactInjectedRecently("master:x", h.now)).toBe(false);
    }
  });

  test("owner 同时在打字（框里的字和敲的对不上）→ 不回车也不删", async () => {
    const h = harness([]);
    const w = h.win("master:x");
    w.onType = (win) => void (win.box = "帮我看下" + win.box);
    expect(await injectCompact(tgt("x", true), { action: "compact" }, h.deps)).toMatchObject({ status: "failed", leftover: true });
    expect([h.sent.length, w.box]).toEqual([0, "帮我看下" + EXEC_LINE]);
  });

  test("敲完发现已经在压缩：当场删掉自己敲的字，不叠第二条", async () => {
    const h = harness([]);
    const w = h.win("master:x");
    w.onType = (win) => void (win.pane = "✻ Compacting conversation…\n");
    expect(await injectCompact(tgt("x", true), { action: "compact" }, h.deps)).toMatchObject({ status: "skipped", reason: "compacting" });
    expect([h.sent.length, w.box]).toEqual([0, ""]);
  });

  test("回车那一下抛错 → failed，字留着等之后删", async () => {
    const h = harness([]);
    h.deps.enter = async () => {
      throw new Error("can't find pane");
    };
    expect(await injectCompact(tgt("x"), { action: "compact" }, h.deps)).toEqual({ status: "failed", error: "can't find pane", leftover: true });
  });
});

describe("注入守卫（adv1 P2-10 / P2-2）", () => {
  test("15 分钟内谁也不能再注入（手动按钮也一样），过了再来", async () => {
    const h = harness([]);
    expect((await injectCompact(tgt("x"), { action: "save-compact" }, h.deps)).status).toBe("executed");
    expect(await injectCompact(tgt("x"), { action: "save-compact" }, h.deps)).toMatchObject({ status: "skipped", reason: "recent" });
    h.advance(4 * MIN + 1);
    // 手动按钮拿这段文字回给 owner：写明还要等几分钟
    expect(await injectCompact(tgt("x"), { action: "save-compact" }, h.deps)).toMatchObject({ text: "15 分钟内刚注入过压缩，还要等 11 分钟" });
    expect(compactInjectedRecently("master:x", h.now + 10 * MIN)).toBe(true);
    h.advance(12 * MIN);
    expect((await injectCompact(tgt("x"), { action: "save-compact" }, h.deps)).status).toBe("executed");
    expect(h.sent.length).toBe(2);
  });

  test("落盘：bridge 重启后守卫还在；dry-run 只读，不改文件", async () => {
    rmSync(GUARD_FILE, { force: true });
    loadInjectState("live");
    const h = harness([]);
    await injectCompact(tgt("x"), { action: "save-compact" }, h.deps);
    expect(existsSync(GUARD_FILE)).toBe(true);
    const saved = readFileSync(GUARD_FILE, "utf8");
    resetInjectState(); // 进程重启：内存清零
    loadInjectState("live");
    expect(compactInjectedRecently("master:x", h.now + MIN)).toBe(true);
    resetInjectState();
    loadInjectState("read-only");
    expect(compactInjectedRecently("master:x", h.now + MIN)).toBe(true);
    expect(readFileSync(GUARD_FILE, "utf8")).toBe(saved);
  });
});

test("大总管：registry 名 agent-master 对应窗口 master（adv1 P2-13：以前拼成 master:=agent-master，永远读不到画面）", () => {
  expect(agentWindowName("agent-master")).toBe("master");
  expect(windowTarget(agentWindowName("agent-master"))).toBe("master:=master");
  expect(windowTarget(agentWindowName("agent-task-t36"))).toBe("master:=agent-task-t36");
});

describe("删自己留下的字：退格分批、每批核对（r3 P2-2）、待删的字落盘（r3 P2-3）", () => {
  const LONG = "保".repeat(800);
  const LINE = `/compact ${LONG}`;
  const compactingOnType = (h: ReturnType<typeof harness>) => (h.win("master:x").onType = (win) => void (win.pane = "✻ Compacting conversation…\n"));
  const countErase = (h: ReturnType<typeof harness>, after?: (i: number) => void) => {
    const calls: number[] = [];
    const erase = h.deps.erase;
    h.deps.erase = async (t, n) => {
      calls.push(n);
      await erase(t, n);
      after?.(calls.length);
    };
    return calls;
  };

  test("800 字的清单：退格每批 ≤200 个，删干净", async () => {
    const h = harness([]);
    compactingOnType(h);
    const calls = countErase(h);
    expect(await injectCompact(tgt("x"), { action: "compact", keep: LONG }, h.deps)).toMatchObject({ status: "skipped", reason: "compacting" });
    expect(calls).toEqual([200, 200, 200, 200, 9]);
    expect([h.win("master:x").box, h.sent.length]).toEqual(["", 0]);
  });

  test("删到一半弹出对话框：停手，剩下的记着；对话框关掉后下一轮接着删完", async () => {
    const h = harness([]);
    const w = h.win("master:x");
    compactingOnType(h);
    const calls = countErase(h, (i) => void (i === 1 && (w.pane = "Do you want to proceed?\n[menu]")));
    expect(await injectCompact(tgt("x"), { action: "compact", keep: LONG }, h.deps)).toMatchObject({ status: "failed", leftover: true });
    expect([calls, [...w.box].length]).toEqual([[200], 609]);
    const logs: string[] = [];
    await sweepPendingEcho(h.deps, (l) => void logs.push(l)); // 对话框还在：不按键
    expect(calls.length).toBe(1);
    w.pane = "some output\n❯ \n";
    await sweepPendingEcho(h.deps, (l) => void logs.push(l));
    expect([calls, w.box]).toEqual([[200, 200, 200, 200, 9], ""]);
    expect(logs).toEqual([expect.stringContaining("已删掉")]);
  });

  test("删到一半 owner 动了输入框：对不上就停，不再多按一个退格", async () => {
    const h = harness([]);
    const w = h.win("master:x");
    compactingOnType(h);
    const calls = countErase(h, (i) => void (i === 1 && (w.box = "帮" + w.box)));
    expect(await injectCompact(tgt("x"), { action: "compact", keep: LONG }, h.deps)).toMatchObject({ status: "failed", leftover: true });
    expect(calls).toEqual([200]);
    await sweepPendingEcho(h.deps, () => {});
    expect(calls).toEqual([200]);
    expect(w.box.startsWith("帮/compact")).toBe(true);
  });

  test("待删的字落盘：bridge 重启后还记得，照样删；挡了一整天就不管了", async () => {
    for (const f of [GUARD_FILE, PENDING_FILE]) rmSync(f, { force: true });
    loadInjectState("live");
    const h = harness([]);
    const w = h.win("master:x");
    w.onType = (win) => void (win.pane = "Do you want to proceed?\n[menu]");
    await injectCompact(tgt("x"), { action: "save-compact" }, h.deps);
    expect(JSON.parse(readFileSync(PENDING_FILE, "utf8"))).toEqual({ "master:x": { text: "/save-compact", at: h.now } });
    resetInjectState(); // 进程重启
    loadInjectState("live");
    w.pane = "some output\n❯ \n";
    await sweepPendingEcho(h.deps, () => {});
    expect(w.box).toBe("");
    expect(JSON.parse(readFileSync(PENDING_FILE, "utf8"))).toEqual({});

    w.onType = (win) => void (win.pane = "Do you want to proceed?\n[menu]");
    h.advance(20 * MIN);
    await injectCompact(tgt("x"), { action: "save-compact" }, h.deps);
    h.advance(25 * 60 * MIN);
    const logs: string[] = [];
    await sweepPendingEcho(h.deps, (l) => void logs.push(l));
    expect(logs).toEqual([expect.stringContaining("一天都没删成")]);
    expect(w.box).toBe("/save-compact");
    resetInjectState();
  });
});
