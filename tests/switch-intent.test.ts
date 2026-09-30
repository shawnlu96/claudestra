/**
 * 切换意图（lib/switch-intent.ts，permission-watcher 用；T41c）：只认 bridge 登记过、目标完全一致的框，一次意图只按一张；
 * 没登记过的框哪怕和 registry 钉的是同一家族也不按（T41a r4 P1-1）。真实 CC 2.1.280 原屏。
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  clearSwitchIntent, clearSwitchNotice, consumeSwitchIntent, expireSettledIntents, isPressedBox, markSwitchNotified,
  noteEffortSwitchIntent, noteModelSwitchIntent, notePressedBox, switchBoxAction, switchNoticePlan,
} from "../src/lib/switch-intent.ts";
import { detectSwitchConfirmPrompt } from "../src/lib/tmux-helper.ts";

const fx = (f: string): string => readFileSync(join(import.meta.dir, "fixtures", "switch-confirm", f), "utf8");
const SWITCH_MODEL = fx("cc2.1.280-switch-model.txt");
const MODEL = detectSwitchConfirmPrompt(SWITCH_MODEL)!;
const OLDER = detectSwitchConfirmPrompt(SWITCH_MODEL.replaceAll("Sonnet 5", "Sonnet 4.6"))!;
const EFFORT = detectSwitchConfirmPrompt(fx("cc2.1.280-change-effort.txt"))!;

describe("consumeSwitchIntent", () => {
  test("没登记过意图的框（哪怕和钉的家族相同）→ 不按", () => {
    expect(consumeSwitchIntent("t41c-none", MODEL)).toBe(false);
    expect(consumeSwitchIntent("t41c-none", EFFORT)).toBe(false);
  });

  test("意图是 Sonnet 5，框是 Sonnet 4.6 → 不按，意图留着等自己的框", () => {
    noteModelSwitchIntent("t41c-a", "claude-sonnet-5");
    expect(consumeSwitchIntent("t41c-a", OLDER)).toBe(false);
    expect(consumeSwitchIntent("t41c-a", MODEL)).toBe(true);
  });

  test("一条意图只按一张框", () => {
    noteModelSwitchIntent("t41c-b", "claude-sonnet-5");
    expect(consumeSwitchIntent("t41c-b", MODEL)).toBe(true);
    expect(consumeSwitchIntent("t41c-b", MODEL)).toBe(false);
  });

  test("认不出版本的目标不登记，还会作废旧意图", () => {
    noteModelSwitchIntent("t41c-c", "claude-sonnet-5");
    noteModelSwitchIntent("t41c-c", "my-proxy-model");
    expect(consumeSwitchIntent("t41c-c", MODEL)).toBe(false);
  });

  test("过期（60s）不认；clearSwitchIntent 撤掉", () => {
    noteModelSwitchIntent("t41c-d", "claude-sonnet-5");
    expect(consumeSwitchIntent("t41c-d", MODEL, Date.now() + 60_001)).toBe(false);
    noteEffortSwitchIntent("t41c-e", "high");
    clearSwitchIntent("t41c-e", "effort");
    expect(consumeSwitchIntent("t41c-e", EFFORT)).toBe(false);
  });

  test("effort 按档位全等；种类不符不认", () => {
    noteEffortSwitchIntent("t41c-f", "medium");
    expect(consumeSwitchIntent("t41c-f", EFFORT)).toBe(false);
    noteEffortSwitchIntent("t41c-f", "HIGH");
    expect(consumeSwitchIntent("t41c-f", MODEL)).toBe(false);
    expect(consumeSwitchIntent("t41c-f", EFFORT)).toBe(true);
  });
});

describe("isPressedBox", () => {
  test("按过的那张框：20s 内的旧帧不再按也不报，换了框 / 过了时间照常处理", () => {
    expect(isPressedBox("t41c-g", SWITCH_MODEL)).toBe(false);
    const t = Date.now();
    notePressedBox("t41c-g", SWITCH_MODEL, t);
    expect(isPressedBox("t41c-g", SWITCH_MODEL, t + 700)).toBe(true);
    expect(isPressedBox("t41c-g", SWITCH_MODEL.replaceAll("Sonnet 5", "Sonnet 4.6"), t + 700)).toBe(false);
    expect(isPressedBox("t41c-g", SWITCH_MODEL, t + 20_001)).toBe(false);
  });
});

describe("switchBoxAction（watcher 对 agent 和大总管同一套）", () => {
  test("没框 → none；没意图 → notify 带框指纹；意图对上 → press 一次，旧帧 stale，意图用掉后新框 notify", () => {
    const t = Date.now();
    expect(switchBoxAction("master", fx("cc2.1.280-model-set.txt"), t).act).toBe("none");
    const n = switchBoxAction("master", SWITCH_MODEL, t);
    expect(n.act).toBe("notify");
    expect(n.act === "notify" && n.box).toMatch(/^[0-9a-f]{12}$/);
    noteModelSwitchIntent("master", "claude-sonnet-5");
    expect(switchBoxAction("master", SWITCH_MODEL, t).act).toBe("press");
    expect(switchBoxAction("master", SWITCH_MODEL, t + 700).act).toBe("stale");
    expect(switchBoxAction("master", SWITCH_MODEL, t + 20_001).act).toBe("notify");
    noteModelSwitchIntent("master", "claude-sonnet-5"); // 下一条测试从干净状态开始
    expect(switchBoxAction("master", fx("cc2.1.280-model-set.txt"), Date.now() + 10_000).act).toBe("none");
  });

  test("意图是 Sonnet 5、框是 Sonnet 4.6 → notify，不按", () => {
    noteModelSwitchIntent("t41c-h", "claude-sonnet-5");
    expect(switchBoxAction("t41c-h", SWITCH_MODEL.replaceAll("Sonnet 5", "Sonnet 4.6")).act).toBe("notify");
  });
});

describe("意图只活到命令被 CC 处理为止（T41c r1 P1-1）", () => {
  const IDLE = fx("cc2.1.280-model-set.txt");
  const BUSY = readFileSync(join(import.meta.dir, "fixtures", "turn-zone", "busy-queued.txt"), "utf8");

  test("/model 无框直接落地（会话回到空闲）→ 意图作废，之后 CC 自己弹的同目标框只通知", () => {
    const t = Date.now();
    noteModelSwitchIntent("t41c-i", "claude-sonnet-5");
    expect(switchBoxAction("t41c-i", IDLE, t + 6_000).act).toBe("none");
    expect(switchBoxAction("t41c-i", SWITCH_MODEL, t + 60_000).act).toBe("notify");
  });

  test("刚注入的宽限内（框还没画出来）看到空闲屏不作数", () => {
    const t = Date.now();
    noteModelSwitchIntent("t41c-j", "claude-sonnet-5");
    expireSettledIntents("t41c-j", IDLE, t + 1_000);
    expect(switchBoxAction("t41c-j", SWITCH_MODEL, t + 2_000).act).toBe("press");
  });

  test("忙着（命令还在排队）不因空闲判据作废，但 60s 上限照样生效：之后才弹的框只通知", () => {
    const t = Date.now();
    noteModelSwitchIntent("t41c-k", "claude-sonnet-5");
    for (const dt of [10_000, 40_000]) expect(switchBoxAction("t41c-k", BUSY, t + dt).act).toBe("none");
    expect(switchBoxAction("t41c-k", SWITCH_MODEL, t + 45_000).act).toBe("press");
    noteModelSwitchIntent("t41c-k2", "claude-sonnet-5");
    expect(switchBoxAction("t41c-k2", BUSY, t + 30_000).act).toBe("none");
    expect(switchBoxAction("t41c-k2", SWITCH_MODEL, t + 61_000).act).toBe("notify");
  });

  test("effort 意图同理", () => {
    const t = Date.now();
    noteEffortSwitchIntent("t41c-l", "high");
    expireSettledIntents("t41c-l", IDLE, t + 6_000);
    expect(consumeSwitchIntent("t41c-l", EFFORT, t + 7_000)).toBe(false);
  });

  test("按过的框关掉后，再弹一张同指纹的新框不当旧帧压掉", () => {
    const t = Date.now();
    noteModelSwitchIntent("t41c-m", "claude-sonnet-5");
    expect(switchBoxAction("t41c-m", SWITCH_MODEL, t).act).toBe("press");
    expect(switchBoxAction("t41c-m", IDLE, t + 1_000).act).toBe("none");
    expect(switchBoxAction("t41c-m", SWITCH_MODEL, t + 2_000).act).toBe("notify");
  });
});

describe("通知去重：同一张框只报一次，Discord 失败下一轮重试（T41c r1 P2）", () => {
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
