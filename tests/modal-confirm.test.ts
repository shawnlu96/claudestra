/**
 * launcher 自动确认不按在草稿上（T41a）：lib/modal-confirm.ts isAutoConfirmableModal 先按框形状认输入框，真输入框在 = 没有弹窗。
 * 全部用真实 capture-pane 样本（tests/fixtures/）；合成的启动期弹窗见 tests/modal-parser.test.ts。
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { isAutoConfirmableModal } from "../src/lib/modal-confirm.js";

const fx = (f: string): string => readFileSync(join(import.meta.dir, "fixtures", f), "utf8").replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "");
const both = (pane: string) => [isAutoConfirmableModal(pane), isAutoConfirmableModal(pane, { allowSessionIdle: true })];

describe("草稿 / 对话里的编号列表：一个键都不按", () => {
  test("输入框里的多行编号草稿（首行「❯ 4. …」）、回合中屏上的编号列表、「1.」开头的草稿", () => {
    for (const f of ["turn-zone/cc-numlist-draft.txt", "turn-zone/cc-busy-numlist-vis.txt", "turn-zone/cc-draft-num.txt", "turn-zone/input-draft-rule.txt"]) {
      expect([f, ...both(fx(f))]).toEqual([f, false, false]);
    }
  });
  test("lp 样本里的各种草稿 / 建议文字 / shell 模式输入", () => {
    for (const f of ["draft", "input-draft", "input-draft-long", "input-draft-multiline", "input-draft-rule", "input-suggestion", "input-bash-typed"]) {
      expect([f, ...both(fx(`lp/${f}.ansi`))]).toEqual([f, false, false]);
    }
  });
});

describe("要人决定的真弹窗：不按", () => {
  test("AskUserQuestion（Enter 等于替人选第 1 项）、权限框、额度菜单、Bypass 首启框", () => {
    for (const f of ["turn-zone/modal-auq.txt", "turn-zone/cc-auq-opt4.txt", "lp/modal-auq.ansi", "turn-zone/modal-permission.txt",
      "turn-zone/cc-perm-quoted.txt", "turn-zone/menu-5-items.txt", "cc-bypass-consent-pane.txt"]) {
      expect([f, ...both(fx(f))]).toEqual([f, false, false]);
    }
  });
});

describe("盖住输入框的普通确认框：照常自动按", () => {
  test("CC 2.1.280 实抓的选择框（❯ 1. 高亮，底下没有输入框）", () => {
    for (const f of ["switch-confirm/cc2.1.280-switch-model.txt", "switch-confirm/cc2.1.280-change-effort.txt"]) {
      expect([f, isAutoConfirmableModal(fx(f))]).toEqual([f, true]);
    }
  });
  test("同一个选择框下方露出真输入框（弹窗已关、选项只是屏上残留）→ 不按", () => {
    const pane = `${fx("switch-confirm/cc2.1.280-switch-model.txt").replace(/\s+$/, "")}\n\n${"─".repeat(80)}\n❯ \n${"─".repeat(80)}\n  ⏵⏵ bypass permissions on (shift+tab to cycle)`;
    expect(isAutoConfirmableModal(pane)).toBe(false);
  });
});

describe("目录信任框：通用自动确认一个键都不按，只由 lib/trust-prompt.ts 的严格识别处理（T44 r2 P1-1 / P1-2）", () => {
  const trust = fx("trust/cc2.1.284-trust.txt");
  const yesLit = trust.replace(" ❯ No, exit", "   No, exit").replace("   Yes, I trust", " ❯ Yes, I trust");
  const effort = " Use Fable 5.1 at high effort by default?\n   ❯ Keep xhigh\n     Switch Fable 5.1 to high effort\n\n   Enter to confirm · Esc to cancel";
  test("带编号 / 编号换写法 / Yes 在前 / 文案改过的信任框（默认高亮 No，Enter = 退出）", () => {
    const variants = [
      trust.replace(" ❯ No, exit", " ❯ 1. No, exit").replace("   Yes, I trust", "   2. Yes, I trust"),
      trust.replace(" ❯ No, exit", " ❯ 1) No, exit").replace("   Yes, I trust", "   2) Yes, I trust"),
      trust.replace(" ❯ No, exit\n   Yes, I trust this folder", " ❯ 1. Yes, I trust this folder\n   2. No, exit"),
      trust.replace(" ❯ No, exit", " ❯ 1. No, exit").replace("   Yes, I trust this folder", "   2. Yes, I trust this workspace"),
      trust.replace(" Security guide", " WARNING: Please review this project"),
      trust,
    ];
    for (const [i, pane] of variants.entries()) expect([i, ...both(pane)]).toEqual([i, false, false]);
  });
  test("旧信任框残影 + 下面新弹出的 effort 框：残影不算当前画面，effort 框照常按；残影下接 shell 不按", () => {
    expect(isAutoConfirmableModal(`${yesLit.trimEnd()}\n${effort}`)).toBe(true);
    expect(both(`${yesLit.trimEnd()}\nuser@host repo %`)).toEqual([false, false]);
  });
  test("effort 框残影 + 当前带编号的信任框：不按", () => {
    const numbered = trust.replace(" ❯ No, exit", " ❯ 1. No, exit").replace("   Yes, I trust", "   2. Yes, I trust");
    expect(both(`${effort}\n${numbered}`)).toEqual([false, false]);
  });
});
