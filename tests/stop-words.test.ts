/**
 * lib/stop-words.ts：整句停字、句首停字 + 标点 / 空格算停；句中出现、句首停字后直接接字不算。
 * 「等一下 / 等等 / wait」是 owner 09-28 拍板加的。
 */
import { describe, expect, test } from "bun:test";
import { matchStopWord } from "../src/lib/stop-words.js";

describe("整句停字", () => {
  const yes = ["停", "停。", "停！", "停下", "停下来", "停止", "先停", "停一下", "停停停", "别做了", "别跑了", "不要做了", "取消", "取消。",
    "等一下", "等一下。", "等等", "先等等", "暂停", "stop", "Stop.", "STOP!", "stop stop", "abort", "cancel", "halt", "wait", "Wait!", "wait…", "  停  ", "ｓｔｏｐ"];
  for (const s of yes) {
    test(`「${s}」`, () => expect(matchStopWord(s)).toEqual({ stop: true, rest: "" }));
  }
});

describe("句首停字 + 标点 / 空格：停，剩下的照常交给 agent", () => {
  const cases: [string, string][] = [
    ["停！先别合", "先别合"],
    ["停，先别部署了", "先别部署了"],
    ["等一下，先看看 X", "先看看 X"],
    ["等一下 先看看 X", "先看看 X"],
    ["等等。我想想", "我想想"],
    ["停下来，看下日志", "看下日志"],
    ["stop, look at the logs first", "look at the logs first"],
    ["Stop the deploy", "the deploy"],
    ["abort — wrong branch", "wrong branch"],
    ["wait, check X first", "check X first"],
    ["Wait. Not that one", "Not that one"],
    ["cancel! wrong agent", "wrong agent"],
  ];
  for (const [s, rest] of cases) {
    test(`「${s}」→ 剩「${rest}」`, () => expect(matchStopWord(s)).toEqual({ stop: true, rest }));
  }
});

describe("不是停", () => {
  const no = [
    "",
    "我等一下再看",
    "先别部署了，看下 X",
    "等一下再看",
    "等等我",
    "停止运行服务前先备份",
    "停车场那个接口",
    "取消订单的接口在哪",
    "stopwatch 组件怎么写",
    "wait for the build then deploy",
    "cancel the subscription for user 42",
    "please stop",
    "不要停",
    "这个按钮点了没反应，停在加载中",
    "停停停停停停停停停停", // 超过 8 个字：不当整句停字（多半是语音转写跑飞），也没有分隔符
  ];
  for (const s of no) {
    test(`「${s}」`, () => expect(matchStopWord(s).stop).toBe(false));
  }
});
