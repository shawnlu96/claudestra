import { describe, expect, test } from "bun:test";
import { isAutoConfirmableModal } from "../src/lib/modal-confirm.js";
import { claudeCodeAdapter } from "../src/lib/runtimes/index.js";
import type { WindowOps } from "../src/lib/runtimes/types.js";
import { acceptTrustPrompt, isAtShell, trustPromptMoves as legacyMoves } from "../src/lib/tmux-helper.js";
import { hasTrustPromptMarker, trustPromptMoves, trustPromptPending } from "../src/lib/trust-prompt.js";

const plain = `Quick safety check: Is this a project you created or one you trust?
❯ No, exit
  Yes, I trust this folder
Enter to confirm · Esc to cancel`;
const numbered = plain.replace("❯ No", "❯ 1. No").replace("  Yes", "  2. Yes");
const partial = "Quick safety check: Do you trust this folder?\n❯ No, exit";
const exited = `${numbered}\nuser@host ~/repo %`;
const ready = "❯ \n──────\n  ⏵⏵ bypass permissions on (shift+tab to cycle)";

function fakeWindow(panes: string[]) {
  const keys: string[] = [];
  const captures: string[][] = [];
  const sleeps: number[] = [];
  let i = 0;
  const win: WindowOps = {
    name: "trust-test",
    target: "unused-test-target",
    capture: async () => {
      captures.push([...keys]);
      return panes[Math.min(i++, panes.length - 1)] ?? "";
    },
    sendKey: async (key) => { keys.push(key); },
    sleep: async (ms) => { sleeps.push(ms); },
    sendLine: async () => { throw new Error("unexpected sendLine"); },
    sendLiteral: async () => { throw new Error("unexpected sendLiteral"); },
    sendEscape: async () => { throw new Error("unexpected Escape"); },
    getOption: async () => null,
    setOption: async () => true,
    childPids: async () => [],
  };
  return { win, keys, captures, sleeps };
}

describe("trust dialog fixtures and modal safeguards", () => {
  test("a: original dialog and compatibility re-export", () => {
    expect(trustPromptMoves(plain)).toBe(1);
    expect(legacyMoves(plain)).toBe(1);
    expect(trustPromptPending(plain)).toBe(false);
    expect(isAutoConfirmableModal(plain)).toBe(false);
  });

  test("b: numbered dialog navigates to Yes without depending on a footer", () => {
    expect(trustPromptMoves(numbered)).toBe(1);
    expect(trustPromptMoves(numbered.split("\n").slice(0, -1).join("\n"))).toBe(1);
    expect(isAutoConfirmableModal(numbered)).toBe(false);
  });

  test("c: missing Yes or missing highlight stays pending", () => {
    for (const pane of [partial, "Quick safety check", plain.replace("❯ No", "  No")]) {
      expect(trustPromptMoves(pane)).toBeNull();
      expect(trustPromptPending(pane)).toBe(true);
      expect(isAutoConfirmableModal(pane)).toBe(false);
    }
  });

  test("d: shell below residual trust text is exited, never a live dialog", () => {
    expect(isAtShell(exited)).toBe(true);
    expect(isAutoConfirmableModal(exited)).toBe(false);
    const ordinary = "❯ 1. Continue\n  2. Help\nuser@host %";
    expect(isAutoConfirmableModal(ordinary)).toBe(false);
  });

  test("e: arbitrary numbered exit choices cannot receive automatic Enter", () => {
    for (const label of ["No, exit", "No", "Exit", "Cancel", "Exit now"]) {
      expect(isAutoConfirmableModal(`Pick one\n❯ 1. ${label}\n  2. Continue\nEnter to confirm`)).toBe(false);
    }
  });

  test("f: effort and dev-channel confirmations remain automatic", () => {
    const effort = `Use Fable 5.1 at high effort by default?
   high is the default effort for Fable 5.1 and is recommended for most
   coding tasks; xhigh spends more tokens per task. You can change this any
   time with /effort.
   xhigh effort is ~1.4x the estimated cost of high (the default).
   ❯ Keep xhigh
     Switch Fable 5.1 to high effort

   Enter to confirm · Esc to cancel`;
    const devChannel = "Warning: dev channels\n❯ 1. Continue\n  2. Cancel\nEnter to confirm · Esc to cancel";
    expect(isAutoConfirmableModal(effort)).toBe(true);
    expect(isAutoConfirmableModal(devChannel)).toBe(true);
  });

  test("all title variants and Yes variants work; Yes may already be selected or above No", () => {
    for (const title of ["trust this folder", "Quick safety check", "Do you trust the files"]) {
      const pane = `${title}\n❯ 1. No, exit\n  2. Yes, proceed\n\n\n`;
      expect(hasTrustPromptMarker(pane)).toBe(true);
      expect(trustPromptMoves(pane)).toBe(1);
      expect(isAutoConfirmableModal(pane)).toBe(false);
    }
    expect(trustPromptMoves("Quick safety check\n  Yes, proceed\n❯ No, exit")).toBe(-1);
    expect(trustPromptMoves("Quick safety check\n  No, exit\n❯ Yes, proceed")).toBe(0);
    expect(hasTrustPromptMarker("trust this folder\n" + "output\n".repeat(25))).toBe(false);
  });
});

describe("trust readiness and exit sequences through WindowOps", () => {
  const budget = { rounds: 4, pollMs: 10 };

  test("b: numbered dialog sends Down + Enter exactly once, then becomes ready", async () => {
    const { win, keys, captures } = fakeWindow([numbered, ready]);
    expect(await claudeCodeAdapter.waitReady(win, budget)).toEqual({ ready: true, recoveredFullSession: false });
    expect(keys).toEqual(["Down", "Enter"]);
    expect(captures).toEqual([[], ["Down", "Enter"]]);
  });

  test("c: partial frames send nothing, complete dialog gets Yes then becomes ready", async () => {
    const { win, keys, captures, sleeps } = fakeWindow([partial, partial, numbered, ready]);
    expect(await claudeCodeAdapter.waitReady(win, budget)).toEqual({ ready: true, recoveredFullSession: false });
    expect(keys).toEqual(["Down", "Enter"]);
    expect(captures).toEqual([[], [], [], ["Down", "Enter"]]);
    expect(sleeps.filter((ms) => ms === budget.pollMs)).toHaveLength(4);
  });

  test("d: residual dialog above shell exits immediately without any keys", async () => {
    const { win, keys, captures } = fakeWindow([exited, numbered]);
    expect(await claudeCodeAdapter.waitReady(win, budget)).toEqual({ ready: false, reason: "exited", recoveredFullSession: false });
    expect(keys).toEqual([]);
    expect(captures).toHaveLength(1);
  });

  test("final capture also reports exited", async () => {
    const { win, keys } = fakeWindow(["Loading…", exited]);
    expect(await claudeCodeAdapter.waitReady(win, { rounds: 1, pollMs: 0 })).toEqual({
      ready: false, reason: "exited", recoveredFullSession: false,
    });
    expect(keys).toEqual([]);
  });

  test("onExitPane waits on partial frames and leaves residual shell untouched", async () => {
    const { win, keys, sleeps } = fakeWindow([]);
    expect(await claudeCodeAdapter.onExitPane!(partial, win)).toBe("handled");
    expect(keys).toEqual([]);
    expect(sleeps).toEqual([1000]);
    expect(await claudeCodeAdapter.onExitPane!(exited, win)).toBe("none");
    expect(keys).toEqual([]);
    expect(await claudeCodeAdapter.onExitPane!(numbered, win)).toBe("handled");
    expect(keys).toEqual(["Down", "Enter"]);
  });

  test("navigation preserves Up and already-selected Yes behavior", async () => {
    const { win, keys } = fakeWindow([]);
    await acceptTrustPrompt(win.target, -1, win);
    await acceptTrustPrompt(win.target, 0, win);
    expect(keys).toEqual(["Up", "Enter", "Enter"]);
  });
});
