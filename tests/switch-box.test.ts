/**
 * 切换确认框的宽口径识别（lib/switch-box.ts）与 tmuxSendLine 的发键闸（lib/codex-key-guard.ts assertKeysAllowed）。
 * T41c r3 P1-1：斜杠直通 / cron / Discord 斜杠都经 tmuxSendLine，框在屏上时打字、回车一个都不发（回车 = 替框选 Yes）。
 * 真实 CC 2.1.280 原屏。
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { assertKeysAllowed, KeysBlockedError } from "../src/lib/codex-key-guard.ts";
import { SWITCH_BOX_REFUSAL, switchBoxShown } from "../src/lib/switch-box.ts";
import { detectSwitchConfirmPrompt } from "../src/lib/tmux-helper.ts";

const fx = (f: string): string => readFileSync(join(import.meta.dir, "fixtures", f), "utf8");
const BOXES = ["switch-confirm/cc2.1.280-switch-model.txt", "switch-confirm/cc2.1.280-change-effort.txt"].map(fx);
const PLAIN = ["switch-confirm/cc2.1.280-model-set.txt", "turn-zone/busy-queued.txt", "turn-zone/cc-draft-num.txt", "turn-zone/modal-permission.txt"].map(fx);
const last30 = (p: string) => p.replace(/\s+$/, "").split("\n").slice(-30).join("\n");

describe("switchBoxShown", () => {
  test("切模型 / effort 框：整屏、tmuxSendLine 抓的最后 30 行都认；严格识别认得出的它一定认", () => {
    for (const b of BOXES) {
      expect(detectSwitchConfirmPrompt(b)).not.toBeNull();
      expect([switchBoxShown(b), switchBoxShown(last30(b))]).toEqual([true, true]);
    }
  });

  test("普通画面、忙着、草稿、权限框 → 不是", () => {
    for (const p of PLAIN) expect(switchBoxShown(p)).toBe(false);
  });

  test("对话里提到框标题、但真输入框还在 → 不是（不挡给在聊这个功能的 agent 发命令）", () => {
    const idle = PLAIN[0]!;
    const set = "  ⎿  Set model to Sonnet 5 and saved as your default for new sessions\n";
    const quoted = idle.replace(set, `${set}\nSwitch model?\n  1. Yes, switch to Sonnet 5\n`);
    expect(quoted).not.toBe(idle);
    const noInput = quoted.split("\n").filter((l) => !/^(─+|❯)$/.test(l.trim())).join("\n");
    expect(switchBoxShown(noInput)).toBe(true); // 拿掉输入框：同样的字就算框
    expect(switchBoxShown(quoted)).toBe(false);
  });
});

describe("assertKeysAllowed（tmuxSendLine 打字前、回车前）", () => {
  test("任何窗口停在切换框上 → 抛 KeysBlockedError（调用方据 name 映射成 409 / cron 失败），带切换框的原因", async () => {
    for (const b of BOXES) {
      const e = await assertKeysAllowed("master:=agent-x", async () => b).catch((x) => x);
      expect(e).toBeInstanceOf(KeysBlockedError);
      expect([e.name, e.message.startsWith(SWITCH_BOX_REFUSAL)]).toEqual(["KeysBlockedError", true]);
    }
    await expect(assertKeysAllowed("master:0", async () => BOXES[0]!)).rejects.toBeInstanceOf(KeysBlockedError);
  });

  test("普通画面照发；抓不到屏按不拦", async () => {
    for (const p of PLAIN) await assertKeysAllowed("master:=agent-x", async () => p);
    await assertKeysAllowed("master:=agent-x", async () => { throw new Error("tmux down"); });
  });
});
