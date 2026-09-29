/**
 * manager tmux-send-keys 的画面闸 + --force 审计（T41a）：lib/send-key-guard.ts、manager/send-keys.ts。
 * 画面全是真实 capture-pane 样本；发键、抓屏、审计都注入，测试不碰 tmux。
 */
import { describe, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  appendSendKeysAudit, authorizedSendKeysArgs, guardedScreenOf, screenFingerprint, seenScreenOf, sendKeysCaller, type SendKeysAudit,
} from "../src/lib/send-key-guard.js";
import { parseSendKeysArgs, sendKeysChecked, type SendKeysDeps } from "../src/manager/send-keys.js";
import { forgetSwitchPrompt, handleSwmodelButton, switchPromptButtons } from "../src/bridge/swmodel-button.js";

const fx = (f: string): string => readFileSync(join(import.meta.dir, "fixtures", f), "utf8").replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "");

const GUARDED: Record<string, string> = {
  "quota-wall/menu-no-lp.txt": "limit_menu",
  "quota-wall/menu-on-credits.txt": "limit_menu",
  "quota-wall/menu-narrow34-credits-first.txt": "limit_menu",
  "quota-wall/walled.txt": "wall_countdown",
  "quota-wall/walled-typing.txt": "wall_countdown",
  "quota-wall/walled-weekly-80col.txt": "wall_countdown",
  "quota-wall/lp-off-offer.txt": "wall_countdown",
  "turn-zone/modal-permission.txt": "permission",
  "turn-zone/cc-perm-quoted.txt": "permission",
  "turn-zone/modal-auq.txt": "ask_user_question",
  "turn-zone/cc-auq-opt4.txt": "ask_user_question",
  "cc-bypass-consent-pane.txt": "bypass_consent",
};
const PLAIN = ["turn-zone/cc-numlist-draft.txt", "turn-zone/busy-queued.txt", "turn-zone/cc-draft-num.txt", "quota-wall/lp-on-autocontinue.txt",
  "switch-confirm/cc2.1.280-switch-model.txt", "lp/input-draft-multiline.ansi"];

describe("guardedScreenOf", () => {
  test("额度菜单 / 撞墙倒计时（含 80 列截断）/ 权限框 / AUQ / Bypass 首启框 → 命中", () => {
    for (const [f, kind] of Object.entries(GUARDED)) expect([f, guardedScreenOf(fx(f), undefined)]).toEqual([f, kind]);
  });
  test("草稿、回合中、LP 在跑、切模型确认框（管理按钮要能按）→ 不拦", () => {
    for (const f of PLAIN) expect([f, guardedScreenOf(fx(f), undefined)]).toEqual([f, null]);
  });
  test("seenScreenOf：切模型 / effort 确认框单独认出来（按钮授权要认准它）；空屏 = unreadable；草稿 = 普通画面", () => {
    for (const f of ["cc2.1.280-switch-model.txt", "cc2.1.280-change-effort.txt"]) expect([f, seenScreenOf(fx(`switch-confirm/${f}`), undefined)]).toEqual([f, "switch_confirm"]);
    expect([seenScreenOf("", undefined), seenScreenOf(" \n\n  \n", undefined)]).toEqual(["unreadable", "unreadable"]);
    expect(seenScreenOf(fx("turn-zone/cc-numlist-draft.txt"), undefined)).toBeNull();
    expect(seenScreenOf(fx("quota-wall/menu-on-credits.txt"), undefined)).toBe("limit_menu");
  });
});

const PROG = { force: false, authorizedBy: null, expect: null, box: null };
const FORCE = { force: true, authorizedBy: null, expect: null, box: null };
const MODEL_BOX = fx("switch-confirm/cc2.1.280-switch-model.txt");
const EFFORT_BOX = fx("switch-confirm/cc2.1.280-change-effort.txt");
const SWMODEL = { force: false, authorizedBy: "button:swmodel_yes:agent-x", expect: "switch_confirm" as const, box: screenFingerprint(MODEL_BOX, "switch_confirm") };

/** screens：依次抓到的画面；Error = 这一次抓屏失败。sendKey 照真实实现的约定：先过 gate，过了才算发出 */
function harness(screens: (string | Error)[]) {
  const sent: string[] = [];
  const audits: SendKeysAudit[] = [];
  let i = 0;
  const deps: SendKeysDeps = {
    capture: async () => {
      const s = screens[Math.min(i++, screens.length - 1)]!;
      if (s instanceof Error) throw s;
      return s;
    },
    runtimeOf: () => undefined,
    sendKey: async (_t, k, gate) => {
      await gate();
      sent.push(k);
    },
    audit: (e) => void audits.push(e),
    caller: () => "agent-pm",
    now: () => new Date("2026-09-30T00:00:00Z"),
  };
  return { deps, sent, audits };
}

describe("sendKeysChecked", () => {
  test("额度菜单、倒计时、权限框、AUQ × 数字 / Enter / Esc / 打字：一个键都不发，报命中的画面，不记审计", async () => {
    let n = 0;
    for (const f of ["quota-wall/menu-on-credits.txt", "quota-wall/walled-weekly-80col.txt", "turn-zone/modal-permission.txt", "turn-zone/modal-auq.txt"]) {
      for (const keys of [["1"], ["Enter"], ["Escape"], ["C-c"], ["/low-priority", "Enter"]]) {
        const h = harness([fx(f)]);
        const r = await sendKeysChecked("agent-x", keys, PROG, h.deps);
        expect([f, keys, r.ok, r.ok ? null : r.screen, h.sent, h.audits]).toEqual([f, keys, false, GUARDED[f] as never, [], []]);
        if (!r.ok) expect(r.error).toContain("--force");
        n++;
      }
    }
    expect(n).toBe(20);
  });

  test("--force：先写一行审计（谁、窗口、键、命中的画面），再照发", async () => {
    const h = harness([fx("quota-wall/walled.txt")]);
    const r = await sendKeysChecked("agent-x", ["/low-priority", "Enter", "Escape", "C-u"], FORCE, h.deps);
    expect(r).toEqual({ ok: true, keys: ["/low-priority", "Enter", "Escape", "C-u"], forced: true, screen: "wall_countdown" });
    expect(h.sent).toEqual(["/low-priority", "Enter", "Escape", "C-u"]);
    expect(h.audits).toEqual([{ at: "2026-09-30T00:00:00.000Z", caller: "agent-pm", ppid: process.ppid, window: "agent-x", keys: h.sent, screen: "wall_countdown", authorizedBy: null }]);
  });

  test("--force 时审计写不进去：一个键都不发", async () => {
    const h = harness([fx("quota-wall/menu-no-lp.txt")]);
    h.deps.audit = () => { throw new Error("EACCES"); };
    await expect(sendKeysChecked("agent-x", ["1"], FORCE, h.deps)).rejects.toThrow("EACCES");
    expect(h.sent).toEqual([]);
  });

  test("普通画面照发；前一个键弹出了权限框，后面的键停下（每个键前都重抓）", async () => {
    const ok = harness([fx("turn-zone/cc-draft-num.txt")]);
    expect((await sendKeysChecked("agent-x", ["C-u", "hi", "Enter"], PROG, ok.deps)).ok).toBe(true);
    expect([ok.sent, ok.audits]).toEqual([["C-u", "hi", "Enter"], []]);
    const h = harness([fx("turn-zone/cc-draft-num.txt"), fx("turn-zone/modal-permission.txt")]);
    const r = await sendKeysChecked("agent-x", ["Enter", "1"], PROG, h.deps);
    expect([r.ok, h.sent]).toEqual([false, ["Enter"]]);
    if (!r.ok) expect(r.sent).toEqual(["Enter"]);
  });

  test("抓屏失败 / 超时 / 空屏：一个键都不发，报 unreadable 和抓屏的报错；--force 照发，审计记 unreadable", async () => {
    for (const s of [new Error("tmux capture-pane 超时"), "", "  \n \n"]) {
      for (const opts of [PROG, SWMODEL]) {
        const h = harness([s]);
        const r = await sendKeysChecked("agent-x", ["Enter"], opts, h.deps);
        expect([r.ok, r.ok ? null : r.screen, h.sent, h.audits]).toEqual([false, "unreadable", [], []]);
        if (!r.ok && s instanceof Error) expect(r.error).toContain("超时");
      }
    }
    const f = harness([new Error("no such window")]);
    const r = await sendKeysChecked("agent-x", ["Escape"], FORCE, f.deps);
    expect([r.ok, f.sent, f.audits.map((a) => a.screen)]).toEqual([true, ["Escape"], ["unreadable"]]);
  });

  test("抓屏只发生在 sendKey 给的 gate 里（真实 sendKey 在拿锁、等完节流之后才调 gate，见 tests/esc-guard.test.ts）", async () => {
    let inGate = false;
    const outside: string[] = [];
    const h = harness([fx("turn-zone/cc-draft-num.txt")]);
    const cap = h.deps.capture;
    h.deps.capture = async (t) => (inGate || outside.push(t), cap(t));
    h.deps.sendKey = async (_t, k, gate) => {
      inGate = true;
      await gate();
      inGate = false;
      h.sent.push(k);
    };
    for (const opts of [PROG, FORCE, SWMODEL]) await sendKeysChecked("agent-x", ["C-u", "hi", "Enter"], opts, h.deps);
    expect(outside).toEqual([]);
  });

  test("管理按钮代决切模型（swmodel_yes / no 发 Enter / Escape）不受影响", async () => {
    for (const k of ["Enter", "Escape"]) {
      const h = harness([fx("switch-confirm/cc2.1.280-switch-model.txt")]);
      expect((await sendKeysChecked("agent-x", [k], PROG, h.deps)).ok).toBe(true);
      expect(h.sent).toEqual([k]);
    }
  });
});

describe("owner 点过才发键的路径（--authorized）", () => {
  test("argv 形状：authorizedSendKeysArgs 拼的，manager 解析回来是同一组选项和键", () => {
    const argv = authorizedSendKeysArgs("agent-x", "button:swmodel_yes:agent-x", "switch_confirm", SWMODEL.box, ["Enter"]);
    expect(argv.slice(0, 2)).toEqual(["tmux-send-keys", "agent-x"]);
    expect(parseSendKeysArgs(argv.slice(2))).toEqual({ ...SWMODEL, keys: ["Enter"] });
    expect(parseSendKeysArgs(["--force", "1"])).toEqual({ ...FORCE, keys: ["1"] });
  });

  test("选项只认键之前的；--authorized / --expect / --box 三个一起给；--expect 只认已知画面；授权发只发一个键", () => {
    expect(parseSendKeysArgs(["1", "--force", "Enter"])).toEqual({ ...PROG, keys: ["1", "--force", "Enter"] });
    const auth = ["--authorized", "b", "--expect", "limit_menu", "--box", "abcdef012345"];
    expect(parseSendKeysArgs([...auth, "2"])).toEqual({ force: false, authorizedBy: "b", expect: "limit_menu", box: "abcdef012345", keys: ["2"] });
    for (const bad of [["--authorized", "button:x", "Enter"], ["--expect", "limit_menu", "1"], ["--authorized", "b", "--expect", "limit_menu", "1"],
      ["--authorized", "b", "--expect", "input_box", "--box", "x", "1"], ["--force"], ["--authorized"], [...auth, "Down", "Enter"]]) {
      expect([bad, "error" in parseSendKeysArgs(bad)]).toEqual([bad, true]);
    }
  });

  test("授权发：切模型框上照发，审计记上是哪个按钮授权的", async () => {
    const h = harness([MODEL_BOX]);
    const r = await sendKeysChecked("agent-x", ["Enter"], SWMODEL, h.deps);
    expect([r.ok, h.sent]).toEqual([true, ["Enter"]]);
    expect(h.audits.map((a) => [a.authorizedBy, a.screen, a.keys])).toEqual([["button:swmodel_yes:agent-x", "switch_confirm", ["Enter"]]]);
  });

  test("按钮点得晚、框已经关了回到输入框（草稿在框里）/ 换成额度菜单 / 权限框：授权不算数，不发、不记，说「框已经变了」", async () => {
    for (const f of ["turn-zone/cc-numlist-draft.txt", "turn-zone/cc-draft-num.txt", "lp/input-draft-multiline.ansi", "turn-zone/busy-queued.txt",
      "quota-wall/menu-on-credits.txt", "turn-zone/modal-permission.txt"]) {
      for (const k of ["Enter", "Escape"]) {
        const h = harness([fx(f)]);
        const r = await sendKeysChecked("agent-x", [k], SWMODEL, h.deps);
        expect([f, k, r.ok, h.sent, h.audits]).toEqual([f, k, false, [], []]);
        if (!r.ok) expect(r.error).toContain("框已经变了");
      }
    }
  });

  test("同类不等于同一张（r2 P1-1）：旧的切 Sonnet 按钮遇上后来的 effort 框、换了目标的切模型框、光标挪到 No 的同一张框 → 不发，说「换了一张」", async () => {
    const other = [EFFORT_BOX, MODEL_BOX.replace(/Sonnet 5/g, "Haiku 4.5"), MODEL_BOX.replace("❯ 1. Yes", "  1. Yes").replace("  2. No", "❯ 2. No")];
    for (const pane of other) {
      expect(seenScreenOf(pane, undefined)).toBe("switch_confirm");
      const h = harness([pane]);
      const r = await sendKeysChecked("agent-x", ["Enter"], SWMODEL, h.deps);
      expect([r.ok, h.sent, h.audits]).toEqual([false, [], []]);
      if (!r.ok) expect(r.error).toContain("换了一张");
    }
    expect(new Set(other.map((p) => screenFingerprint(p, "switch_confirm"))).size).toBe(3);
    // 同一张框：上方对话往上滚了几行（框本身没变）→ 指纹不变，照发
    const scrolled = `新的一行对话\n${MODEL_BOX}`;
    expect(screenFingerprint(scrolled, "switch_confirm")).toBe(SWMODEL.box);
  });

  test("旧框文字还显示在屏上、下面是真输入框（草稿在框里，default 模式没有 banner）→ 不认成切换框，授权 Enter 不发（r2 P1-2）", async () => {
    const rule = "─".repeat(80);
    const stale = `${MODEL_BOX.replace(/\s+$/, "")}\n\n${rule}\n❯ unfinished owner draft\n${rule}\n  ? for shortcuts`;
    expect(seenScreenOf(stale, undefined)).toBeNull();
    const h = harness([stale]);
    expect([(await sendKeysChecked("agent-x", ["Enter"], SWMODEL, h.deps)).ok, h.sent]).toEqual([false, []]);
    // 框下面还有别的顶格文字（不是最底下的元素）也不认
    expect(seenScreenOf(`${MODEL_BOX.replace(/\s+$/, "")}\nsome later output`, undefined)).toBeNull();
  });

  test("owner 在受保护画面上做的选择（如额度菜单点了某个选项）：--expect 那种画面、指纹对得上就放行，不用 --force；画面不对照样不发", async () => {
    const MENU = fx("quota-wall/menu-on-credits.txt");
    const menu = { force: false, authorizedBy: "ask:ask_123", expect: "limit_menu" as const, box: screenFingerprint(MENU, "limit_menu") };
    const ok = harness([MENU]);
    expect((await sendKeysChecked("agent-x", ["2"], menu, ok.deps)).ok).toBe(true);
    expect([ok.sent, ok.audits.map((a) => [a.authorizedBy, a.screen])]).toEqual([["2"], [["ask:ask_123", "limit_menu"]]]);
    for (const pane of [fx("quota-wall/walled.txt"), fx("turn-zone/cc-draft-num.txt"), fx("quota-wall/menu-no-lp.txt")]) {
      const h = harness([pane]);
      expect([(await sendKeysChecked("agent-x", ["2"], menu, h.deps)).ok, h.sent]).toEqual([false, []]);
    }
  });

  test("swmodel 按钮（Discord 与网页同一个处理）：id 带这张框的指纹和代次，授权发 Enter / Escape；被拒时把原因告诉点按钮的人", async () => {
    const box = screenFingerprint(MODEL_BOX, "switch_confirm");
    const g = switchPromptButtons("agent-x", box, 1_000);
    const [no, yes] = g.buttons.map((b) => b.id) as [string, string];
    expect([no, yes]).toEqual([`swmodel_no:#${box}.rs:agent-x`, `swmodel_yes:#${box}.rs:agent-x`]);
    expect(Math.max(yes.replace("agent-x", "a".repeat(64)).length, no.length)).toBeLessThanOrEqual(100); // Discord custom_id 上限
    const calls: string[][] = [];
    const rm = async (...a: string[]) => (calls.push(a), {});
    expect((await handleSwmodelButton(yes, rm)).text).toContain("确认切换");
    expect((await handleSwmodelButton(no, rm)).text).toContain("保持现状");
    expect(calls).toEqual([
      ["tmux-send-keys", "agent-x", "--authorized", `button:${yes}`, "--expect", "switch_confirm", "--box", box, "Enter"],
      ["tmux-send-keys", "agent-x", "--authorized", `button:${no}`, "--expect", "switch_confirm", "--box", box, "Escape"],
    ]);
    expect((await handleSwmodelButton(yes, async () => ({ error: "框已经换了一张" }))).text).toBe("❌ 发键失败: 框已经换了一张");
  });

  test("swmodel 按钮失效：旧版本 id、框关过（watcher 作废）、又发了新一张框的通知 → bridge 这边就不调 manager", async () => {
    const calls: string[][] = [];
    const rm = async (...a: string[]) => (calls.push(a), {});
    expect((await handleSwmodelButton("swmodel_yes:agent-x", rm)).text).toContain("旧版本");
    const first = switchPromptButtons("agent-x", screenFingerprint(MODEL_BOX, "switch_confirm"), 1_000).buttons[1]!.id;
    forgetSwitchPrompt("agent-x");
    expect((await handleSwmodelButton(first, rm)).text).toContain("已经关了或换了一张");
    const again = switchPromptButtons("agent-x", screenFingerprint(MODEL_BOX, "switch_confirm"), 2_000).buttons[1]!.id; // 同一内容的框再出现一次 = 新一代
    expect((await handleSwmodelButton(first, rm)).text).toContain("已经关了或换了一张");
    switchPromptButtons("agent-y", screenFingerprint(EFFORT_BOX, "switch_confirm"), 3_000);
    expect((await handleSwmodelButton(first.replace("agent-x", "agent-y"), rm)).text).toContain("已经关了或换了一张");
    expect(calls).toEqual([]);
    await handleSwmodelButton(again, rm);
    expect(calls.length).toBe(1);
  });

  test("调 manager tmux-send-keys 的地方只有这几处：新调用方先想清楚是程序自发（吃画面闸）还是 owner 授权（走 authorizedSendKeysArgs）", () => {
    const hits: string[] = [];
    const walk = (dir: string) => {
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        const p = join(dir, e.name);
        if (e.isDirectory()) walk(p);
        else if (/\.tsx?$/.test(e.name) && readFileSync(p, "utf8").includes('"tmux-send-keys"')) hits.push(p.slice(p.indexOf("src/")));
      }
    };
    walk(join(import.meta.dir, "../src"));
    // manager.ts = 命令分发；send-key-guard = authorizedSendKeysArgs；sandbox-env = 沙箱白名单
    expect(hits.sort()).toEqual(["src/lib/sandbox-env.ts", "src/lib/send-key-guard.ts", "src/manager.ts"]);
  });
});

describe("审计落盘与调用方", () => {
  test("appendSendKeysAudit 追加 JSONL，目录不在就建", () => {
    const path = join(mkdtempSync(join(tmpdir(), "sk-audit-")), "logs", "send-keys-audit.jsonl");
    const e: SendKeysAudit = { at: "t", caller: "master", ppid: 1, window: "agent-x", keys: ["1"], screen: "limit_menu", authorizedBy: null };
    appendSendKeysAudit(e, path);
    appendSendKeysAudit({ ...e, screen: null }, path);
    expect(readFileSync(path, "utf8").trim().split("\n").map((l) => JSON.parse(l).screen)).toEqual(["limit_menu", null]);
  });

  test("sendKeysCaller：CLAUDESTRA_AGENT > 频道反查 registry > 控制频道 = master > cli", () => {
    const agents = [{ name: "agent-pm", channelId: "111" }];
    expect(sendKeysCaller({ CLAUDESTRA_AGENT: "agent-codex", DISCORD_CHANNEL_ID: "111" }, agents)).toBe("agent-codex");
    expect(sendKeysCaller({ DISCORD_CHANNEL_ID: "111" }, agents)).toBe("agent-pm");
    expect(sendKeysCaller({ DISCORD_CHANNEL_ID: "999", CONTROL_CHANNEL_ID: "999" }, agents)).toBe("master");
    expect(sendKeysCaller({ DISCORD_CHANNEL_ID: "222" }, agents)).toBe("channel:222");
    expect(sendKeysCaller({}, agents)).toBe("cli");
  });
});
