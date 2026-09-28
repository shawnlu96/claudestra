/**
 * lib/stop-words.ts：只认整句停字（设计稿 §3.6 + owner 09-28 批的「等一下 / 等等 / wait」）。
 * 「不是停」一组里是对抗式审查（#148 第 2 轮）列出的误判清单：句首停字后面接着说正事，交给 agent 判断。
 */
import { describe, expect, test } from "bun:test";
import { matchStopWord, ownerStopOf } from "../src/lib/stop-words.js";

describe("整句停字", () => {
  const yes = ["停", "停。", "停！", "停下", "停止", "先停", "停一下", "停停停", "别做了", "别跑了", "不要做了", "取消", "取消。",
    "等一下", "等一下。", "等等", "stop", "Stop.", "STOP!", "stop stop", "abort", "cancel", "halt", "wait", "Wait!", "wait…", "  停  ", "ｓｔｏｐ"];
  for (const s of yes) {
    test(`「${s}」`, () => expect(matchStopWord(s).stop).toBe(true));
  }
});

describe("不是停", () => {
  const no = [
    // 对抗式审查的误判清单
    "Stop hook 为啥没触发", "stop hook 报错了", "Stop 事件丢了", "Stop button 没反应", "stop 按钮", "abort controller 怎么用", "halt 指令",
    "stop-words 的单测挂了", "halt-on-error 参数怎么设",
    "停止 bridge 服务前先备份", "停止 launchd 服务", "取消 PR #12 的 auto-merge", "取消 cron 任务 foo", "暂停 cron 任务", "停一下 CI 再合",
    "wait, for CI", "Wait... what?", "wait? 这不对吧",
    "等等，还有一个需求：顺便把 Y 也改了", "等一下，你先把刚才那个跑完再说", "停，继续", "stop! 好了继续吧",
    // 原来就判对的
    "wait for CI", "等等再说", "稍等一下我发你文件", "等一下我发你文件", "停车场", "停止按钮不好用",
    "", "我等一下再看", "先别部署了，看下 X", "stopwatch 组件怎么写", "please stop", "不要停",
    "停停停停停停停停停停", // 超过 8 个字：多半是语音转写跑飞
  ];
  for (const s of no) {
    test(`「${s}」`, () => expect(matchStopWord(s).stop).toBe(false));
  }
});

describe("只认 owner 的「停」（对抗式第 3 轮 P1-A）", () => {
  test("Discord 放行用户、owner 的 API token → 停", () => {
    expect(ownerStopOf({ from: { kind: "user" }, content: "停" })).toEqual({ owner: true, stop: true });
    expect(ownerStopOf({ from: { kind: "api", owner: true }, content: "stop" })).toEqual({ owner: true, stop: true });
  });
  test("非 owner 的 API 用户 / peer 发「停」→ 普通消息，也不算 owner 说过话（解不开 owner 的停）", () => {
    expect(ownerStopOf({ from: { kind: "api" }, content: "停" })).toEqual({ owner: false, stop: false });
    expect(ownerStopOf({ from: { kind: "api", owner: false }, content: "stop" })).toEqual({ owner: false, stop: false });
    expect(ownerStopOf({ from: { kind: "api", owner: true, peer: "ahh" }, content: "停" })).toEqual({ owner: false, stop: false });
  });
  test("owner 说的不是停：owner=true、stop=false（解除叫停）", () => {
    expect(ownerStopOf({ from: { kind: "user" }, content: "hi" })).toEqual({ owner: true, stop: false });
  });
});
