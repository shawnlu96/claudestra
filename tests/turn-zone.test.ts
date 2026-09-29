/**
 * 抢占判忙只认顶格的输入框和 spinner 行（lib/turn-state.ts turnZone / paneMainTurnBusy）。
 * 对抗式审查员画面探针的 C、D 两组：底部是空闲输入框或权限弹窗，对话区里贴着一段忙画面（缩进的假输入框、spinner、
 * 排队提示、esc to interrupt、倒计时、整段额度菜单）——判成忙就会往空闲输入框或权限弹窗上发 C-c，后者等于替人拒了权限。
 * 真画面样本 fixtures/turn-zone/*.txt 来自 T35 沙箱实录（去掉 ANSI）；cc-*.txt 是 wf2 审查员用真 CC 2.1.283 + 假模型抓的。
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createInterruptGate } from "../src/lib/interrupt-gate.js";
import { paneShowsWallWait } from "../src/lib/quota-wall-text.js";
import { agentMsgMustWait, inputBox, paneMainTurnBusy, paneShowsApiRetry, paneShowsCompacting, thinkingLooksStuck, turnState } from "../src/lib/turn-state.js";
import { wallWaitKind } from "../src/lib/quota-wall-text.js";

const fx = (f: string) => readFileSync(join(import.meta.dir, "fixtures/turn-zone", `${f}.txt`), "utf8");
const B = "─".repeat(40);
const W = "─".repeat(80);

/** 贴进对话的忙画面（agent 回复里的代码块 / Bash 输出的抓屏，CC 渲染时缩进 2~5 格） */
const FAKES: Record<string, string[]> = {
  空假框: ["", "⏺ 输入框长这样：", "", `  ${B}`, "  ❯ ", `  ${B}`, ""],
  "假框+排队提示": ["", "⏺ agent-b 的画面：", "", "  ✢ Hatching… (running Stop hook · 3s · ↓ 10 tokens)", "", `  ${B}`, "  ❯ Press up to edit queued messages", `  ${B}`, ""],
  "假框+上方spinner": ["", "⏺ 刚才抓到的：", "  ✻ Pondering… (2m 23s · ↓ 9.9k tokens)", "", `  ${B}`, "  ❯ ", `  ${B}`, ""],
  "假框+老TUI esc to interrupt": ["", "⏺ 老版本：", `  ${B}`, "  ❯ ", `  ${B}`, "    esc to interrupt", ""],
  "假框+假倒计时页脚": ["", "⏺ 撞墙时的画面：", `  ${B}`, "  ❯ ", `  ${B}`, "    ⚠ Usage limit reached · continuing automatically at 3:20am · esc to cancel", ""],
  "假框+压缩和重试": ["", "⏺ 压缩时：", "  ✻ Compacting conversation… (12s)", "  ✻ Repeated 529 Overloaded errors · Retrying in 38s", `  ${B}`, "  ❯ ", `  ${B}`, ""],
};
const OLD_COUNTDOWN = ["⏺ Usage limit reached · continuing automatically at 3:20am · esc or type", "  to cancel", "  ⎿  /low-priority to continue now at lower priority", ""];
const QUOTED_MENU = ["   What do you want to do?", "   ❯ 1. Stop and wait for limit to reset", "     2. Switch to usage credits", "   Enter to confirm · Esc to cancel"];
const IDLE = ["", "⏺ 好的。", "", "✻ Worked for 3s · done 2:00 AM", "", W, "❯ ", W, "  Opus 5.5 · 5h 40% · 7d 28%", "  ⏵⏵ bypass permissions on (shift+tab to cycle) · ← for agents"];

function inject(frame: string, after: RegExp, block: string[]): string {
  const lines = frame.split("\n");
  const i = lines.findIndex((l) => after.test(l));
  if (i < 0) throw new Error(`样本里没有 ${after}`);
  lines.splice(i + 1, 0, ...block);
  return lines.join("\n");
}

/** 走真的抢占闸：判忙用 turnState（事件态 done，同审查员探针），撞墙判定用 paneShowsWallWait；返回发出的键 */
async function keysFor(pane: string): Promise<string[]> {
  const keys: string[] = [];
  const gate = createInterruptGate({
    resolve: async () => ({ win: "master:agent-a" }),
    probe: async () => turnState({ pane, status: "done" }),
    wallWait: async () => paneShowsWallWait(pane),
    interrupt: async () => (keys.push("C-c"), ["C-c"]),
    onPreempted: () => undefined,
    sleep: async () => undefined,
  });
  await gate.preempt("c1", "agent-a");
  return keys;
}

const screensC: [string, string][] = [
  ["空闲基线", IDLE.join("\n")],
  ["对话里旧倒计时", [...OLD_COUNTDOWN, ...IDLE].join("\n")],
  ...Object.entries(FAKES).map(([k, b]): [string, string] => [`旧倒计时 + ${k}`, [...OLD_COUNTDOWN, ...b, ...IDLE].join("\n")]),
  ["对话里整段额度菜单（引用）", [...QUOTED_MENU, ...IDLE].join("\n")],
];
const perm = fx("modal-permission");
const screensD: [string, string][] = [
  ["权限弹窗基线（弹窗自带「Esc to cancel」）", perm],
  ...Object.entries(FAKES).map(([k, b]): [string, string] => [`权限弹窗 + ${k}`, inject(perm, /perm-probe\.txt$/, b)]),
  ["权限弹窗 + 整段额度菜单（引用）", inject(perm, /perm-probe\.txt$/, QUOTED_MENU)],
];

describe("C 组：底部是空闲输入框，对话区贴着忙画面 → 一个键都不发", () => {
  for (const [name, pane] of screensC) {
    test(name, async () => {
      expect(turnState({ pane, status: "done" }).main).toBe("idle");
      expect(await keysFor(pane)).toEqual([]);
    });
  }
});

describe("D 组：底部是权限弹窗，对话区贴着忙画面 → 一个键都不发", () => {
  for (const [name, pane] of screensD) {
    test(name, async () => {
      expect(paneMainTurnBusy(pane)).toBe(false);
      expect(paneShowsCompacting(pane)).toBe(false);
      expect(await keysFor(pane)).toEqual([]);
    });
  }
});

describe("对照：真画面照旧判对", () => {
  test("真在跑（顶格 spinner + 顶格排队提示，T35 实录）→ 忙，发一次 C-c；对话里再贴假空闲框也不改判", async () => {
    const busy = fx("busy-queued");
    expect(paneMainTurnBusy(busy)).toBe(true);
    expect(await keysFor(busy)).toEqual(["C-c"]);
    expect(paneMainTurnBusy(inject(busy, /^⏺ 1$/, FAKES["空假框"]!))).toBe(true);
  });
  test("真在压缩（T35 实录）→ compacting，不发键", async () => {
    const c = fx("compacting");
    expect(turnState({ pane: c, status: "done" }).main).toBe("compacting");
    expect(await keysFor(c)).toEqual([]);
  });
  test("真重试横幅顶格 → 忙且认作重试；缩进的同样字样不算", () => {
    const retry = ["⏺ 我先跑一下检查。", "", "✻ Repeated 529 Overloaded errors · Retrying in 38s · attempt 5/10", "", ...IDLE.slice(5)].join("\n");
    expect(paneShowsApiRetry(retry)).toBe(true);
    expect(paneMainTurnBusy(retry)).toBe(true);
    expect(paneShowsApiRetry([...FAKES["假框+压缩和重试"]!, ...IDLE].join("\n"))).toBe(false);
  });
  test("草稿里有一条缩进横线（T35 实录 input-draft-rule）：仍按顶格边框找到输入框、判闲", () => {
    expect(turnState({ pane: fx("input-draft-rule"), status: "done" }).main).toBe("idle");
  });
  test("老 TUI：页脚里的 esc to interrupt 照旧算忙——带不带 ⏵⏵、窄窗口折行都一样", () => {
    const head = IDLE.slice(0, 9);
    expect(paneMainTurnBusy([...head, "  ⏵⏵ bypass permissions on (shift+tab to cycle) · esc to interrupt"].join("\n"))).toBe(true);
    expect(paneMainTurnBusy([...head, "  esc to interrupt"].join("\n"))).toBe(true);
    expect(paneMainTurnBusy([...head, "  ⏵⏵ bypass permissions on · esc to", "  interrupt"].join("\n"))).toBe(true);
  });
  test("输入框上方贴进来一行缩进的「⏵⏵ … esc to interrupt」、草稿里写着 esc to interrupt：都不算忙（adv2 P2-3）", () => {
    const pasted = ["⏺ 老版本页脚长这样：", "  ⏵⏵ bypass permissions on (shift+tab to cycle) · esc to interrupt", ...IDLE].join("\n");
    expect(paneMainTurnBusy(pasted)).toBe(false);
    const draft = IDLE.map((l) => (l === "❯ " ? "❯ 页脚上的 esc to interrupt 是什么意思" : l)).join("\n");
    expect(paneMainTurnBusy(draft)).toBe(false);
  });
});

describe("thinking 反向对账只在顶格的真输入框在时才成立（adv2 P2-2）", () => {
  test("权限框 / AskUserQuestion / 额度菜单里的「❯ 1.」不是输入框：事件态 thinking 也不判卡住", () => {
    for (const f of ["modal-permission", "modal-auq", "menu-5-items"]) expect(thinkingLooksStuck(fx(f), "thinking", false)).toBe(false);
  });
  test("真输入框、主回合空闲、事件态 thinking → 判卡住；对话里贴了假输入框、底部是权限框 → 不判", () => {
    expect(thinkingLooksStuck(IDLE.join("\n"), "thinking", false)).toBe(true);
    expect(thinkingLooksStuck(inject(perm, /perm-probe\.txt$/, FAKES["空假框"]!), "thinking", false)).toBe(false);
  });
});

describe("真 CC 画面（wf2 keys-screens-1）：缩进引用的忙页脚「⏵⏵ … · esc to interrupt」不算忙", () => {
  test("空闲输入框上方 12 行内引用了一段在跑窗口的抓屏（末行是忙页脚）→ 判闲、不发键、agent 消息也不押", async () => {
    const pane = fx("cc-idle-quoted-footer");
    const st = turnState({ pane, status: "done" });
    expect(st.main).toBe("idle");
    expect(agentMsgMustWait(st)).toBe(false);
    expect(await keysFor(pane)).toEqual([]);
  });
  test("权限弹窗上方引用了 spinner / 压缩 / 重试 / 假框 / 忙页脚；另加一条紧贴弹窗边框的引用页脚 → 不发键", async () => {
    const pane = fx("cc-perm-quoted");
    expect(await keysFor(pane)).toEqual([]);
    const tight = inject(pane, /^ {2}⎿ {2}\$ touch perm2\.txt$/, ["    ⏵⏵ auto mode on (shift+tab to cycle) · esc to interrupt · ← for agents"]);
    expect(paneMainTurnBusy(tight)).toBe(false);
    expect(await keysFor(tight)).toEqual([]);
  });
  test("对照：真在跑（顶格 spinner + 真页脚）、真重试横幅之后的空闲、压缩中排队（真页脚带 esc to interrupt）", async () => {
    expect(await keysFor(fx("cc-busy-stream1"))).toEqual(["C-c"]);
    expect(turnState({ pane: fx("cc-retry1"), status: "done" }).main).toBe("idle");
    expect(paneMainTurnBusy(fx("cc-compact1"))).toBe(true);
  });
});

describe("输入框判定（PM 09-29）：上下两条顶格、整行只有 ─ 的边框夹着顶格 ❯，❯ 后面不是「1.」选项", () => {
  const box = (rule: string, prompt = "❯ ") => [rule, prompt, rule, "  ⏵⏵ bypass permissions on (shift+tab to cycle)"];
  test("顶格的「─── 小标题」不算边框", () => {
    expect(inputBox(["✻ Worked for 3s", "─── 小标题", "❯ ", "─── 小标题"])).toBeNull();
    expect(inputBox(box("─── 小标题"))).toBeNull();
  });
  test("窄窗口里短的整行边框算；行尾有空白也算", () => {
    expect(inputBox(box("─────"))).toEqual({ top: 0, bottom: 2 });
    expect(inputBox(box("───   "))).toEqual({ top: 0, bottom: 2 });
  });
  test("❯ 后面是「1.」选项（弹窗）不算输入框；草稿以数字开头但不是「1.」的照算", () => {
    expect(inputBox(box("─".repeat(40), "❯ 1. Yes"))).toBeNull();
    expect(inputBox(box("─".repeat(40), "❯ 2026 年的计划"))).toEqual({ top: 0, bottom: 2 });
  });
  test("只有上边框、没有下边框的不算", () => {
    expect(inputBox(["─".repeat(40), "❯ ", "  ⏵⏵ bypass permissions on"])).toBeNull();
  });
});

describe("撞墙倒计时窗口里草稿很长（wf2 keys-screens-5）", () => {
  test("输入框里 13 行草稿：仍能找到上边框，认出倒计时", () => {
    const walled = readFileSync(join(import.meta.dir, "fixtures/quota-wall", "walled.txt"), "utf8");
    const draft = ["❯ 第 1 行草稿", ...Array.from({ length: 12 }, (_, k) => `  第 ${k + 2} 行草稿`)];
    const lines = walled.split("\n");
    const at = lines.findIndex((l, i) => l.startsWith("❯") && /^─+$/.test(lines[i - 1] ?? ""));
    const long = [...lines.slice(0, at), ...draft, ...lines.slice(at + 1)].join("\n");
    expect(long.split("\n").length).toBeGreaterThan(walled.split("\n").length + 10);
    expect(wallWaitKind(long)).toBe("countdown");
  });
});
