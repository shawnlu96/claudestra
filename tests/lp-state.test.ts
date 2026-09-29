/**
 * lib/lp-state.ts：状态栏画面 → low-priority 状态、「设成开 / 设成关」的决策表、菜单 / 对话框识别（认出来也不导航）。
 * tests/fixtures/lp/ 是 2026-09-29 撞墙时在沙箱里抓的真实画面（capture-pane -p -e，CC 2.1.283）。
 */
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  decideLp, inputStateOf, lastLpEcho, LP_MENU_LABEL, paneQuotaState, parseMenu, readLpPane, stripAnsi,
  type LpMode, type LpRead, type PaneQuotaState,
} from "../src/lib/lp-state.js";

const fx = (name: string) => readFileSync(join(import.meta.dir, "fixtures", "lp", `${name}.ansi`), "utf8");
const read = (name: string) => readLpPane(fx(name));

/** 按真实画面的布局拼一个：对话 + 输入框 + 状态栏 */
function pane(opts: { above?: string[]; input?: string; footer: string[] }): string {
  const rule = "─".repeat(80);
  return [...(opts.above ?? ["⏺ hi", "✻ Worked for 3s · done 1:00 AM"]), rule, `❯ ${opts.input ?? ""}`, rule, ...opts.footer.map((l) => `  ${l}`)].join("\n");
}

describe("真实画面 → 状态", () => {
  const cases: [string, Partial<LpRead>][] = [
    ["walled", { lowPriority: "off", offer: true, walled: true, resetsAt: "3:20am", busy: false, input: "empty" }],
    ["walled-channel", { lowPriority: "off", offer: true, walled: true, busy: false }],
    ["lp-on-autocontinue", { lowPriority: "on", resetsAt: "3:20am", busy: true }],
    ["lp-on-allowance", { lowPriority: "on", allowancePct: 91, busy: false, input: "empty" }],
    ["lp-on-interrupted", { lowPriority: "on", busy: false }],
    ["lp-on-suggestion", { lowPriority: "on", input: "empty" }], // 输入框里的灰字是 CC 的提示建议，不是草稿
    ["busy-queued", { lowPriority: "on", busy: true, input: "queued" }],
    ["compacting", { lowPriority: "on", compacting: true }],
    ["compact-api-retry", { lowPriority: "on", busy: true }],
    ["compacted", { lowPriority: "on", busy: false, compacting: false }],
    ["lp-off-offer", { lowPriority: "off", offer: true, walled: false }],
    ["lp-off-resumable", { lowPriority: "off", offer: false, resumable: true }],
    ["fresh-placeholder", { lowPriority: "off", offer: false, walled: false, input: "empty" }],
    ["fresh-unavailable", { lowPriority: "off", offer: false }],
    ["draft", { lowPriority: "off", input: "draft" }],
    ["walled-typing", { input: "draft" }],
  ];
  for (const [name, want] of cases) test(name, () => expect(read(name)).toMatchObject(want));

  test("每份样本都落在四态之内", () => {
    const modes: LpMode[] = ["on", "off", "exhausted", "unknown"];
    for (const f of readdirSync(join(import.meta.dir, "fixtures", "lp")).filter((n) => n.endsWith(".ansi"))) {
      expect(modes).toContain(readLpPane(readFileSync(join(import.meta.dir, "fixtures", "lp", f), "utf8")).lowPriority);
    }
  });

  test("撞墙等待不算忙：状态栏和对话里的「esc to cancel」不能触发判忙", () => {
    expect(fx("walled")).toContain("esc to cancel");
    expect(read("walled").busy).toBe(false);
  });

  test("额度菜单挡着时：有 LP 项判成「关、能开」，没有就判 unknown", () => {
    expect(read("menu-5-items")).toMatchObject({ lowPriority: "off", offer: true });
    expect(read("menu-on-lp").menu?.options.map((o) => o.label)).toContain(LP_MENU_LABEL);
    const noLp = read("menu-no-lp");
    expect(noLp.lowPriority).toBe("unknown");
    expect(noLp.menu?.options.map((o) => o.label)).toEqual(["Stop and wait for limit to reset", "Switch to usage credits"]);
  });
});

describe("只认状态栏，不认对话", () => {
  test("对话里提到 Lower priority until 不算开", () => {
    const p = pane({ above: ["⏺ 状态栏会显示「⚠ Lower priority until 3:20am · /low-priority to stop」"], footer: ["Opus 5.5 · 5h 40%", "⏵⏵ bypass permissions on"] });
    expect(readLpPane(p).lowPriority).toBe("off");
  });

  test("状态栏提到 low-priority 但文案认不出（CC 改了字）→ unknown，不许发", () => {
    const p = pane({ footer: ["⚠ Slower lane active till 3:20am · /low-priority to stop", "⏵⏵ bypass permissions on"] });
    const r = readLpPane(p);
    expect(r.lowPriority).toBe("unknown");
    expect(decideLp("off", r).kind).toBe("refuse");
    expect(decideLp("on", r).kind).toBe("refuse");
  });

  test("本周 LP 额度用完单独成一个状态", () => {
    const r = readLpPane(pane({ footer: ["⚠ You've used this week's lower-priority allowance", "⏵⏵ bypass permissions on"] }));
    expect(r.lowPriority).toBe("exhausted");
    expect(decideLp("on", r)).toMatchObject({ kind: "refuse" });
    expect((decideLp("on", r) as { reason: string }).reason).toContain("额度已用完");
  });

  test("找不到输入框 → unknown", () => {
    expect(readLpPane("just some shell output\n$ ").lowPriority).toBe("unknown");
  });
});

describe("决策表：设成开 / 设成关", () => {
  const table: [string, "on" | "off", string][] = [
    ["walled", "on", "send"],
    ["walled", "off", "skip"],
    ["lp-on-allowance", "on", "skip"],
    ["lp-on-allowance", "off", "send"],
    ["lp-on-autocontinue", "off", "busy"], // 忙时开关不发：排队的开关到回合结束才执行，那时可能切反
    ["busy-queued", "on", "busy"],
    ["compacting", "off", "skip"],
    ["lp-off-offer", "on", "send"],
    ["lp-off-resumable", "on", "send"],
    ["fresh-placeholder", "on", "refuse"], // 没撞墙：CC 只会回 isn't available
    ["fresh-unavailable", "off", "skip"],
    ["walled-typing", "on", "refuse"], // 输入框有草稿不动
    ["menu-5-items", "on", "refuse"], // 看到菜单一个键都不按（PM 09-29 定），要开请人手在菜单里选
    ["menu-on-credits", "on", "refuse"],
    ["menu-5-items", "off", "skip"],
    ["menu-no-lp", "on", "refuse"],
  ];
  for (const [name, want, kind] of table) test(`${name} · 设成${want === "on" ? "开" : "关"} → ${kind}`, () => expect(decideLp(want, read(name)).kind).toBe(kind as never));

  test("菜单挡着：refuse 里写明没按键，有 LP 项时提示人手去选", () => {
    const d = decideLp("on", read("menu-on-credits"));
    expect(d.kind === "refuse" && d.reason).toContain("没按任何键");
    expect(d.kind === "refuse" && d.reason).toContain(LP_MENU_LABEL);
    expect(decideLp("on", read("walled"))).toEqual({ kind: "send" });
  });
});

describe("额度菜单：认得出，但不导航", () => {
  test("菜单里只剩危险项（usage credits / Upgrade / Team plan / 领 credit）→ 拒绝，连 Esc 也不按", () => {
    const opts = ["Switch to usage credits", "Upgrade to Max for higher limits", "Switch to Team plan", "While you wait, start a new cloud session by claiming a $250 credit"];
    const raw = ["▔".repeat(80), "   What do you want to do?", "", ...opts.map((o, i) => `   ${i === 0 ? "❯ " : "  "}${i + 1}. ${o}`), "", "   Enter to confirm · Esc to cancel"].join("\n");
    const r = readLpPane(raw);
    expect(r.menu?.options).toHaveLength(4);
    expect(r).toMatchObject({ modal: true, walled: true });
    expect(decideLp("on", r).kind).toBe("refuse");
  });

  test("弯引号归一：Don’t → Don't", () => {
    expect(parseMenu(stripAnsi(fx("menu-5-items")).split("\n"))?.options.map((o) => o.label)).toContain("Don't continue automatically");
  });
});

describe("回显", () => {
  test("strict：只看最后一次 /low-priority 命令的回显", () => {
    expect(lastLpEcho(fx("lp-on-allowance"))?.echo).toBe("accepted");
    expect(lastLpEcho(fx("fresh-unavailable"))?.echo).toBe("unavailable");
    expect(lastLpEcho(fx("lp-off-offer"))?.echo).toBe("off");
  });

  test("刚发出、回显还没出来时 strict 不拿更早的回显冒充", () => {
    const raw = ["❯ /low-priority", "  ⎿  Lower-priority mode isn't available right now.", "❯ /low-priority", "─".repeat(80), "❯ ", "─".repeat(80)].join("\n");
    expect(lastLpEcho(raw)).toBeNull();
    expect(lastLpEcho(raw, false)?.echo).toBe("unavailable");
  });
});

describe("输入框", () => {
  test("灰字（ESC[2m）= 空；正常颜色的字 = 草稿；不带颜色抓的分不清 = unknown", () => {
    expect(inputStateOf(["❯ Try \"fix lint errors\""], ["\x1b[39m❯ \x1b[2mTry \"fix lint errors\"\x1b[0m"])).toBe("empty");
    expect(inputStateOf(["❯ draft text"], ["\x1b[39m❯ draft text"])).toBe("draft");
    expect(inputStateOf(["❯ draft text"], ["❯ draft text"])).toBe("unknown");
    expect(inputStateOf(["❯ "], ["❯ "])).toBe("empty");
    expect(inputStateOf(["❯ line1", "  line2"], ["❯ line1", "  line2"])).toBe("draft");
  });
});

describe("paneQuotaState（T36 注入闸门的精简视图）", () => {
  const q = (name: string) => paneQuotaState(stripAnsi(fx(name)), fx(name));
  const cases: [string, Partial<PaneQuotaState>][] = [
    ["walled", { wall: true, lp: "off", exhausted: false, menu: false, compacting: false, draft: false }],
    ["walled-typing", { wall: true, menu: false, draft: true }],
    ["lp-on-allowance", { wall: false, lp: "on", menu: false, draft: false }],
    ["lp-on-suggestion", { lp: "on", draft: false }],
    ["compacting", { compacting: true, menu: false }],
    ["busy-queued", { menu: false, draft: true }], // PM 约定：输入框不是确定的空一律当有草稿，排队也算
    ["draft", { menu: false, draft: true }],
    ["fresh-placeholder", { wall: false, lp: "off", menu: false, draft: false }],
    // 下面三份是 T36 在私有 tmux 里抓的真实 CC 画面（reviews/T36-samples）
    ["input-suggestion", { menu: false, draft: false }],
    ["input-draft", { menu: false, draft: true }],
    ["input-draft-multiline", { menu: false, draft: true }],
    // 沙箱实测：bash 模式（! 提示符，这时敲 /compact 会被当 shell 命令跑）、16 行长草稿（CC 把框封顶 7 行滚动显示）、草稿里带整行横线
    ["input-bash-empty", { menu: false, draft: true }],
    ["input-bash-typed", { menu: false, draft: true }],
    ["input-draft-long", { menu: false, draft: true }],
    ["input-draft-rule", { menu: false, draft: true }],
    ["menu-5-items", { wall: true, lp: "off", menu: true }],
    ["menu-no-lp", { wall: true, lp: "unknown", menu: true }],
    ["modal-permission", { wall: false, lp: "unknown", menu: true, draft: true }],
    ["modal-auq", { wall: false, menu: true, draft: true }],
    ["modal-rewind", { wall: false, menu: true, draft: true }],
  ];
  for (const [name, want] of cases) test(name, () => expect(q(name)).toMatchObject(want));

  test("本周 LP 额度用完：lp 报 off，exhausted 为真", () => {
    const p = pane({ footer: ["⚠ You've used this week's lower-priority allowance", "Opus 5.5 · 5h 100%"] });
    expect(paneQuotaState(stripAnsi(p), p)).toMatchObject({ lp: "off", exhausted: true, menu: false });
  });

  test("只有纯文本抓屏：分不清灰字提示和草稿，当有草稿（不敲键）", () => {
    const plain = readFileSync(join(import.meta.dir, "fixtures", "lp", "input-suggestion.plain.txt"), "utf8");
    expect(paneQuotaState(plain, "").draft).toBe(true);
    expect(paneQuotaState(plain, fx("input-suggestion")).draft).toBe(false);
  });

  test("长得像输入框的对话框：编号选项占了 ❯ 行，或框下有大写的「Esc to cancel」", () => {
    expect(paneQuotaState("", pane({ input: "1. Yes", footer: ["2. No"] })).menu).toBe(true);
    expect(paneQuotaState("", pane({ footer: ["Esc to cancel · Tab to amend"] })).menu).toBe(true);
    expect(paneQuotaState("", pane({ footer: ["Usage limit reached · continuing automatically at 3:20am · esc to cancel"] })).menu).toBe(false);
  });
});

describe("额度菜单以外的对话框：认成模态，而且决策表不许按任何键", () => {
  const repoFx = (p: string) => readFileSync(join(import.meta.dir, "fixtures", p), "utf8");
  const panes: [string, string][] = [
    ["权限框", fx("modal-permission")],
    ["AUQ", fx("modal-auq")],
    ["Rewind", fx("modal-rewind")],
    ["切模型确认", repoFx("switch-confirm/cc2.1.280-switch-model.txt")],
    ["切 effort 确认", repoFx("switch-confirm/cc2.1.280-change-effort.txt")],
    ["bypass 首启确认（Esc = 退出 CC）", repoFx("cc-bypass-consent-pane.txt")],
  ];
  for (const [name, raw] of panes) test(name, () => {
    const r = readLpPane(raw);
    expect(r.modal).toBe(true);
    expect(r.walled).toBe(false);
    expect(decideLp("on", r).kind).toBe("refuse");
    expect(decideLp("off", r).kind).toBe("refuse");
  });
});

describe("adv1 / r1 的 P2 与 T36 约定", () => {
  test("判忙看整个可见区：spinner 下面挂着很长的 todo 列表也算忙", () => {
    const todos = Array.from({ length: 9 }, (_, i) => `     ☐ todo item ${i + 1}`);
    expect(readLpPane(pane({ above: ["✢ Hatching… (12s · ↓ 10 tokens)", "  ⎿  Todos", ...todos], footer: ["Opus 5.5"] })).busy).toBe(true);
  });

  test("对话里大写的「Esc to cancel」不算忙（剥除不分大小写，与 CC_BUSY_RE 一致）", () => {
    expect(readLpPane(pane({ above: ["⏺ 菜单底部写着 Esc to cancel", "✻ Worked for 3s · done 1:00 AM"], footer: ["Opus 5.5"] })).busy).toBe(false);
  });

  test("草稿超过 14 行：边框之间多长都认得出输入框", () => {
    const rule = "─".repeat(80);
    const lines = ["❯ line 1", ...Array.from({ length: 15 }, (_, i) => `  line ${i + 2}`)];
    const raw = ["⏺ hi", rule, ...lines, rule, "  Opus 5.5"].join("\n");
    expect(paneQuotaState(raw, raw)).toMatchObject({ menu: false, draft: true });
  });

  test("重置时刻带日期（until Oct 1, 3:20am）取全", () => {
    const p = pane({ footer: ["⚠ Lower priority until Oct 1, 3:20am · 90% allowance left · /low-priority to stop", "Opus 5.5"] });
    expect(readLpPane(p)).toMatchObject({ lowPriority: "on", resetsAt: "Oct 1, 3:20am", allowancePct: 90 });
  });

  test("bash 模式的输入框：不管有没有字都当草稿（敲进去的 /compact 会被当成 shell 命令）", () => {
    expect(inputStateOf(["! "], ["! "])).toBe("draft");
    expect(readLpPane(fx("input-bash-empty")).inputText).toContain("Try");
  });

  test("输入框文字只去掉提示符后面那一个空格，行首多出的空格保留（T35 adv3 P2-1：runner 比原文）", () => {
    const at = (line: string) => readLpPane(fx("lp-on-interrupted").replace(/\x1b\[39m❯[^\S\n]*\n/, `\x1b[39m${line}\n`)).inputText;
    expect(at("❯ /low-priority")).toBe("/low-priority");
    expect(at("❯  /low-priority")).toBe(" /low-priority");
  });

  test("真 CC 的提示符后面是 NBSP（U+00A0）：当普通空格去掉，开头不留 NBSP（T36 r3 P2-5：不然 T35 逐字比回显永远对不上）", () => {
    expect(fx("input-draft")).toContain("❯ ");
    expect(readLpPane(fx("input-draft")).inputText).toBe("owner half typed msg");
    expect(readLpPane(fx("input-draft-multiline")).inputText).toBe("line one\nline two");
    expect(readLpPane(fx("walled-typing")).inputText).toBe("/rate-limit-options");
    const at = (line: string) => readLpPane(fx("lp-on-interrupted").replace(/\x1b\[39m❯[^\S\n]*\n/, `\x1b[39m${line}\n`)).inputText;
    expect(at("❯ /low-priority")).toBe("/low-priority");
    expect(at("❯  /low-priority")).toBe(" /low-priority");
    // 顺序：先把 NBSP 换成空格，再去提示符后那一个；反过来的话，这条和上面「❯ + NBSP」那条都会多出一个前导空格
    expect(at("❯\u00a0 /low-priority")).toBe(" /low-priority");
  });
});

describe("adv2 / r2：对话里的字不能冒充底部状态", () => {
  const lpOn = ["⚠ Lower priority until 3:20am · 90% allowance left · /low-priority to stop", "Opus 5.5"];

  test("输入框上方引用了额度菜单（agent 回复里贴的）：判 unknown、不算撞墙，照样不按键，lp-off 不许报「本来就是关的」", () => {
    const quoted = ["⏺ 撞墙时底部是这样的：", `  ${"▔".repeat(40)}`, "     What do you want to do?", "     ❯ 1. Stop and wait for limit to reset",
      "       2. Continue now at lower priority", "     Enter to confirm · Esc to cancel", "✻ Worked for 3s · done 1:00 AM"];
    const raw = pane({ above: quoted, footer: lpOn });
    expect(readLpPane(raw)).toMatchObject({ lowPriority: "unknown", walled: false, offer: false, modal: true, menu: null });
    expect(decideLp("off", readLpPane(raw)).kind).toBe("refuse");
    expect(paneQuotaState(raw, raw)).toMatchObject({ wall: false, lp: "unknown", menu: true });
  });

  test("底部的额度菜单缺了顶格 ▔ 上沿：认不准，判 unknown、不算撞墙", () => {
    const raw = fx("menu-5-items").replace(/\n[^\n]*▔{8,}[^\n]*/, "\n");
    expect(readLpPane(raw)).toMatchObject({ lowPriority: "unknown", walled: false, modal: true, menu: null });
    expect(read("menu-5-items")).toMatchObject({ lowPriority: "off", walled: true }); // 原样的真菜单照旧
  });

  test("判忙只认顶格 spinner 行：正文、工具输出、缩进列表、工具输出里抓到的别的窗口 spinner 都不算", () => {
    const noise = ["⏺ 判忙的正则里有 esc to interrupt，看到它就算忙", "  ⎿  328: /esc to interrupt|esc to cancel/", "  * 跑测试… (约 30s)",
      "  ✢ Hatching… (12s · ↓ 10 tokens)", "✻ Worked for 3s · done 1:00 AM"];
    expect(readLpPane(pane({ above: noise, footer: lpOn })).busy).toBe(false);
    expect(readLpPane(pane({ above: [...noise, "✢ Hatching… (12s · ↓ 10 tokens)"], footer: lpOn })).busy).toBe(true);
    expect(read("lp-on-autocontinue").busy).toBe(true); // 首个 token 前不带括号的「✢ Hullaballooing…」
  });

  test("对话里引用的「❯ /low-priority」和回显（有缩进）不算命令行：不算回显、也不算本窗口手动关过", () => {
    const quoted = ["⏺ 上次是这样关的：", "  ❯ /low-priority", "    ⎿  Lower-priority mode is off. Run /low-priority again to turn it back on."];
    const raw = pane({ above: quoted, footer: ["Opus 5.5"] });
    expect(lastLpEcho(raw)).toBeNull();
    expect(lastLpEcho(raw, false)).toBeNull();
    expect(readLpPane(raw).resumable).toBeUndefined();
  });
});
