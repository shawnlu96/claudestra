/**
 * Claude Code 的 low-priority（LP）状态：从一次 `capture-pane -p -e` 的画面判出来。
 * statusLine 喂的 JSON 里没有这个状态（CC 2.1.283 只给 rate_limits 的用量和重置时刻），LP 只活在 CC 进程内存里，
 * 所以只能读画面。只认输入框下沿以下的状态栏：对话里出现同样的字（讨论这个功能时）不能算数。
 * 文案来自 CC 远程配置，默认值见下面的常量；认不出的 LP 字样一律判 unknown，宁可拒绝也不盲发——
 * `/low-priority` 是开关，判错一次就把开着的切成关。样本在 tests/fixtures/lp/，用例见 tests/lp-state.test.ts。
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
  /** 撞墙等待中（「Usage limit reached · continuing automatically …」） */
  walled: boolean;
  /** 重置时刻原文（「3:20am」），LP 开着时取 LP 行，否则取撞墙行 */
  resetsAt?: string;
  /** LP 开着时状态栏带的「91% allowance left」 */
  allowancePct?: number;
  /** 输入框上方有 spinner（回合进行中）；撞墙等待不算忙 */
  busy: boolean;
  compacting: boolean;
  input: InputState;
  /** 底部被模态占着、没有输入框：额度菜单、权限框、AUQ、Rewind、各种确认框，或画面认不出 */
  modal: boolean;
  /** 模态里认得出的编号选择菜单（额度菜单等），认不出 = null */
  menu: PaneMenu | null;
  /** unknown 的原因，给界面和拒绝理由用 */
  reason?: string;
}

export const LP_MENU_LABEL = "Continue now at lower priority";
export const LP_WAIT_LABEL = "Wait here, then continue automatically";
/** runner 在菜单里只许按精确文案选这两项；其余（Switch to usage credits / Upgrade / Team plan / 领 credit）任何情况都不选 */
const MENU_ALLOWED_LABELS: readonly string[] = [LP_MENU_LABEL, LP_WAIT_LABEL];
/** 认额度菜单（撞墙后的「What do you want to do?」）：标题是通用的，只能看选项；别的确认框（切模型、bypass 首启）不许当它处理 */
const RATE_MENU_LABELS: readonly string[] = ["Stop and wait for limit to reset", "Switch to usage credits", ...MENU_ALLOWED_LABELS];
const isRateMenu = (m: PaneMenu | null) => !!m && m.options.some((o) => RATE_MENU_LABELS.includes(o.label));

const ANSI_RE = /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g;
export function stripAnsi(s: string): string {
  return s.replace(ANSI_RE, "");
}

/** 弯引号统一成直的：CC 的菜单文案用「Don’t」，默认常量里是「Don't」 */
const norm = (s: string) => s.replace(/[’‘]/g, "'").replace(/\s+/g, " ").trim();

const BORDER_RE = /^\s*─{8,}/;
const TAIL_LINES = 60;

interface Parts { above: string[]; inputPlain: string[]; inputAnsi: string[]; footer: string[] }

/** 找输入框：尾部最后一对横线边框，且上框下一行以 ❯ 开头；找不到 = 被模态菜单或别的画面占着 */
function splitPane(ansiLines: string[], plain: string[]): Parts | null {
  const start = Math.max(0, plain.length - TAIL_LINES);
  for (let bottom = plain.length - 1; bottom > start; bottom--) {
    if (!BORDER_RE.test(plain[bottom]!)) continue;
    for (let top = bottom - 1; top >= start && top >= bottom - 12; top--) {
      if (!BORDER_RE.test(plain[top]!)) continue;
      if (!/^\s*❯/.test(plain[top + 1] ?? "")) break;
      return {
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
 * 大小写敏感：撞墙状态栏里的是小写「esc to cancel」，不算。输入框位置出现编号选项、或框内 / 框下有这些提示 = 找到的「输入框」其实是对话框
 */
const MODAL_HINT_RE = /Enter to (?:confirm|select|continue)|Esc to cancel|Tab to amend|↑\/↓ to navigate/;
const boxIsModal = (p: Parts) => /^\s*❯\s*\d+\.\s/.test(p.inputPlain[0] ?? "") || MODAL_HINT_RE.test([...p.inputPlain, ...p.footer].join("\n"));

/** 底部的编号选择菜单（额度菜单等）：「Enter to confirm · Esc to cancel」往上收编号项，直到标题行 */
export function parseMenu(plain: string[]): PaneMenu | null {
  const tail = plain.slice(-20);
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
  return { title: norm(tail[i] ?? ""), options };
}

/** 看输入框第一行 ❯ 后面：空 / 全是暗色（CC 的灰字提示，打字会直接替换）= empty；有正常颜色的字 = draft */
export function inputStateOf(inputPlain: string[], inputAnsi: string[]): InputState {
  const first = inputPlain[0] ?? "";
  if (/Press up to edit queued messages/.test(inputPlain.join(" "))) return "queued";
  if (inputPlain.slice(1).some((l) => l.trim())) return "draft";
  const rest = first.replace(/^\s*❯/, "");
  if (!rest.trim()) return "empty";
  const ansi = inputAnsi[0];
  if (ansi === undefined || !ansi.includes("\x1b[")) return "unknown"; // 没带颜色抓的：分不清灰字和草稿
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

const LP_ON_RE = /Lower priority until\s+([^\s·]+)/;
const ALLOWANCE_RE = /(\d{1,3})% allowance left/;
const OFFER_RE = /\/low-priority to continue now at lower priority/;
const EXHAUSTED_RE = /You've used this week's lower-priority allowance/;
const WAITING_RE = /Working at lower priority/;
const WALLED_RE = /Usage limit reached · continuing (?:automatically(?: at ([^\s·]+)| when it resets)?|shortly)/;
/** 状态栏里提到 LP 却一条已知文案都没对上 = CC 改了字，判 unknown */
const LP_MENTION_RE = /low-priority|lower[ -]priority/i;

/** 回合进行中：输入框上方几行里的 spinner。撞墙提示自带「esc to cancel」/「esc or type to cancel」，先抹掉再用通用判据 */
function busyAbove(above: string[]): boolean {
  const text = above.slice(-6).join("\n").replace(/esc (?:or type )?to cancel/g, "");
  return CC_BUSY_RE.test(text);
}

/** 主入口：`capture-pane -p -e` 的原文（不带 -e 也能判，只是分不清输入框里的灰字和草稿） */
export function readLpPane(raw: string): LpRead {
  const ansiLines = raw.replace(/\s+$/, "").split("\n");
  const plain = ansiLines.map(stripAnsi);
  const box = splitPane(ansiLines, plain);
  const parts = box && !boxIsModal(box) ? box : null;
  if (!parts) {
    const menu = parseMenu(plain);
    const base = { offer: false, walled: isRateMenu(menu), busy: false, compacting: false, input: "unknown", modal: true, menu } as const;
    if (menu && menu.options.some((o) => o.label === LP_MENU_LABEL)) return { ...base, lowPriority: "off", offer: true };
    const what = base.walled ? "额度菜单" : menu ? "选项菜单" : "对话框（权限框 / AUQ / Rewind 等）或认不出的画面";
    return { ...base, lowPriority: "unknown", reason: `底部是${what}，没有输入框` };
  }
  const footer = norm(parts.footer.join(" "));
  const busy = busyAbove(parts.above);
  const compacting = /Compacting conversation/.test(parts.above.slice(-6).join("\n"));
  const input = inputStateOf(parts.inputPlain, parts.inputAnsi);
  const walledM = WALLED_RE.exec(footer);
  const common = { busy, compacting, input, modal: false, menu: null, walled: !!walledM, offer: OFFER_RE.test(footer) };
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

const LP_CMD_RE = /^\s*❯\s*\/(?:low-priority|rate-limit-options)\s*$/;

/** 命令行下面到下一个输入行 / 边框之前的那几行里的回显 */
function echoAfter(plain: string[], from: number): { echo: LpEcho; text: string } | null {
  const seg: string[] = [];
  for (const l of plain.slice(from + 1, from + 10)) {
    if (/^\s*(?:❯|─{8,})/.test(l)) break;
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

export type LpDecision =
  | { kind: "send"; via: "command" | "menu" }
  | { kind: "skip"; reason: string }
  | { kind: "busy"; reason: string }
  | { kind: "refuse"; reason: string }
  /** 菜单挡着且没有能选的项：按 Esc 关掉菜单，报失败 */
  | { kind: "escape-fail"; reason: string };

export function decideLp(want: "on" | "off", r: LpRead): LpDecision {
  if (r.modal) {
    // 只有额度菜单能按键（Esc 退出无副作用）；别的对话框一个键都不按——bypass 首启框上 Esc 就是退出 CC
    if (!isRateMenu(r.menu)) return { kind: "refuse", reason: `${r.reason ?? "底部没有输入框"}，没动` };
    if (want === "off") return { kind: "skip", reason: "额度菜单开着，LP 本来就是关的" };
    return r.menu?.options.some((o) => o.label === LP_MENU_LABEL)
      ? { kind: "send", via: "menu" }
      : { kind: "escape-fail", reason: "菜单里没有「Continue now at lower priority」这一项" };
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
  if (r.input === "draft") return { kind: "refuse", reason: "输入框里有没发出去的文字，没动" };
  if (r.input === "unknown") return { kind: "refuse", reason: "看不清输入框是否为空，没动" };
  return { kind: "send", via: "command" };
}

/** 菜单导航：只许朝精确文案的允许项走；返回要按的方向键序列，不允许 / 找不到 = null */
export function menuKeysTo(menu: PaneMenu, label: string): ("Up" | "Down")[] | null {
  if (!MENU_ALLOWED_LABELS.includes(label)) return null;
  const to = menu.options.findIndex((o) => o.label === label);
  const from = menu.options.findIndex((o) => o.selected);
  if (to < 0 || from < 0) return null;
  return Array.from({ length: Math.abs(to - from) }, () => (to > from ? "Down" : "Up"));
}

export function selectedLabel(menu: PaneMenu | null): string | null {
  return menu?.options.find((o) => o.selected)?.label ?? null;
}

// ── T36 上下文边界的注入闸门用的精简视图（lib/ctx-boundary-decision.ts）：字段或签名要改，先通知 T36 ──

/**
 * wall = 撞墙等待中（额度菜单开着也算）；exhausted 时 lp 报 off；menu = 底部被任何模态占着（额度菜单、权限框、AUQ、Rewind……）；
 * draft = 输入框里有正常颜色的字（灰色提示不算），或者看不清输入框——证明不了是空的就当有，tmux 按字面敲字会把草稿连着命令一起提交
 */
export type PaneQuotaState = { wall: boolean; lp: "on" | "off" | "unknown"; exhausted: boolean; menu: boolean; compacting: boolean; draft: boolean };

/** plain / escaped 是同一时刻的 `capture-pane -p` 与 `-p -e`：只按 escaped 判（去色就是 plain），escaped 为空才退回 plain */
export function paneQuotaState(plain: string, escaped: string): PaneQuotaState {
  const r = readLpPane(escaped.trim() ? escaped : plain);
  const exhausted = r.lowPriority === "exhausted";
  return {
    wall: r.walled, lp: r.lowPriority === "exhausted" ? "off" : r.lowPriority, exhausted,
    menu: r.modal, compacting: r.compacting, draft: r.input === "draft" || r.input === "unknown",
  };
}
