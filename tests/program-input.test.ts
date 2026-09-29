/**
 * lib/program-input.ts：程序往 agent 窗口敲过的键（cron / manager tmux-send-keys 的字、清场的 C-c），bridge 据此认出会话记录里不是 owner。
 * Workflow 复核 wf2 的 stop-semantics-3 / esc-keys-2。
 */
import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inputHash, isProgramKey, isProgramText, readProgramInputs, recordProgramInput } from "../src/lib/program-input.js";

const T0 = 1_790_000_000_000;

describe("程序敲键记录", () => {
  test("落盘、跨进程读得回；只留最近 8 条、一小时内的", () => {
    const path = join(mkdtempSync(join(tmpdir(), "prog-input-")), "esc-@3.input");
    expect(readProgramInputs(path)).toEqual([]);
    recordProgramInput(path, "old", T0 - 2 * 3_600_000);
    for (let i = 0; i < 10; i++) recordProgramInput(path, `x${i}`, T0 + i);
    const list = readProgramInputs(path);
    expect(list).toHaveLength(8);
    expect(list.at(-1)).toEqual({ at: T0 + 9, h: inputHash("x9") });
    expect(list.some((e) => e.h === inputHash("old"))).toBe(false);
  });

  test("指纹不看空白差异；纯按键是空串", () => {
    expect(inputHash("检查  状态\n")).toBe(inputHash("检查 状态"));
    expect(inputHash("")).toBe("");
  });

  test("打断标记：程序 5 秒内发过键（C-c / Esc）才算程序的", () => {
    const list = [{ at: T0, h: "" }];
    expect(isProgramKey(list, T0 + 80)).toBe(true);
    expect(isProgramKey(list, T0 - 400)).toBe(true); // 记在发键之前，时钟有点抖
    expect(isProgramKey(list, T0 + 6_000)).toBe(false);
    expect(isProgramKey([], T0)).toBe(false);
  });

  test("终端输入：同样的字 30 分钟内程序敲过（CC 忙时排到回合结束才写进记录），或刚敲过任何键", () => {
    const cron = [{ at: T0, h: inputHash("检查爬宠监控服务的运行状态") }];
    expect(isProgramText(cron, T0 + 20 * 60_000, inputHash("检查爬宠监控服务的运行状态"))).toBe(true);
    expect(isProgramText(cron, T0 + 40 * 60_000, inputHash("检查爬宠监控服务的运行状态"))).toBe(false);
    expect(isProgramText(cron, T0 + 20 * 60_000, inputHash("把 X 也改了"))).toBe(false);
    expect(isProgramText([{ at: T0, h: "" }], T0 + 1_000, inputHash("tmux-send-keys 分两段敲的字"))).toBe(true); // 字和 Enter 分开发
    expect(isProgramText(cron, T0 - 60_000, inputHash("检查爬宠监控服务的运行状态"))).toBe(false); // 敲之前就有的不算
  });
});
