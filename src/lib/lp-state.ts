/**
 * Claude Code 的 low-priority（LP）状态：从一次 `capture-pane -p -e` 的画面判出来。
 * statusLine 喂的 JSON 里没有这个状态（CC 2.1.283 只给 rate_limits 的用量和重置时刻），LP 只活在 CC 进程内存里，
 * 所以只能读画面。只认输入框下沿以下的状态栏：对话里出现同样的字（讨论这个功能时）不能算数。
 * 文案来自 CC 远程配置，默认值见下面的常量；认不出的 LP 字样一律判 unknown，宁可拒绝也不盲发——
 * `/low-priority` 是开关，判错一次就把开着的切成关。看到任何菜单 / 对话框都不按键。样本在 tests/fixtures/lp/，用例见 tests/lp-state.test.ts。
 */
import { CC_BUSY_RE } from "./tmux-helper.js";

export type LpMode = "on" | "off" | "exhausted" | "unknown";
export type InputState = "empty" | "draft" | "queued" | "unknown";

interface MenuOption { n: number; label: string; selected: boolean }
export interface PaneMenu { title: string; options: MenuOption[] }

export interface LpRead {
  lowPriority: LpMode;
  /** 状态栏有「/low-priority to continue now」提示，或额度菜单里有 LP 项：现在能开 */
  offer: boolean;
  /** 本窗口期里手动关过（画面上最后一条 LP 回显是「is off … turn it back on」）：状态栏没提示也能再打开 */
  resumable?: boolean;
  /** 撞墙等待中（「Usage limit reached · continuing automatically …」），或底部开着额度菜单 */
  walled: boolean;
  /** 重置时刻原文（「3:20am」「Oct 1, 3:20am」），LP 开着时取 LP 行，否则取撞墙行 */
  resetsAt?: string;
  /** LP 开着时状态栏带的「91% allowance left」 */
  allowancePct?: number;
  /** 输入框以上整个可见区里有回合 spinner；撞墙等待不算忙 */
  busy: boolean;
  compacting: boolean;
  input: InputState;
  /** 输入框里的字（去色，去掉行首 ❯ / ! 和它后面那一个空格，多行用换行连；行首多出的空格保留，调用方比原文）；没有输入框时是空串 */
  inputText: string;
  /**
   * 稳定接口（T36 注入闸门看它）：底部被模态占着——没有输入框（额度菜单、权限框、AUQ、Rewind、各种确认框、认不出的画面），
   * 或者底部有编号菜单 / 菜单提示；输入框上方有像菜单的字（对话里的引用）也算，此时 lowPriority 为 unknown。为 true 时任何调用方都不该往这个窗口按键
   */
  modal: boolean;
  /** 模态里认得出的编号选择菜单（额度菜单等），认不出 = null */
  menu: PaneMenu | null;
  /** unknown 的原因，给界面和拒绝理由用 */
  reason?: string;
}

export const LP_MENU_LABEL = "Continue now at lower priority";
/** 认额度菜单（撞墙后的「What do you want to do?」）：标题是通用的，只能看选项 */
const RATE_MENU_LABELS: readonly string[] = ["Stop and wait for limit to reset", "Switch to usage credits", "Wait here, then continue automatically", LP_MENU_LABEL];
const isRateMenu = (m: PaneMenu | null) => !!m && m.options.some((o) => RATE_MENU_LABELS.includes(o.label));

const ANSI_RE = /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g;
export function stripAnsi(s: string): string {
  return s.replace(ANSI_RE, "");
}

/** 弯引号统一成直的：CC 的菜单文案用「Don’t」，默认常量里是「Don't」 */
const norm = (s: string) => s.replace(/[’‘]/g, "'").replace(/\s+/g, " ").trim();

/** 输入框的横线边框和提示符都顶格（第 0 列）；对话、工具输出、代码块里同样的字都有缩进，不能被当成输入框 */
const BORDER_RE = /^─{8,}/;
/** ❯ = 普通输入；! = bash 模式（这时敲进去的 /compact 会被当成 shell 命令跑） */
const PROMPT_RE = /^[❯!]/;
const TAIL_LINES = 60;

interface Parts { top: number; above: string[]; inputPlain: string[]; inputAnsi: string[]; footer: string[] }

/** 找输入框：最下面一条顶格横线往上找最近的一条顶格横线，且它下一行顶格是提示符；草稿多长都行 */
function splitPane(ansiLines: string[], plain: string[]): Parts | null {
  const start = Math.max(0, plain.length - TAIL_LINES);
  for (let bottom = plain.length - 1; bottom > start; bottom--) {
    if (!BORDER_RE.test(plain[bottom]!)) continue;
    for (let top = bottom - 1; top >= start; top--) {
      if (!BORDER_RE.test(plain[top]!)) continue;
      if (!PROMPT_RE.test(plain[top + 1] ?? "")) break;
      return {
        top,
        above: plain.slice(start, top),
        inputPlain: plain.slice(top + 1, bottom),
        inputAnsi: ansiLines.slice(top + 1, bottom),
        footer: plain.slice(bottom + 1),
      };
    }
    return null; // 最下面那条横线不是输入框下沿：底部被别的东西占着
  }
  return null;
}

/**
 * 模态自带的操作提示（权限框「Esc to cancel · Tab to amend」、AUQ「Enter to select · ↑/↓ to navigate」、Rewind「Enter to continue」）。
 * 大小写敏感：撞墙状态栏里的是小写「esc to cancel」，不算
 */
const MODAL_HINT_RE = /Enter to (?:confirm|select|continue)|Esc to cancel|Tab to amend|↑\/↓ to navigate/;
const OPTION_LINE_RE = /^\s*(?:❯\s*)?\d+\.\s+\S/;
/** 找到的「输入框」其实是对话框：提示符那行是编号选项，框内 / 框下有菜单提示，或框下有编号选项行 */
const boxIsModal = (p: Parts) =>
  OPTION_LINE_RE.test((p.inputPlain[0] ?? "").slice(1)) ||
  [...p.inputPlain, ...p.footer].some((l) => MODAL_HINT_RE.test(l)) ||
  p.footer.some((l) => OPTION_LINE_RE.test(l));

/** 编号选择菜单（额度菜单等）：「Enter to confirm · Esc to cancel」往上收编号项，直到标题行；title = 标题行在 plain 里的下标 */
function locateMenu(plain: string[]): { menu: PaneMenu; title: number } | null {
  const base = Math.max(0, plain.length - 20);
  const tail = plain.slice(base);
  const end = tail.findIndex((l) => /Enter to confirm\s*·\s*Esc to cancel/.test(l));
  if (end < 0) return null;
  const options: MenuOption[] = [];
  let i = end - 1;
  for (; i >= 0; i--) {
    if (!tail[i]!.trim()) continue; // 选项块上下各有一行空行
    const m = /^\s*(❯\s*)?(\d+)\.\s+(.+?)\s*$/.exec(tail[i]!);
    if (!m) break;
    options.unshift({ n: Number(m[2]), label: norm(m[3]!), selected: !!m[1] });
  }
  if (!options.length) return null;
  return { menu: { title: norm(tail[i] ?? ""), options }, title: base + Math.max(i, 0) };
}

export function parseMenu(plain: string[]): PaneMenu | null {
  return locateMenu(plain)?.menu ?? null;
}

/** 真菜单的上沿是一整条顶格的 ▔（标题上面，中间最多隔空行）；对话里引用的菜单有缩进，没有这条 */
function hasMenuTop(plain: string[], title: number): boolean {
  for (let i = title - 1; i >= Math.max(0, title - 3); i--) {
    if (/^▔{8,}/.test(plain[i]!)) return true;
    if (plain[i]!.trim()) return false;
  }
  return false;
}

/**
 * 看输入框：空 / 第一行全是暗色（CC 的灰字提示，打字会直接替换）= empty；有正常颜色的字、多行、bash 模式 = draft；
 * 带着「Press up to edit queued messages」= queued；没带颜色抓的分不清灰字和草稿 = unknown
 */
export function inputStateOf(inputPlain: string[], inputAnsi: string[]): InputState {
  const first = inputPlain[0] ?? "";
  if (/Press up to edit queued messages/.test(inputPlain.join(" "))) return "queued";
  if (first.startsWith("!")) return "draft";
  if (inputPlain.slice(1).some((l) => l.trim())) return "draft";
  if (!first.slice(1).trim()) return "empty";
  const ansi = inputAnsi[0];
  if (ansi === undefined || !ansi.includes("\x1b[")) return "unknown";
  return visibleUndimmed(ansi.slice(ansi.indexOf("❯") + 1)) ? "draft" : "empty";
}

function visibleUndimmed(s: string): boolean {
  let dim = false;
  for (const m of s.matchAll(/\x1b\[([0-9;]*)m|([^\x1b]+)/g)) {
    if (m[1] !== undefined) {
      const codes = m[1] === "" ? [0] : m[1].split(";").map(Number);
      for (const c of codes) if (c === 2) dim = true; else if (c === 0 || c === 22) dim = false;
    } else if (m[2] && m[2].trim() && !dim) return true;
  }
  return false;
}

/** 重置时刻：「3:20am」，也可能带日期「Oct 1, 3:20am」 */
const AT = "((?:[A-Z][a-z]{2} \\d{1,2},? )?[^\\s·]+)";
const LP_ON_RE = new RegExp(`Lower priority until\\s+${AT}`);
const ALLOWANCE_RE = /(\d{1,3})% allowance left/;
const OFFER_RE = /\/low-priority to continue now at lower priority/;
const EXHAUSTED_RE = /You've used this week's lower-priority allowance/;
const WAITING_RE = /Working at lower priority/;
const WALLED_RE = new RegExp(`Usage limit reached · continuing (?:automatically(?: at ${AT}| when it resets)?|shortly)`);
/** 状态栏里提到 LP 却一条已知文案都没对上 = CC 改了字，判 unknown */
const LP_MENTION_RE = /low-priority|lower[ -]priority/i;

/**
 * 回合进行中：输入框以上整个可见区里有回合 spinner 行（spinner 下面可能挂着很长的 todo 列表，所以不限行数）。
 * 只认顶格、spinner 字形开头的行：对话（⏺ 开头、续行缩进）、工具输出（⎿）、缩进的 markdown 列表里出现同样的字
 * （「esc to interrupt」「跑测试… (约 30s)」）不算。撞墙提示自带的「esc (or type) to cancel」先抹掉（不分大小写）再判
 */
const SPINNER_LINE_RE = /^[·✢✳✶✻✽*]\s/;
function busyAbove(above: string[]): boolean {
  return above.some((l) => SPINNER_LINE_RE.test(l) && CC_BUSY_RE.test(l.replace(/esc (?:or type )?to cancel/gi, "")));
}

/** 真 CC 的提示符是「❯」加 U+00A0：NBSP 一律当普通空格，否则去掉提示符后开头还剩一个 NBSP，逐字比对永远对不上（tests/lp-state.test.ts 真实样本） */
const inputTextOf = (lines: string[]) =>
  lines.map((l) => l.replace(/\u00a0/g, " ")).map((l, i) => (i ? l.replace(/^ {1,2}/, "") : l.slice(1).replace(/^ /, ""))).join("\n").trimEnd();

/**
 * 模态时的结果：只有底部真额度菜单（顶格 ▔ 上沿、下面没有输入框）才算撞墙，有 LP 项算「关、能开」（只是 runner 不会去按它）；
 * 其余 unknown。menu 为 null、reason 给了 = 输入框上方有像菜单的字（多半是对话里的引用）：认不准，照样不按键
 */
function modalRead(menu: PaneMenu | null, hint: boolean, quoted?: string): LpRead {
  const base = { offer: false, walled: isRateMenu(menu), busy: false, compacting: false, input: "unknown", inputText: "", modal: true, menu } as const;
  const what = base.walled ? "额度菜单" : menu || hint ? "选项菜单" : "对话框（权限框 / AUQ / Rewind 等）或认不出的画面";
  const reason = quoted ?? `底部是${what}`;
  if (menu?.options.some((o) => o.label === LP_MENU_LABEL)) return { ...base, lowPriority: "off", offer: true, reason };
  return { ...base, lowPriority: "unknown", reason };
}

/** 主入口：`capture-pane -p -e` 的原文（不带 -e 也能判，只是分不清输入框里的灰字和草稿） */
export function readLpPane(raw: string): LpRead {
  const ansiLines = raw.replace(/\s+$/, "").split("\n");
  const plain = ansiLines.map(stripAnsi);
  // 不管找没找到输入框，先看有没有菜单：可见区里有一段像输入框的文字时，不能因此漏掉真正的菜单
  const found = locateMenu(plain);
  const hintAt = plain.findLastIndex((l, i) => i >= plain.length - 20 && /Enter to confirm/.test(l));
  const box = splitPane(ansiLines, plain);
  const realBox = box && !boxIsModal(box) ? box : null;
  // 菜单字样只出现在真输入框上方 = 对话里的引用：不按键，但也不能据此判「关、撞墙」
  if (realBox && hintAt >= 0 && hintAt < realBox.top) return modalRead(null, true, "输入框上方有像菜单的字（多半是对话里的引用），认不准");
  const parts = realBox && hintAt < 0 ? realBox : null;
  if (!parts) return modalRead(found && hasMenuTop(plain, found.title) ? found.menu : null, hintAt >= 0);
  const footer = norm(parts.footer.join(" "));
  const busy = busyAbove(parts.above);
  const compacting = /Compacting conversation/.test(parts.above.join("\n"));
  const input = inputStateOf(parts.inputPlain, parts.inputAnsi);
  const walledM = WALLED_RE.exec(footer);
  const common = { busy, compacting, input, inputText: inputTextOf(parts.inputPlain), modal: false, menu: null, walled: !!walledM, offer: OFFER_RE.test(footer) };
  if (EXHAUSTED_RE.test(footer)) return { ...common, lowPriority: "exhausted", offer: false, reason: "本周 low-priority 额度已用完" };
  const on = LP_ON_RE.exec(footer);
  if (on) {
    const pct = ALLOWANCE_RE.exec(footer);
    return { ...common, lowPriority: "on", resetsAt: on[1], ...(pct ? { allowancePct: Number(pct[1]) } : {}) };
  }
  if (common.offer || walledM) return { ...common, lowPriority: "off", ...(walledM?.[1] ? { resetsAt: walledM[1] } : {}) };
  if (WAITING_RE.test(footer)) return { ...common, lowPriority: "on" };
  if (LP_MENTION_RE.test(footer)) return { ...common, lowPriority: "unknown", reason: "状态栏的 low-priority 字样认不出（CC 可能改了文案）" };
  return { ...common, lowPriority: "off", ...(lastLpEcho(raw, false)?.echo === "off" ? { resumable: true } : {}) };
}

// ── 发完 /low-priority 之后的回显 ──

export type LpEcho = "accepted" | "resumed" | "off" | "unavailable" | "break" | "exhausted";
const ECHOES: [LpEcho, RegExp][] = [
  ["accepted", /Continuing now at lower priority/],
  ["resumed", /Lower-priority mode is back on/],
  ["off", /Lower-priority mode is off/],
  ["unavailable", /Lower-priority mode isn't available right now/],
  ["break", /Lower-priority mode is taking a break until/],
  ["exhausted", /offered again after your weekly limit resets/],
];

/** 已提交的命令行和输入框一样顶格；对话里引用的「❯ /low-priority」有缩进，不算 */
const LP_CMD_RE = /^❯\s*\/(?:low-priority|rate-limit-options)\s*$/;

/** 命令行下面到下一个输入行 / 边框之前的那几行里的回显 */
function echoAfter(plain: string[], from: number): { echo: LpEcho; text: string } | null {
  const seg: string[] = [];
  for (const l of plain.slice(from + 1, from + 10)) {
    if (/^(?:❯|─{8,})/.test(l)) break;
    seg.push(l);
  }
  const after = norm(seg.join(" "));
  for (const [echo, re] of ECHOES) {
    const m = re.exec(after);
    if (m) return { echo, text: after.slice(m.index, m.index + 160) };
  }
  return null;
}

/**
 * 最后一次输入 /low-priority（或额度菜单）之后的回显。strict（缺省）：只看最后那一次命令——发完复核用，
 * 更早的回显不能拿来冒充这次的结果；strict=false：往上找最近一条有回显的——判「本窗口手动关过」用。
 */
export function lastLpEcho(raw: string, strict = true): { echo: LpEcho; text: string } | null {
  const plain = stripAnsi(raw).split("\n");
  for (let i = plain.length - 1; i >= 0; i--) {
    if (!LP_CMD_RE.test(plain[i]!)) continue;
    const e = echoAfter(plain, i);
    if (e || strict) return e;
  }
  return null;
}

// ── 「设成开 / 设成关」的决策表 ──

export type LpDecision = { kind: "send" } | { kind: "skip"; reason: string } | { kind: "busy"; reason: string } | { kind: "refuse"; reason: string };

const INPUT_BLOCK: Record<Exclude<InputState, "empty">, string> = {
  draft: "输入框里有没发出去的文字，没动",
  queued: "输入框里有排队的消息，没动",
  unknown: "看不清输入框是否为空，没动",
};

export function decideLp(want: "on" | "off", r: LpRead): LpDecision {
  // 画面上有任何菜单 / 对话框都不按键，Esc 也不按：回车、数字、Esc 在别人的对话框里都有副作用（PM 09-29 定）
  if (r.modal) {
    if (want === "off" && isRateMenu(r.menu)) return { kind: "skip", reason: "额度菜单开着，LP 本来就是关的" };
    const hand = want === "on" && r.offer ? "（要开的话请在菜单里手动选「Continue now at lower priority」）" : "";
    return { kind: "refuse", reason: `${r.reason ?? "底部没有输入框"}，没按任何键${hand}` };
  }
  if (r.lowPriority === "unknown") return { kind: "refuse", reason: `状态不明：${r.reason ?? "认不出画面"}` };
  if (r.compacting) return { kind: "skip", reason: "正在压缩" };
  if (r.busy) return { kind: "busy", reason: "忙，未发（回合结束后再试；排队的开关可能切反）" };
  if (want === "on") {
    if (r.lowPriority === "on") return { kind: "skip", reason: "已经是开" };
    if (r.lowPriority === "exhausted") return { kind: "refuse", reason: "本周 low-priority 额度已用完，开不了" };
    if (!r.offer && !r.resumable) return { kind: "refuse", reason: r.walled ? "撞墙了但 CC 这次没提供 low-priority" : "这个会话没撞墙，现在开不了（CC 只在撞墙后提供 low-priority）" };
  } else if (r.lowPriority !== "on") {
    return { kind: "skip", reason: "已经是关" };
  }
  if (r.input !== "empty") return { kind: "refuse", reason: INPUT_BLOCK[r.input] };
  return { kind: "send" };
}

// ── T36 上下文边界的注入闸门用的精简视图（lib/ctx-boundary-decision.ts）：字段或签名要改，先通知 T36 ──

/**
 * wall = 撞墙等待中（额度菜单开着也算）；exhausted 时 lp 报 off；menu = LpRead.modal（底部被任何模态占着）；
 * draft = 输入框不是确定的空（草稿、排队、看不清都算）：tmux 按字面敲字会把草稿连着命令一起提交
 */
export type PaneQuotaState = { wall: boolean; lp: "on" | "off" | "unknown"; exhausted: boolean; menu: boolean; compacting: boolean; draft: boolean };

/** 调用方抓一张 `capture-pane -p -e` 传 escaped（plain 由它去色得到，传不传都行）；escaped 为空才退回 plain，此时输入框判不清、draft 为真 */
export function paneQuotaState(plain: string, escaped: string): PaneQuotaState {
  const r = readLpPane(escaped.trim() ? escaped : plain);
  const exhausted = r.lowPriority === "exhausted";
  return {
    wall: r.walled, lp: r.lowPriority === "exhausted" ? "off" : r.lowPriority, exhausted,
    menu: r.modal, compacting: r.compacting, draft: r.input !== "empty",
  };
}
