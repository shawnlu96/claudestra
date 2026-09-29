/**
 * manager tmux-send-keys 的画面闸 + --force 审计（T41a）：lib/send-key-guard.ts、manager/send-keys.ts。
 * 画面全是真实 capture-pane 样本；发键、抓屏、审计都注入，测试不碰 tmux。
 */
import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appendSendKeysAudit, guardedScreenOf, sendKeysCaller, type SendKeysAudit } from "../src/lib/send-key-guard.js";
import { sendKeysChecked, type SendKeysDeps } from "../src/manager/send-keys.js";

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
});

function harness(screens: string[]) {
  const sent: string[] = [];
  const audits: SendKeysAudit[] = [];
  let i = 0;
  const deps: SendKeysDeps = {
    capture: async () => screens[Math.min(i++, screens.length - 1)]!,
    runtimeOf: () => undefined,
    sendKey: async (_t, k) => void sent.push(k),
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
        const r = await sendKeysChecked("agent-x", keys, false, h.deps);
        expect([f, keys, r.ok, r.ok ? null : r.screen, h.sent, h.audits]).toEqual([f, keys, false, GUARDED[f] as never, [], []]);
        if (!r.ok) expect(r.error).toContain("--force");
        n++;
      }
    }
    expect(n).toBe(20);
  });

  test("--force：先写一行审计（谁、窗口、键、命中的画面），再照发", async () => {
    const h = harness([fx("quota-wall/walled.txt")]);
    const r = await sendKeysChecked("agent-x", ["/low-priority", "Enter", "Escape", "C-u"], true, h.deps);
    expect(r).toEqual({ ok: true, keys: ["/low-priority", "Enter", "Escape", "C-u"], forced: true, screen: "wall_countdown" });
    expect(h.sent).toEqual(["/low-priority", "Enter", "Escape", "C-u"]);
    expect(h.audits).toEqual([{ at: "2026-09-30T00:00:00.000Z", caller: "agent-pm", ppid: process.ppid, window: "agent-x", keys: h.sent, screen: "wall_countdown" }]);
  });

  test("--force 时审计写不进去：一个键都不发", async () => {
    const h = harness([fx("quota-wall/menu-no-lp.txt")]);
    h.deps.audit = () => { throw new Error("EACCES"); };
    await expect(sendKeysChecked("agent-x", ["1"], true, h.deps)).rejects.toThrow("EACCES");
    expect(h.sent).toEqual([]);
  });

  test("普通画面照发；前一个键弹出了权限框，后面的键停下（每个键前都重抓）", async () => {
    const ok = harness([fx("turn-zone/cc-draft-num.txt")]);
    expect((await sendKeysChecked("agent-x", ["C-u", "hi", "Enter"], false, ok.deps)).ok).toBe(true);
    expect([ok.sent, ok.audits]).toEqual([["C-u", "hi", "Enter"], []]);
    const h = harness([fx("turn-zone/cc-draft-num.txt"), fx("turn-zone/modal-permission.txt")]);
    const r = await sendKeysChecked("agent-x", ["Enter", "1"], false, h.deps);
    expect([r.ok, h.sent]).toEqual([false, ["Enter"]]);
    if (!r.ok) expect(r.sent).toEqual(["Enter"]);
  });

  test("管理按钮代决切模型（swmodel_yes / no 发 Enter / Escape）不受影响", async () => {
    for (const k of ["Enter", "Escape"]) {
      const h = harness([fx("switch-confirm/cc2.1.280-switch-model.txt")]);
      expect((await sendKeysChecked("agent-x", [k], false, h.deps)).ok).toBe(true);
      expect(h.sent).toEqual([k]);
    }
  });
});

describe("审计落盘与调用方", () => {
  test("appendSendKeysAudit 追加 JSONL，目录不在就建", () => {
    const path = join(mkdtempSync(join(tmpdir(), "sk-audit-")), "logs", "send-keys-audit.jsonl");
    const e: SendKeysAudit = { at: "t", caller: "master", ppid: 1, window: "agent-x", keys: ["1"], screen: "limit_menu" };
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
