/**
 * 目录信任弹窗：只在活框上、确认 ❯ 已在 Yes 时才按 Enter；半帧 / 退到 shell 的残留一个 Enter 都不按。
 * 画面取自 2026-10-02 出借 Claude worker 生产抓屏（CC 2.1.287，窗口 245x53；启动命令行截短）。
 */
import { describe, expect, test } from "bun:test";
import { isAutoConfirmableModal } from "../src/lib/modal-confirm.ts";
import { claudeCodeAdapter } from "../src/lib/runtimes/index.ts";
import type { WindowOps } from "../src/lib/runtimes/types.ts";
import { guardedScreenOf } from "../src/lib/send-key-guard.ts";
import { acceptTrustPrompt, looksLikeTrustPrompt, trustPromptMoves } from "../src/lib/trust-prompt.ts";

const HEAD = [
  "",
  "(base) ➜  lend_i28-X6_s1_r1_a18-9f234271b99c env -i PATH=/usr/bin:/bin HOME=/Users/x bun lend-claude-worker-host.ts …",
  "",
  "─".repeat(120),
  " Accessing workspace:",
  "",
  " /Users/x/.claude-orchestrator/lend/work/lend_i28-X6_s1_r1_a18-9f234271b99c",
  "",
  " Quick safety check: Is this a project you created or one you trust? (Like your own code, a well-known open source project, or work from your t",
  "",
  " Claude Code'll be able to read, edit, and execute files here.",
  "",
  " Security guide",
  "",
];
const NO = [" ❯ No, exit", "   Yes, I trust this folder"];
const YES = ["   No, exit", " ❯ Yes, I trust this folder"];
const FOOT = ["", " Enter to confirm · Esc to cancel"];
const BLANK = Array(20).fill("");
const PROMPT = "(base) ➜  lend_i28-X6_s1_r1_a18-9f234271b99c git:(119e361be) ";
const frame = (...parts: string[][]) => parts.flat().join("\n");

const LIVE_NO = frame(HEAD, NO, FOOT, BLANK);
const LIVE_YES = frame(HEAD, YES, FOOT, BLANK);
/** 选了 No 退出后：框留在上方，下面接 n 行 shell 提示符（生产上 n 从 1 涨到 22） */
const residue = (n: number) => frame(HEAD, NO, FOOT, Array(n).fill(PROMPT), BLANK);
const CC_READY = "some output\n\n❯ \n──────\n  ⏵⏵ bypass permissions on (shift+tab to cycle)";

describe("trustPromptMoves：只认活框", () => {
  test("活框默认高亮 No → 1；已高亮 Yes → 0；编号变体同样认", () => {
    expect(trustPromptMoves(LIVE_NO)).toBe(1);
    expect(trustPromptMoves(LIVE_YES)).toBe(0);
    expect(trustPromptMoves(frame(HEAD, [" ❯ 1. No, exit", "   2. Yes, I trust this folder"], FOOT))).toBe(1);
  });

  test("退到 shell 后的残留（生产 1~21 行提示符）→ null，通用自动确认也不按", () => {
    for (let n = 1; n <= 21; n++) {
      expect(trustPromptMoves(residue(n))).toBeNull();
      expect(isAutoConfirmableModal(residue(n))).toBe(false);
      expect(isAutoConfirmableModal(residue(n), { allowSessionIdle: true })).toBe(false);
    }
  });

  test("半帧（Yes 行或尾注还没画出来）→ null，且绝不走通用 Enter", () => {
    const halves = [
      frame(HEAD, [" ❯ No, exit"], FOOT), // 尾注已在、Yes 行没画
      frame(HEAD, NO), // 尾注没画
      frame(HEAD, [" ❯ No, exit"]),
      frame([" ❯ No, exit", "   Yes"], FOOT), // 标题已滚走、Yes 行半截
    ];
    for (const p of halves) {
      expect(trustPromptMoves(p)).toBeNull();
      expect(isAutoConfirmableModal(p)).toBe(false);
    }
  });

  test("高亮项是 exit 的任何选择框都不代按；send-key 闸把半帧也当信任框", () => {
    expect(isAutoConfirmableModal("\nSomething new?\n\n❯ No, exit\n  Yes, go on\n\nEnter to confirm · Esc to cancel\n")).toBe(false);
    expect(looksLikeTrustPrompt(frame(HEAD, [" ❯ No, exit"]))).toBe(true);
    expect(guardedScreenOf(frame(HEAD, [" ❯ No, exit"]), undefined)).toBe("trust_prompt");
  });
});

describe("acceptTrustPrompt：一次一步", () => {
  test("没在 Yes 上只发方向键，在 Yes 上才 Enter", async () => {
    const keys: string[] = [];
    const send = async (k: string) => void keys.push(k);
    await acceptTrustPrompt(send, 1);
    expect(keys).toEqual(["Down"]);
    await acceptTrustPrompt(send, -1);
    await acceptTrustPrompt(send, 0);
    expect(keys).toEqual(["Down", "Up", "Enter"]);
  });
});

function fakeWindow(panes: string[]) {
  const keys: string[] = [];
  let i = 0;
  const win = {
    name: "agent-lend-x",
    target: "master:agent-lend-x",
    capture: async () => panes[Math.min(i++, panes.length - 1)]!,
    sendKey: async (k: string) => void keys.push(k),
    sleep: async () => {},
  } as unknown as WindowOps;
  return { win, keys };
}

describe("Claude Code waitReady 上的信任框", () => {
  test("Down 被吞（画面还在 No）→ 不按 Enter、再挪一次；确认在 Yes 上才 Enter", async () => {
    const { win, keys } = fakeWindow([LIVE_NO, LIVE_NO, LIVE_YES, CC_READY]);
    expect(await claudeCodeAdapter.waitReady(win, { rounds: 10, pollMs: 0 })).toEqual({ ready: true, recoveredFullSession: false });
    expect(keys).toEqual(["Down", "Down", "Enter"]);
  });

  test("CC 已退到 shell（框留在上方）→ 一个键都不发，等到超时", async () => {
    const { win, keys } = fakeWindow([residue(1), residue(1), residue(1)]);
    const r = await claudeCodeAdapter.waitReady(win, { rounds: 5, pollMs: 0 });
    expect(r.ready === false && r.reason).toBe("timeout");
    expect(keys).toEqual([]);
  });
});
