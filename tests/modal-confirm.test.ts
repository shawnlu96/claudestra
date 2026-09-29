/**
 * launcher 自动确认不按在草稿上（T41a）：lib/modal-confirm.ts isAutoConfirmableModal 先按框形状认输入框，真输入框在 = 没有弹窗。
 * 全部用真实 capture-pane 样本（tests/fixtures/）；合成的启动期弹窗见 tests/modal-parser.test.ts。
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { isAutoConfirmableModal, looksLikeSwitchConfirm } from "../src/lib/modal-confirm.js";

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

describe("切模型 / effort 确认框：launcher、就绪轮询一律不按（T41a r4 P1-1）", () => {
  test("CC 2.1.280 实抓的确认框：整屏、launcher 抓的最后 10 行都不按", () => {
    for (const f of ["switch-confirm/cc2.1.280-switch-model.txt", "switch-confirm/cc2.1.280-change-effort.txt"]) {
      const pane = fx(f);
      const last10 = pane.replace(/\s+$/, "").split("\n").slice(-10).join("\n");
      expect([f, ...both(pane), ...both(last10)]).toEqual([f, false, false, false, false]);
      expect(looksLikeSwitchConfirm(last10)).toBe(true);
    }
  });
  test("CC 改了排版（选项多一项、标题换行）严格识别认不出，宽松排除仍拦住", () => {
    const pane = fx("switch-confirm/cc2.1.280-switch-model.txt").replace("     2. No, go back", "     2. No, go back\n     3. Always switch");
    expect(looksLikeSwitchConfirm(pane)).toBe(true);
    expect(both(pane)).toEqual([false, false]);
  });
  test("同一个选择框下方露出真输入框（弹窗已关、选项只是屏上残留）→ 不按", () => {
    const pane = `${fx("switch-confirm/cc2.1.280-switch-model.txt").replace(/\s+$/, "")}\n\n${"─".repeat(80)}\n❯ \n${"─".repeat(80)}\n  ⏵⏵ bypass permissions on (shift+tab to cycle)`;
    expect(isAutoConfirmableModal(pane)).toBe(false);
  });
});

describe("盖住输入框的普通确认框：照常自动按", () => {
  test("编号确认框（不是切换框）仍自动 Enter", () => {
    const pane = fx("switch-confirm/cc2.1.280-switch-model.txt")
      .replace("Switch model?", "Enable the new status line?")
      .replace("Yes, switch to Sonnet 5", "Yes, enable it")
      .replace(/This conversation is cached.*\n/, "\n");
    expect(looksLikeSwitchConfirm(pane)).toBe(false);
    expect(isAutoConfirmableModal(pane)).toBe(true);
  });
});
