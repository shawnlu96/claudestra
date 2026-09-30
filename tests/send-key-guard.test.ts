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
import { handleSwmodelButton, isSwmodelButton, SWMODEL_RETIRED } from "../src/bridge/swmodel-button.js";

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
  test("草稿、回合中、LP 在跑、切模型确认框（程序自发不拦）→ 不拦", () => {
    for (const f of PLAIN) expect([f, guardedScreenOf(fx(f), undefined)]).toEqual([f, null]);
  });
  test("seenScreenOf：切模型 / effort 确认框单独认出来（授权发一律不发）；空屏 = unreadable；草稿 = 普通画面", () => {
    for (const f of ["cc2.1.280-switch-model.txt", "cc2.1.280-change-effort.txt"]) expect([f, seenScreenOf(fx(`switch-confirm/${f}`), undefined)]).toEqual([f, "switch_confirm"]);
    expect([seenScreenOf("", undefined), seenScreenOf(" \n\n  \n", undefined)]).toEqual(["unreadable", "unreadable"]);
    expect(seenScreenOf(fx("turn-zone/cc-numlist-draft.txt"), undefined)).toBeNull();
    expect(seenScreenOf(fx("quota-wall/menu-on-credits.txt"), undefined)).toBe("limit_menu");
  });
});

describe("guardedScreenOf：目录信任框用宽口径拦，不用自动确认的严格识别（T44 r4 P1）", () => {
  /** main 537f85bb 上发键闸用的判定原样照抄，做对照：凡它拦的，现在也得拦 */
  function mainTrustPromptMoves(pane: string): number | null {
    const tail = pane.split("\n");
    while (tail.length && !tail[tail.length - 1]!.trim()) tail.pop();
    const joined = tail.slice(-25).join("\n");
    if (!/trust this folder/i.test(joined) || !/Enter to confirm/i.test(joined)) return null;
    const opts = tail.slice(-25).flatMap((l) => {
      const m = l.match(/^\s*(❯)?\s*(No, exit|Yes, I trust this folder)\s*$/i);
      return m ? [{ yes: /^yes/i.test(m[2]!), selected: !!m[1] }] : [];
    });
    const yesIdx = opts.findIndex((o) => o.yes), selIdx = opts.findIndex((o) => o.selected);
    return yesIdx < 0 || selIdx < 0 ? null : yesIdx - selIdx;
  }
  const trust = fx("trust/cc2.1.284-trust.txt").trimEnd();
  const numbered = trust.replace(" ❯ No, exit", " ❯ 1. No, exit").replace("   Yes, I trust", "   2. Yes, I trust");
  const screens: Record<string, string> = {
    "完整的框": trust,
    "可见区只有 12 行（标题滚出去了）": trust.split("\n").slice(-12).join("\n"),
    "框里多一行 WARNING": trust.replace(" Security guide", " WARNING: Please review this project"),
    "尾注改成 Esc to exit": trust.replace("Esc to cancel", "Esc to exit"),
    "框底下多一行 Tip": `${trust}\n\n  ✻ Tip: run /init to create a CLAUDE.md`,
  };
  test("main 拦的这几种画面，现在都拦", () => {
    for (const [name, pane] of Object.entries(screens)) {
      expect([name, mainTrustPromptMoves(pane) !== null, guardedScreenOf(pane, undefined)]).toEqual([name, true, "trust_prompt"]);
    }
  });
  test("带编号的框：main 漏了，现在也拦", () => {
    expect(mainTrustPromptMoves(numbered)).toBeNull();
    expect(guardedScreenOf(numbered, undefined)).toBe("trust_prompt");
    expect(guardedScreenOf(numbered.split("\n").slice(-6).join("\n"), undefined)).toBe("trust_prompt");
  });
  test("对话里提到信任框文案、没有确认尾注：普通画面，不拦", () => {
    const chat = ["⏺ 弹窗的选项是：", "  Yes, I trust this folder", "", "─".repeat(40), "❯ ", "─".repeat(40), "  ⏵⏵ bypass permissions on"].join("\n");
    expect(guardedScreenOf(chat, undefined)).toBeNull();
  });
});

const PROG = { force: false, authorizedBy: null, expect: null, box: null };
const FORCE = { force: true, authorizedBy: null, expect: null, box: null };
const MODEL_BOX = fx("switch-confirm/cc2.1.280-switch-model.txt");
const EFFORT_BOX = fx("switch-confirm/cc2.1.280-change-effort.txt");
const MENU = fx("quota-wall/menu-on-credits.txt");
/** owner 在额度菜单上授权过的选择（将来的额度菜单按钮 / ask） */
const AUTH_MENU = { force: false, authorizedBy: "ask:ask_123", expect: "limit_menu" as const, box: screenFingerprint(MENU) };

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
      for (const opts of [PROG, AUTH_MENU]) {
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
    for (const opts of [PROG, FORCE, AUTH_MENU]) await sendKeysChecked("agent-x", ["C-u", "hi", "Enter"], opts, h.deps);
    expect(outside).toEqual([]);
  });

  test("程序自发（没有授权）在切模型确认框上发 Enter / Escape：不在拦截名单，照旧放行", async () => {
    for (const k of ["Enter", "Escape"]) {
      const h = harness([fx("switch-confirm/cc2.1.280-switch-model.txt")]);
      expect((await sendKeysChecked("agent-x", [k], PROG, h.deps)).ok).toBe(true);
      expect(h.sent).toEqual([k]);
    }
  });
});

describe("owner 点过才发键的路径（--authorized）", () => {
  test("argv 形状：authorizedSendKeysArgs 拼的，manager 解析回来是同一组选项和键", () => {
    const argv = authorizedSendKeysArgs("agent-x", "ask:ask_123", "limit_menu", AUTH_MENU.box, ["2"]);
    expect(argv.slice(0, 2)).toEqual(["tmux-send-keys", "agent-x"]);
    expect(parseSendKeysArgs(argv.slice(2))).toEqual({ ...AUTH_MENU, keys: ["2"] });
    expect(parseSendKeysArgs(["--force", "1"])).toEqual({ ...FORCE, keys: ["1"] });
  });

  test("选项只认键之前的；--authorized / --expect / --box 三个一起给；--expect 只认已知画面；授权发只发一个键", () => {
    expect(parseSendKeysArgs(["1", "--force", "Enter"])).toEqual({ ...PROG, keys: ["1", "--force", "Enter"] });
    const auth = ["--authorized", "b", "--expect", "limit_menu", "--box", "abcdef012345"];
    expect(parseSendKeysArgs([...auth, "2"])).toEqual({ force: false, authorizedBy: "b", expect: "limit_menu", box: "abcdef012345", keys: ["2"] });
    for (const bad of [["--authorized", "button:x", "Enter"], ["--expect", "limit_menu", "1"], ["--authorized", "b", "--expect", "limit_menu", "1"],
      ["--authorized", "b", "--expect", "input_box", "--box", "x", "1"], ["--authorized", "b", "--expect", "switch_confirm", "--box", "x", "Enter"],
      ["--force"], ["--authorized"], [...auth, "Down", "Enter"]]) {
      expect([bad, "error" in parseSendKeysArgs(bad)]).toEqual([bad, true]);
    }
  });

  test("switch_confirm 一律拒绝授权发键（r3 收口）：参数解析不认 --expect switch_confirm；绕过解析硬塞也不发、不记", async () => {
    expect(parseSendKeysArgs(["--authorized", "b", "--expect", "switch_confirm", "--box", screenFingerprint(MODEL_BOX), "Enter"])).toHaveProperty("error");
    for (const pane of [MODEL_BOX, EFFORT_BOX]) {
      const forged = { ...AUTH_MENU, expect: "switch_confirm" as never, box: screenFingerprint(pane) };
      for (const opts of [forged, AUTH_MENU]) {
        for (const k of ["Enter", "Escape"]) {
          const h = harness([pane]);
          const r = await sendKeysChecked("agent-x", [k], opts, h.deps);
          expect([r.ok, h.sent, h.audits]).toEqual([false, [], []]);
          if (!r.ok) expect([r.screen, r.error.includes("自己按")]).toEqual(["switch_confirm", true]);
        }
      }
    }
  });

  test("授权过的菜单点得晚、回到输入框（草稿在框里）/ 换成权限框 / 倒计时：授权不算数，不发、不记，说「框已经变了」", async () => {
    for (const f of ["turn-zone/cc-numlist-draft.txt", "turn-zone/cc-draft-num.txt", "lp/input-draft-multiline.ansi", "turn-zone/busy-queued.txt",
      "quota-wall/walled.txt", "turn-zone/modal-permission.txt"]) {
      for (const k of ["2", "Enter", "Escape"]) {
        const h = harness([fx(f)]);
        const r = await sendKeysChecked("agent-x", [k], AUTH_MENU, h.deps);
        expect([f, k, r.ok, h.sent, h.audits]).toEqual([f, k, false, [], []]);
        if (!r.ok) expect(r.error).toContain("框已经变了");
      }
    }
  });

  test("同类不等于同一张：换了选项的额度菜单、光标挪了的同一张菜单 → 不发，说「换了一张」；上方对话滚动不影响", async () => {
    const other = [fx("quota-wall/menu-no-lp.txt"), MENU.replace("❯ 4. Switch", "  4. Switch").replace("     3. Continue", "   ❯ 3. Continue")];
    for (const pane of other) {
      expect(seenScreenOf(pane, undefined)).toBe("limit_menu");
      const h = harness([pane]);
      const r = await sendKeysChecked("agent-x", ["Enter"], AUTH_MENU, h.deps);
      expect([r.ok, h.sent, h.audits]).toEqual([false, [], []]);
      if (!r.ok) expect(r.error).toContain("换了一张");
    }
    expect(new Set([MENU, ...other].map(screenFingerprint)).size).toBe(3);
    expect(screenFingerprint(`新的一行对话\n${MENU}`)).toBe(AUTH_MENU.box);
  });

  test("指纹：连续空白压成一个、不删（r3 P2：「Sonnet 5」≠「Sonnet5」）；行尾空白、缩进宽度、-J 拼行留下的多余空格不影响", () => {
    expect(screenFingerprint(MODEL_BOX.replace(/Sonnet 5/g, "Sonnet5"))).not.toBe(screenFingerprint(MODEL_BOX));
    expect(screenFingerprint(MODEL_BOX.replace(/\n/g, "   \n").replace(/  +/g, "    "))).toBe(screenFingerprint(MODEL_BOX));
    expect(new Set([MODEL_BOX, EFFORT_BOX, MODEL_BOX.replace(/Sonnet 5/g, "Haiku 4.5")].map(screenFingerprint)).size).toBe(3);
  });

  test("旧框文字还显示在屏上、下面是真输入框（草稿在框里，default 模式没有 banner）→ 不认成切换框（r2 P1-2；watcher 自己代按也靠它）", () => {
    const rule = "─".repeat(80);
    const stale = `${MODEL_BOX.replace(/\s+$/, "")}\n\n${rule}\n❯ unfinished owner draft\n${rule}\n  ? for shortcuts`;
    expect(seenScreenOf(stale, undefined)).toBeNull();
    // 框下面还有别的顶格文字（不是最底下的元素）也不认
    expect(seenScreenOf(`${MODEL_BOX.replace(/\s+$/, "")}\nsome later output`, undefined)).toBeNull();
  });

  test("owner 在受保护画面上做的选择（如额度菜单点了某个选项）：--expect 那种画面、指纹对得上就放行，不用 --force；画面不对照样不发", async () => {
    const menu = AUTH_MENU;
    const ok = harness([MENU]);
    expect((await sendKeysChecked("agent-x", ["2"], menu, ok.deps)).ok).toBe(true);
    expect([ok.sent, ok.audits.map((a) => [a.authorizedBy, a.screen])]).toEqual([["2"], [["ask:ask_123", "limit_menu"]]]);
    for (const pane of [fx("quota-wall/walled.txt"), fx("turn-zone/cc-draft-num.txt"), fx("quota-wall/menu-no-lp.txt")]) {
      const h = harness([pane]);
      expect([(await sendKeysChecked("agent-x", ["2"], menu, h.deps)).ok, h.sent]).toEqual([false, []]);
    }
  });

  test("swmodel 按钮已停用（r3 收口）：聊天记录里的旧按钮（任何形状的 id）点了只回话、不调 manager；watcher 不再发这组按钮", async () => {
    for (const id of ["swmodel_yes:agent-x", "swmodel_no:agent-x", "swmodel_yes:#4656539ea32e.rs:agent-x"]) {
      expect(isSwmodelButton(id)).toBe(true); // management.ts 先认出来，再交给不带 runManager 的 handleSwmodelButton
    }
    expect((await handleSwmodelButton()).text).toBe(SWMODEL_RETIRED);
    expect(SWMODEL_RETIRED).toContain("终端");
    const watcher = readFileSync(join(import.meta.dir, "../src/bridge/permission-watcher.ts"), "utf8");
    expect([watcher.includes("swmodel_"), watcher.includes('from "./swmodel-button')]).toEqual([false, false]);
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
