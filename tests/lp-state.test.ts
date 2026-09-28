/**
 * lib/lp-state.ts：状态栏画面 → low-priority 状态、「设成开 / 设成关」的决策表、额度菜单导航。
 * tests/fixtures/lp/ 是 2026-09-29 撞墙时在沙箱里抓的真实画面（capture-pane -p -e，CC 2.1.283）。
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  decideLp, inputStateOf, lastLpEcho, LP_MENU_LABEL, LP_WAIT_LABEL, menuKeysTo, parseMenu, readLpPane, selectedLabel, stripAnsi, type LpRead,
} from "../src/lib/lp-state.js";

const fx = (name: string) => readFileSync(join(import.meta.dir, "fixtures", "lp", `${name}.ansi`), "utf8");
const read = (name: string) => readLpPane(fx(name));

/** 按真实画面的布局拼一个：对话 + 输入框 + 状态栏 */
function pane(opts: { above?: string[]; input?: string; footer: string[] }): string {
  const rule = "─".repeat(80);
  return [...(opts.above ?? ["⏺ hi", "✻ Worked for 3s · done 1:00 AM"]), rule, `❯ ${opts.input ?? ""}`, rule, ...opts.footer.map((l) => `  ${l}`)].join("\n");
}

describe("真实画面 → 状态", () => {
  const cases: [string, Partial<LpRead>][] = [
    ["walled", { lowPriority: "off", offer: true, walled: true, resetsAt: "3:20am", busy: false, input: "empty" }],
    ["walled-channel", { lowPriority: "off", offer: true, walled: true, busy: false }],
    ["lp-on-autocontinue", { lowPriority: "on", resetsAt: "3:20am", busy: true }],
    ["lp-on-allowance", { lowPriority: "on", allowancePct: 91, busy: false, input: "empty" }],
    ["lp-on-interrupted", { lowPriority: "on", busy: false }],
    ["lp-on-suggestion", { lowPriority: "on", input: "empty" }], // 输入框里的灰字是 CC 的提示建议，不是草稿
    ["busy-queued", { lowPriority: "on", busy: true, input: "queued" }],
    ["compacting", { lowPriority: "on", compacting: true }],
    ["compact-api-retry", { lowPriority: "on", busy: true }],
    ["compacted", { lowPriority: "on", busy: false, compacting: false }],
    ["lp-off-offer", { lowPriority: "off", offer: true, walled: false }],
    ["lp-off-resumable", { lowPriority: "off", offer: false, resumable: true }],
    ["fresh-placeholder", { lowPriority: "off", offer: false, walled: false, input: "empty" }],
    ["fresh-unavailable", { lowPriority: "off", offer: false }],
    ["draft", { lowPriority: "off", input: "draft" }],
    ["walled-typing", { input: "draft" }],
  ];
  for (const [name, want] of cases) test(name, () => expect(read(name)).toMatchObject(want));

  test("撞墙等待不算忙：状态栏和对话里的「esc to cancel」不能触发判忙", () => {
    expect(fx("walled")).toContain("esc to cancel");
    expect(read("walled").busy).toBe(false);
  });

  test("额度菜单挡着时：有 LP 项判成「关、能开」，没有就判 unknown", () => {
    expect(read("menu-5-items")).toMatchObject({ lowPriority: "off", offer: true });
    expect(read("menu-on-lp").menu?.options.map((o) => o.label)).toContain(LP_MENU_LABEL);
    const noLp = read("menu-no-lp");
    expect(noLp.lowPriority).toBe("unknown");
    expect(noLp.menu?.options.map((o) => o.label)).toEqual(["Stop and wait for limit to reset", "Switch to usage credits"]);
  });
});

describe("只认状态栏，不认对话", () => {
  test("对话里提到 Lower priority until 不算开", () => {
    const p = pane({ above: ["⏺ 状态栏会显示「⚠ Lower priority until 3:20am · /low-priority to stop」"], footer: ["Opus 5.5 · 5h 40%", "⏵⏵ bypass permissions on"] });
    expect(readLpPane(p).lowPriority).toBe("off");
  });

  test("状态栏提到 low-priority 但文案认不出（CC 改了字）→ unknown，不许发", () => {
    const p = pane({ footer: ["⚠ Slower lane active till 3:20am · /low-priority to stop", "⏵⏵ bypass permissions on"] });
    const r = readLpPane(p);
    expect(r.lowPriority).toBe("unknown");
    expect(decideLp("off", r).kind).toBe("refuse");
    expect(decideLp("on", r).kind).toBe("refuse");
  });

  test("本周 LP 额度用完单独成一个状态", () => {
    const r = readLpPane(pane({ footer: ["⚠ You've used this week's lower-priority allowance", "⏵⏵ bypass permissions on"] }));
    expect(r.lowPriority).toBe("exhausted");
    expect(decideLp("on", r)).toMatchObject({ kind: "refuse" });
    expect((decideLp("on", r) as { reason: string }).reason).toContain("额度已用完");
  });

  test("找不到输入框 → unknown", () => {
    expect(readLpPane("just some shell output\n$ ").lowPriority).toBe("unknown");
  });
});

describe("决策表：设成开 / 设成关", () => {
  const table: [string, "on" | "off", string][] = [
    ["walled", "on", "send"],
    ["walled", "off", "skip"],
    ["lp-on-allowance", "on", "skip"],
    ["lp-on-allowance", "off", "send"],
    ["lp-on-autocontinue", "off", "busy"], // 忙时开关不发：排队的开关到回合结束才执行，那时可能切反
    ["busy-queued", "on", "busy"],
    ["compacting", "off", "skip"],
    ["lp-off-offer", "on", "send"],
    ["lp-off-resumable", "on", "send"],
    ["fresh-placeholder", "on", "refuse"], // 没撞墙：CC 只会回 isn't available
    ["fresh-unavailable", "off", "skip"],
    ["walled-typing", "on", "refuse"], // 输入框有草稿不动
    ["menu-5-items", "on", "send"],
    ["menu-5-items", "off", "skip"],
    ["menu-no-lp", "on", "escape-fail"],
  ];
  for (const [name, want, kind] of table) test(`${name} · 设成${want === "on" ? "开" : "关"} → ${kind}`, () => expect(decideLp(want, read(name)).kind).toBe(kind as never));

  test("菜单挡着时走菜单，不往输入框敲命令", () => {
    expect(decideLp("on", read("menu-on-credits"))).toEqual({ kind: "send", via: "menu" });
    expect(decideLp("on", read("walled"))).toEqual({ kind: "send", via: "command" });
  });
});

describe("额度菜单导航：只朝精确文案的允许项走", () => {
  test("光标在 Switch to usage credits 上 → 按一次 Up 到 LP", () => {
    const m = read("menu-on-credits").menu!;
    expect(selectedLabel(m)).toBe("Switch to usage credits");
    expect(menuKeysTo(m, LP_MENU_LABEL)).toEqual(["Up"]);
  });

  test("菜单项数会变（5 项 / 4 项），所以按文案算步数，不按固定步数", () => {
    expect(menuKeysTo(read("menu-5-items").menu!, LP_MENU_LABEL)).toEqual(["Down", "Down", "Down"]);
    expect(menuKeysTo(read("menu-on-lp").menu!, LP_MENU_LABEL)).toEqual([]);
  });

  test("危险项一律不导航：usage credits / Upgrade / Team plan / 领 credit", () => {
    const m = read("menu-5-items").menu!;
    for (const bad of ["Switch to usage credits", "Upgrade to Max", "Team plan", "While you wait, start a new cloud session by claiming a $250 credit", "Stop and wait for limit to reset"]) {
      expect(menuKeysTo(m, bad)).toBeNull();
    }
    expect(menuKeysTo(m, LP_WAIT_LABEL)).toBeNull(); // 允许但菜单里没有 → null
  });

  test("菜单里只剩危险项 → escape-fail（按 Esc 退出、报失败）", () => {
    const opts = ["Switch to usage credits", "Upgrade to Max for higher limits", "Switch to Team plan", "While you wait, start a new cloud session by claiming a $250 credit"];
    const raw = ["▔".repeat(80), "   What do you want to do?", "", ...opts.map((o, i) => `   ${i === 0 ? "❯ " : "  "}${i + 1}. ${o}`), "", "   Enter to confirm · Esc to cancel"].join("\n");
    const r = readLpPane(raw);
    expect(r.menu?.options).toHaveLength(4);
    expect(decideLp("on", r).kind).toBe("escape-fail");
    expect(opts.every((o) => menuKeysTo(r.menu!, o) === null)).toBe(true);
  });

  test("弯引号归一：Don’t → Don't", () => {
    expect(parseMenu(stripAnsi(fx("menu-5-items")).split("\n"))?.options.map((o) => o.label)).toContain("Don't continue automatically");
  });
});

describe("回显", () => {
  test("strict：只看最后一次 /low-priority 命令的回显", () => {
    expect(lastLpEcho(fx("lp-on-allowance"))?.echo).toBe("accepted");
    expect(lastLpEcho(fx("fresh-unavailable"))?.echo).toBe("unavailable");
    expect(lastLpEcho(fx("lp-off-offer"))?.echo).toBe("off");
  });

  test("刚发出、回显还没出来时 strict 不拿更早的回显冒充", () => {
    const raw = ["❯ /low-priority", "  ⎿  Lower-priority mode isn't available right now.", "❯ /low-priority", "─".repeat(80), "❯ ", "─".repeat(80)].join("\n");
    expect(lastLpEcho(raw)).toBeNull();
    expect(lastLpEcho(raw, false)?.echo).toBe("unavailable");
  });
});

describe("输入框", () => {
  test("灰字（ESC[2m）= 空；正常颜色的字 = 草稿；不带颜色抓的分不清 = unknown", () => {
    expect(inputStateOf(["❯ Try \"fix lint errors\""], ["\x1b[39m❯ \x1b[2mTry \"fix lint errors\"\x1b[0m"])).toBe("empty");
    expect(inputStateOf(["❯ draft text"], ["\x1b[39m❯ draft text"])).toBe("draft");
    expect(inputStateOf(["❯ draft text"], ["❯ draft text"])).toBe("unknown");
    expect(inputStateOf(["❯ "], ["❯ "])).toBe("empty");
    expect(inputStateOf(["❯ line1", "  line2"], ["❯ line1", "  line2"])).toBe("draft");
  });
});
