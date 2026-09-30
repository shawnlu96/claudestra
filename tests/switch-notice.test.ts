/**
 * 切换确认框的巡检（lib/switch-notice.ts，permission-watcher 用；T41c）：watcher 看到的框一律只通知、从不代按。
 * 会按键的只有 runSwitchCommand 的同步注入确认（tests/switch-confirm.test.ts）。
 * 下面几条是审查员 r1 / r2 探针（rv-t41c-work/probe*.ts）改写的回归：旧的「异步意图」在这些时序下会误按或漏按。
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { clearSwitchNotice, markSwitchNotified, switchBoxAction, switchNoticePlan } from "../src/lib/switch-notice.ts";
import { paneLooksIdle } from "../src/lib/tmux-helper.ts";

const fx = (f: string): string => readFileSync(join(import.meta.dir, "fixtures", "switch-confirm", f), "utf8");
const SWITCH_MODEL = fx("cc2.1.280-switch-model.txt");
const CHANGE_EFFORT = fx("cc2.1.280-change-effort.txt");
const IDLE = fx("cc2.1.280-model-set.txt");
const src = (f: string): string => readFileSync(join(import.meta.dir, "..", "src", f), "utf8");

describe("switchBoxAction：有框只通知，没有代按这一档", () => {
  test("没框 → none；切模型 / effort 框 → notify 带框指纹", () => {
    expect(switchBoxAction(IDLE).act).toBe("none");
    for (const pane of [SWITCH_MODEL, CHANGE_EFFORT]) {
      const a = switchBoxAction(pane);
      expect(a.act).toBe("notify");
      expect(a.act === "notify" && a.box).toMatch(/^[0-9a-f]{12}$/);
    }
    expect(switchBoxAction(SWITCH_MODEL.replaceAll("Sonnet 5", "Sonnet 4.6")).act).toBe("notify");
  });

  test("r1 P1-1：/model 无框落地后 CC 自己弹同目标框 → 只通知", () => {
    expect(switchBoxAction(IDLE).act).toBe("none");
    expect(switchBoxAction(SWITCH_MODEL).act).toBe("notify");
  });

  test("r2 P1-1：/model 还躺在输入框里（看着空闲）→ watcher 什么都不做；迟到的框交给同步那次调用，watcher 只报", () => {
    const queued = IDLE.replace("❯ \n", "❯ /model claude-sonnet-5\n");
    expect(paneLooksIdle(queued)).toBe(true);
    expect(switchBoxAction(queued).act).toBe("none");
    expect(switchBoxAction(SWITCH_MODEL).act).toBe("notify");
  });

  test("r2 P1-2 / 大总管：同目标外来框连着几帧 → 每帧都只是 notify（去重交给 switchNoticePlan）", () => {
    for (let i = 0; i < 3; i++) expect(switchBoxAction(SWITCH_MODEL).act).toBe("notify");
  });

  test("代按 / 意图登记的入口都拆掉了：watcher 不发切换确认键，斜杠 / Discord 不登记意图", () => {
    expect(src("bridge/permission-watcher.ts")).not.toContain("pressSwitchConfirm");
    for (const f of ["bridge/permission-watcher.ts", "bridge/api-slash.ts", "bridge/discord-interactions.ts", "bridge/api-routes.ts"]) {
      expect(src(f)).not.toMatch(/SwitchIntent|switch-intent/);
    }
  });
});

describe("通知去重：同一张框只报一次，Discord 失败下一轮重试（r1 P2）", () => {
  test("网页事件只发一次；Discord 没标成功就每轮再试，成功后不再发；框关了再弹照报", () => {
    const ch = "t41c-ch";
    expect(switchNoticePlan(ch, "aaaaaaaaaaaa")).toEqual({ web: true, discord: true });
    expect(switchNoticePlan(ch, "aaaaaaaaaaaa")).toEqual({ web: false, discord: true }); // 上一轮 Discord 失败
    markSwitchNotified(ch, "aaaaaaaaaaaa");
    expect(switchNoticePlan(ch, "aaaaaaaaaaaa")).toEqual({ web: false, discord: false });
    expect(switchNoticePlan(ch, "bbbbbbbbbbbb")).toEqual({ web: true, discord: true }); // 换了一张框
    markSwitchNotified(ch, "bbbbbbbbbbbb");
    clearSwitchNotice(ch);
    expect(switchNoticePlan(ch, "bbbbbbbbbbbb")).toEqual({ web: true, discord: true });
  });
});
