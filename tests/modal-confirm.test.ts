/**
 * launcher 自动确认不按在草稿上（T41a）：lib/modal-confirm.ts isAutoConfirmableModal 先按框形状认输入框，真输入框在 = 没有弹窗。
 * 全部用真实 capture-pane 样本（tests/fixtures/）；合成的启动期弹窗见 tests/modal-parser.test.ts。
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { isAutoConfirmableModal } from "../src/lib/modal-confirm.js";
import { detectDevChannelsModal } from "../src/lib/tmux-helper.js";
import { claudeCodeAdapter } from "../src/lib/runtimes/index.js";
import type { WindowOps } from "../src/lib/runtimes/types.js";

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

// CC 把启动确认框画在屏幕顶部，capture-pane 原样输出下面整片空行（49 行高的 pane 只有前几行有字）：判定先剪掉尾部空行再看末尾
describe("框在顶部 + 35 行尾部空行", () => {
  const blankTail = (pane: string) => [...pane.replace(/\s+$/, "").split("\n"), ...Array(35).fill("")].map((l) => `${l}\n`).join("");
  const devChannels = ["WARNING: Loading development channels", "", "--dangerously-load-development-channels is for local channel development only.", "",
    "Channels: server:claudestra", "", "❯ 1. I am using this for local development", "  2. Exit", "", "Enter to confirm · Esc to cancel"].join("\n");
  test("dev-channels 确认框 → 照常自动按", () => {
    expect(isAutoConfirmableModal(blankTail(devChannels))).toBe(true);
  });
  test("尾部空行上面是普通输出、不是弹窗（没有 ❯ 高亮的编号列表、输入框里的编号草稿）→ 不按", () => {
    const plain = "⏺ 步骤：\n  1. First do X\n  2. Then do Y\nEnter to confirm something? (just text)";
    for (const pane of [plain, fx("turn-zone/cc-numlist-draft.txt"), fx("turn-zone/cc-draft-num.txt")]) expect(both(blankTail(pane))).toEqual([false, false]);
  });
  test("要人决定的框画在顶部也照样认得出、不按：session-idle（Enter = 从摘要恢复）、权限框、AskUserQuestion", () => {
    const idle = "This session is 21h 6m old and 913.2k tokens.\n\n❯ 1. Resume from summary\n  2. Resuming the full session\n\nEnter to confirm · Esc to cancel";
    expect(both(blankTail(idle))).toEqual([false, true]); // master 启动时允许：它另走 Down + Enter 选「完整恢复」
    for (const f of ["turn-zone/modal-permission.txt", "turn-zone/modal-auq.txt"]) expect([f, ...both(blankTail(fx(f)))]).toEqual([f, false, false]);
  });
});

// 剪掉尾部空行后，scrollback 里退回 shell 前留下的旧框也进了「末尾 N 行」窗口：框后面还有别的内容 = 残留，两个自动 Enter 都不能按
describe("旧框残留在上方、框后面已经是 shell 或别的内容（PR310-R1-001）", () => {
  const box = ["WARNING: Loading development channels", "", "--dangerously-load-development-channels is for local channel development only.", "",
    "Channels: server:claudestra", "", "❯ 1. I am using this for local development", "  2. Exit", "", "Enter to confirm · Esc to cancel"];
  const pane = (after: string[], blanks = 50) => [...box, ...after, ...Array(blanks).fill("")].join("\n");
  const shell1 = ["user@host ~/demo %"];
  const shell6 = ["", "user@host ~/demo % ls", "a.txt  b.txt", "user@host ~/demo % pwd", "/Users/user/demo", "user@host ~/demo %"];
  const onExit = async (p: string) => {
    const keys: string[] = [];
    const win = { sendKey: async (k: string) => void keys.push(k), sleep: async () => {} } as unknown as WindowOps;
    return [await claudeCodeAdapter.onExitPane!(p, win), ...keys];
  };
  test("活框在顶部 + 50 行尾部空行：permission-watcher 兜底、通用自动确认、退出收尾都照常按", async () => {
    expect([detectDevChannelsModal(pane([])), ...both(pane([]))]).toEqual([true, true, true]);
    expect(await onExit(pane([]))).toEqual(["handled", "Enter"]);
  });
  test("框后面接 1 行 / 6 行 shell 提示符 → 都不按", async () => {
    for (const after of [shell1, shell6]) {
      expect([after.length, detectDevChannelsModal(pane(after)), ...both(pane(after))]).toEqual([after.length, false, false, false]);
      expect(await onExit(pane(after))).toEqual(["none"]);
    }
  });
  test("窄窗口里尾注折成两行（最后一行只剩「cancel」）：活框照常按，后面接了 shell 照样不按", () => {
    const narrow = [...box.slice(0, -1), "Enter to confirm · Esc to", "cancel"];
    const live = [...narrow, ...Array(50).fill("")].join("\n");
    const stale = [...narrow, ...shell1, ...Array(50).fill("")].join("\n");
    expect([detectDevChannelsModal(live), ...both(live)]).toEqual([true, true, true]);
    expect([detectDevChannelsModal(stale), ...both(stale)]).toEqual([false, false, false]);
  });
  test("框后面是别的输出（不是 shell 提示符）→ 也不按；不带尾部空行时同理", () => {
    for (const p of [pane(["⏺ 继续干活中"]), pane(shell1, 0), pane(["Goodbye?"], 0)]) expect([detectDevChannelsModal(p), ...both(p)]).toEqual([false, false, false]);
  });
});
