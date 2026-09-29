/**
 * 撞额度菜单上一个键都不发（T24）：launcher 的自动确认（lib/tmux-helper.ts isAutoConfirmableModal）、打字前的画面检查
 * （lib/wall-screen.ts）都认 lib/limit-menu.ts 的宽松菜单判定。样本 tests/fixtures/quota-wall/。
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { isAutoConfirmableModal } from "../src/lib/tmux-helper.js";
import { menuTitleShown } from "../src/lib/limit-menu.js";
import { matchLimitMenu, wallWaitKind } from "../src/lib/quota-wall-text.js";

const fx = (f: string): string => readFileSync(join(import.meta.dir, "fixtures/quota-wall", `${f}.txt`), "utf8");

describe("额度菜单不自动确认（T24 wf keys-screens-3：launcher 每 15 秒对 master 按 Enter 会替人选中高亮项）", () => {
  test("4 张真实菜单（含高亮停在 Switch to usage credits 上的）：launcher / 就绪轮询都不按", () => {
    for (const f of ["menu-no-lp", "menu-on-lp", "menu-5-items", "menu-on-credits", "menu-narrow60"]) {
      const pane = readFileSync(join(import.meta.dir, "fixtures/quota-wall", `${f}.txt`), "utf8");
      expect([f, isAutoConfirmableModal(pane), isAutoConfirmableModal(pane, { allowSessionIdle: true })]).toEqual([f, false, false]);
    }
  });
});

// adv3 P2-2：Ink 按词折行（续行保持缩进），按 CC 2.1.283 的选项排列合成；生成器同 tests/fixtures/quota-wall/menu-narrow34*.txt
function wrap(text: string, width: number, indent: number, cont: number): string[] {
  const out: string[] = [];
  let cur = " ".repeat(indent);
  text.split(" ").forEach((w, i) => {
    if (i > 0 && [...`${cur} ${w}`].length > width) out.push(cur), (cur = " ".repeat(cont) + w);
    else cur = i ? `${cur} ${w}` : cur + w;
  });
  return [...out, cur];
}
function menu(width: number, opts: string[]): string {
  const L = [...wrap("⏺ Usage limit reached · continuing automatically at 3:20am · esc or type to cancel", width, 0, 2), "", "▔".repeat(width)];
  L.push(...wrap("What do you want to do?", width, 3, 3), "");
  opts.forEach((o, i) => L.push(...wrap(`${i === 0 ? "❯" : " "} ${i + 1}. ${o}`, width, 3, 8)));
  return [...L, "", ...wrap("Enter to confirm · Esc to cancel", width, 3, 3)].join("\n");
}
const STD = ["Stop and wait for limit to reset", "Wait here, then continue automatically at Sep 30 at 6am", "Switch to usage credits"];
const VARIANTS: Record<string, string[]> = {
  "标准 3 项": STD,
  "tengu_jade_anvil_4：花钱项排第 1": ["Switch to usage credits", STD[0]!, STD[1]!],
  "Upgrade 排第 1": ["Upgrade your plan", STD[0]!],
  "usage_based：Stop / Switch to usage": ["Stop", "Switch to usage"],
  "usage_based + 花钱项第 1": ["Switch to usage", "Stop"],
  "usage_based：Stop / Add funds": ["Stop", "Add funds to continue with usage"],
  "5 项（T35 实录那一版）": [...STD, "Switch to lower priority", "Upgrade your plan"],
  "6 项、花钱项第 1": ["Switch to usage credits", ...STD.slice(0, 2), "Switch to lower priority", "Upgrade your plan", "Stop"],
};

describe("窄窗口、别的计费方式下的额度菜单：打字 / 回车 / Esc 类入口一律 0 键（adv3 P2-2）", () => {
  test("8 种选项排列 × 80~16 列：都认成菜单（斜杠直通、cron、save-compact、人类消息、停字、停止按钮都据此不发键），launcher 不自动确认", () => {
    for (const [name, opts] of Object.entries(VARIANTS)) {
      for (const w of [80, 60, 48, 40, 36, 34, 32, 30, 28, 26, 24, 22, 20, 18, 16]) { // ≤20 列折成几十行，标题在最后 24 行之外（T24 审查 P2-4）
        const p = menu(w, opts);
        expect([name, w, wallWaitKind(p), isAutoConfirmableModal(p), isAutoConfirmableModal(p, { allowSessionIdle: true })]).toEqual([name, w, "menu", false, false]);
      }
    }
  });
  test("固定样本（34 列标准菜单、34 列花钱项排第 1、80 列 usage_based、28 列 usage_based 花钱项第 1）：认成菜单；折行的、第 1 项不是 Stop and wait 的都不算完整认得，出闸不发 Esc", () => {
    for (const f of ["menu-narrow34", "menu-narrow34-credits-first", "menu-usage-based", "menu-narrow28-usage-first"]) {
      const p = fx(f);
      expect([f, wallWaitKind(p), matchLimitMenu(p)]).toEqual([f, "menu", false]);
    }
  });
  test("选项一个都不认得、提示行也没有：只要底部有「What do you want to do?」、下面没有输入框，照样不发键", () => {
    const odd = ["⏺ something", "▔".repeat(40), "   What do you want to do?", "", "   ❯ 1. Brand new option", "     2. Another one"].join("\n");
    expect(wallWaitKind(odd)).toBe("menu");
    expect(menuTitleShown(odd.split("\n"))).toBe(true);
  });
  test("对话里引用了这句、下面是输入框：不是菜单（照常投递 / 打字）", () => {
    const quoted = ["⏺ CC 的额度菜单标题是：", "   What do you want to do?", "   ❯ 1. Stop and wait for limit to reset", "", "─".repeat(40), "❯ ", "─".repeat(40), "  ? for shortcuts"].join("\n");
    expect(wallWaitKind(quoted)).toBeNull();
    expect(menuTitleShown(quoted.split("\n"))).toBe(false);
  });
});
