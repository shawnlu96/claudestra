import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, readFileSync, rmSync } from "fs";
import {
  agentWindowName, compactInjectedRecently, injectCompact, loadInjectGuard, resetInjectState,
} from "../src/bridge/ctx-boundary-inject.js";
import { resetCtxBoundaryState } from "../src/bridge/ctx-boundary.js";
import { DEFAULT_KEEP_LIST } from "../src/lib/ctx-boundary-policy.js";
import { statePath } from "../src/lib/paths.js";
import { windowTarget } from "../src/lib/tmux-helper.js";
import type { PaneQuotaState } from "../src/lib/lp-state.js";
import { BUSY_PANE, harness, MIN, tgt } from "./ctx-boundary-harness.js";

const EXEC_LINE = `/compact ${DEFAULT_KEEP_LIST}`;
const GUARD_FILE = statePath("ctx-boundary-injected.json");

beforeEach(() => resetCtxBoundaryState());
afterAll(() => rmSync(GUARD_FILE, { force: true }));

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
    expect(compactInjectedRecently("master:x", h.now + 14 * MIN)).toBe(true);
    h.advance(16 * MIN);
    expect((await injectCompact(tgt("x"), { action: "save-compact" }, h.deps)).status).toBe("executed");
    expect(h.sent.length).toBe(2);
  });

  test("落盘：bridge 重启后守卫还在；dry-run 只读，不改文件", async () => {
    rmSync(GUARD_FILE, { force: true });
    loadInjectGuard("live");
    const h = harness([]);
    await injectCompact(tgt("x"), { action: "save-compact" }, h.deps);
    expect(existsSync(GUARD_FILE)).toBe(true);
    const saved = readFileSync(GUARD_FILE, "utf8");
    resetInjectState(); // 进程重启：内存清零
    loadInjectGuard("live");
    expect(compactInjectedRecently("master:x", h.now + MIN)).toBe(true);
    resetInjectState();
    loadInjectGuard("read-only");
    expect(compactInjectedRecently("master:x", h.now + MIN)).toBe(true);
    expect(readFileSync(GUARD_FILE, "utf8")).toBe(saved);
  });
});

test("大总管：registry 名 agent-master 对应窗口 master（adv1 P2-13：以前拼成 master:=agent-master，永远读不到画面）", () => {
  expect(agentWindowName("agent-master")).toBe("master");
  expect(windowTarget(agentWindowName("agent-master"))).toBe("master:=master");
  expect(windowTarget(agentWindowName("agent-task-t36"))).toBe("master:=agent-task-t36");
});
