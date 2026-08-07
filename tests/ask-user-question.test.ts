/**
 * v2.0.19+ AskUserQuestion 适配 —— 单测 detectAskUserQuestion + buildAuqKeystrokes
 *
 * detectAskUserQuestion 是从 jsonl 抽取 questions 数组的纯函数。
 * buildAuqKeystrokes 是把 selections 翻译成 tmux 按键序列的纯函数。
 */

import { describe, test, expect } from "bun:test";
import {
  detectAskUserQuestion,
  buildAuqKeystrokes,
  type AuqQuestion,
  type AuqState,
} from "../src/bridge/ask-user-question.ts";

function mkAuqContent(questions: any[]): any[] {
  return [
    { type: "text", text: "asking" },
    {
      type: "tool_use",
      id: "tool_1",
      name: "AskUserQuestion",
      input: { questions },
    },
  ];
}

function mkState(questions: AuqQuestion[], selections: number[][]): AuqState {
  return {
    channelId: "ch1",
    questions,
    selections,
    messageId: "m1",
    tmuxTarget: "master:agent-foo",
    ts: Date.now(),
  };
}

describe("detectAskUserQuestion", () => {
  test("识别 AskUserQuestion tool_use", () => {
    const content = mkAuqContent([
      {
        question: "选房？",
        header: "选房",
        options: [
          { label: "A 区", description: "近地铁" },
          { label: "B 区", description: "便宜" },
        ],
        multiSelect: false,
      },
    ]);
    const qs = detectAskUserQuestion(content);
    expect(qs).not.toBeNull();
    expect(qs!.length).toBe(1);
    expect(qs![0].header).toBe("选房");
    expect(qs![0].options.length).toBe(2);
    expect(qs![0].multiSelect).toBe(false);
  });

  test("多 question + multiSelect", () => {
    const content = mkAuqContent([
      {
        question: "管家范围？",
        header: "管家",
        multiSelect: true,
        options: [
          { label: "信息问答" },
          { label: "缴费提醒" },
          { label: "报修反馈" },
        ],
      },
      {
        question: "合同房源？",
        header: "合同",
        multiSelect: true,
        options: [{ label: "续约" }, { label: "退租" }],
      },
    ]);
    const qs = detectAskUserQuestion(content);
    expect(qs).not.toBeNull();
    expect(qs!.length).toBe(2);
    expect(qs![0].multiSelect).toBe(true);
    expect(qs![0].options.length).toBe(3);
    expect(qs![1].options.length).toBe(2);
  });

  test("没 AskUserQuestion → null", () => {
    const content = [
      { type: "text", text: "hello" },
      { type: "tool_use", name: "Read", input: { file_path: "/tmp/a" } },
    ];
    expect(detectAskUserQuestion(content)).toBeNull();
  });

  test("options 不足 2 个的 question 过滤掉", () => {
    const content = mkAuqContent([
      {
        question: "single?",
        options: [{ label: "only" }],
      },
    ]);
    expect(detectAskUserQuestion(content)).toBeNull();
  });

  test("label/description 超长截断", () => {
    const longLabel = "a".repeat(200);
    const content = mkAuqContent([
      {
        question: "test",
        options: [
          { label: longLabel, description: longLabel },
          { label: "b" },
        ],
      },
    ]);
    const qs = detectAskUserQuestion(content)!;
    expect(qs[0].options[0].label.length).toBeLessThanOrEqual(100);
    expect(qs[0].options[0].description!.length).toBeLessThanOrEqual(100);
  });
});

describe("buildAuqKeystrokes（CC 2.1.x 键位模型，v2.17.2 实测重校准）", () => {
  const q3: AuqQuestion = {
    question: "Q1?", header: "Q1", multiSelect: true,
    options: [{ label: "a" }, { label: "b" }, { label: "c" }],
  };
  const q2: AuqQuestion = {
    question: "Q2?", header: "Q2", multiSelect: true,
    options: [{ label: "x" }, { label: "y" }],
  };
  const qSingle: AuqQuestion = {
    question: "S?", header: "S", multiSelect: false,
    options: [{ label: "a" }, { label: "b" }, { label: "c" }],
  };

  // ── 单问题单选：无 tab 栏，Enter 一击即提交 ──
  test("单问题单选 目标 0 → Enter", () => {
    expect(buildAuqKeystrokes(mkState([qSingle], [[0]]))).toEqual(["Enter"]);
  });

  test("单问题单选 目标 1 → Down Enter", () => {
    expect(buildAuqKeystrokes(mkState([qSingle], [[1]]))).toEqual(["Down", "Enter"]);
  });

  test("单问题单选 pane 光标对账：光标在 2、目标 0 → Up Up Enter", () => {
    const pane = {
      form: "single" as const, sections: ["S"], question: "S?", multiSelect: false,
      options: [
        { label: "a", cursor: false, checked: false },
        { label: "b", cursor: false, checked: false },
        { label: "c", cursor: true, checked: false },
      ],
    };
    expect(buildAuqKeystrokes(mkState([qSingle], [[0]]), pane)).toEqual(["Up", "Up", "Enter"]);
  });

  // ── 单问题多选：数字 toggle + Right + Enter ──
  test("单问题多选 [0] → 1 Right Enter", () => {
    expect(buildAuqKeystrokes(mkState([q3], [[0]]))).toEqual(["1", "Right", "Enter"]);
  });

  test("单问题多选 [0,2] → 1 3 Right Enter", () => {
    expect(buildAuqKeystrokes(mkState([q3], [[0, 2]]))).toEqual(["1", "3", "Right", "Enter"]);
  });

  test("单问题多选 乱序 selections 一样跑对", () => {
    expect(buildAuqKeystrokes(mkState([q3], [[2, 0]]))).toEqual(["1", "3", "Right", "Enter"]);
  });

  test("单问题多选 pane 勾选态对账：已勾 {0}、目标 {0,2} → 只补 3", () => {
    const pane = {
      form: "tabbed" as const, sections: ["Q1"], question: "Q1?", multiSelect: true,
      options: [
        { label: "a", cursor: true, checked: true },
        { label: "b", cursor: false, checked: false },
        { label: "c", cursor: false, checked: false },
      ],
    };
    expect(buildAuqKeystrokes(mkState([q3], [[0, 2]]), pane)).toEqual(["3", "Right", "Enter"]);
  });

  test("单问题多选 pane 对账：已勾 {1}、目标 {} → 2 反 toggle 掉", () => {
    const pane = {
      form: "tabbed" as const, sections: ["Q1"], question: "Q1?", multiSelect: true,
      options: [
        { label: "a", cursor: true, checked: false },
        { label: "b", cursor: false, checked: true },
        { label: "c", cursor: false, checked: false },
      ],
    };
    expect(buildAuqKeystrokes(mkState([q3], [[]]), pane)).toEqual(["2", "Right", "Enter"]);
  });

  // ── 多问题（tabbed）：逐段，多选数字 toggle+Right / 单选数字+Enter 自动跳段 ──
  test("两多选 question：Q1=[0,2], Q2=[1]", () => {
    expect(buildAuqKeystrokes(mkState([q3, q2], [[0, 2], [1]]))).toEqual([
      "1", "3", "Right", // Q1 toggle + 切段
      "2", "Right",      // Q2 toggle + 切段(落 Submit)
      "Enter",           // Submit 段提交
    ]);
  });

  test("多选+单选混合：Q1(multi)=[0], Q2(single)=[1]", () => {
    expect(buildAuqKeystrokes(mkState([q3, qSingle], [[0], [1]]))).toEqual([
      "1", "Right",  // Q1 toggle + 切段
      "2", "Enter",  // Q2 数字移光标 + Enter 选定并自动跳段
      "Enter",       // Submit 段提交
    ]);
  });

  test("空选择（用户不选直接 submit）也能跑出键序列", () => {
    expect(buildAuqKeystrokes(mkState([q3, q2], [[], []]))).toEqual(["Right", "Right", "Enter"]);
  });
});
