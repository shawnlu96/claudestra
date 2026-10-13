/**
 * AskUserQuestion 弹框的「代」（hardening-AUQID1）：一张卡只对它注册时那一个弹框有效。
 *
 * 身份 = 完整问题 / 选项（文字与描述）/ 多选规则 + 可信现场（会话 id、tmux pane id、窗口 id 与名字）。光标位、已勾选项、
 * tab 栏上哪一段答过是渲染变化，不进身份。文字比原文：卡片上截到 100 字是显示上限，JSONL 的原文另记（keepAuqOptionText），
 * 原文不明的段什么都对不上；Pi / Codex 的解析自己会截，顶到上限时身份另带弹框那几行的原样（cappedRaw）。
 * JSONL 与 pane 两路观察、API 与 Discord 两路作答、逐键发送共用这里的同一套比对：
 * 读不到 pane、身份对不上、pane 换了，一律不发键（不退回盲发，也不按名字另找窗口）。
 *
 * 剩余边界：最后一次观察与 tmux 执行这一键之间，终端里的人或程序仍可能换掉弹框——tmux 没有「画面仍是这样才发」的原子条件。
 * 这一键在服务器端只带窗口绑定 / pane 存活条件（lib/tmux-send-guard.ts）。抓屏期间换了会话 / pane 归属的那一屏不算数
 * （capture 抓完重读现场）。tests/auq-audit-identity*.test.ts。
 */
import { parseAuqPane, parseAuqTabSections, parseCodexSelectPane, parsePiSelectPane, type AuqPaneParse } from "./auq-pane.js";
import { SEND_REFUSED, sendCondition } from "./tmux-send-guard.js";
import { pinSendTarget } from "./tmux-send-target.js";

export interface AuqQuestionLike {
  question: string;
  header?: string;
  options: { label: string; description?: string }[];
  multiSelect?: boolean;
}

/** 弹框所在的现场。pane id 在 tmux server 的一生里不复用：pane 没了键只会被拒，不会落到别处 */
export interface AuqDialogTarget {
  session: string;
  pane: string;
  windowId: string;
  windowName: string;
}

export interface AuqDialogIdentity {
  target: AuqDialogTarget;
  /** tab 栏的段名；没有 tab 栏（单问单选、Pi / Codex 选择框）为 null */
  tabs: string[] | null;
  /** 一问的弹框：注册时那一屏的完整渲染身份（之后屏对屏逐字比） */
  screen: string | null;
  /** 多问的弹框：每一段的身份（屏上只看得到当前段） */
  sections: AuqSectionIdentity[];
}

export interface AuqSectionIdentity {
  /** 问题、多选规则、选项文字的原文（sectionKey）；有选项原文不明 = null，这一段什么都对不上 */
  key: string | null;
  /** JSONL 里每个选项描述的原文：没在屏上见过的段拿它比 */
  described: string[];
  /** 注册时就在屏上的那一段：选项文字 + 描述的渲染原样，之后屏对屏逐字比；没见过 = null */
  seen: string | null;
}

/**
 * query：tmuxRawStrict 语义，非零退出 / 超时必须抛。session：registry 里这个 agent 的会话 id（没有 = ""）。
 * locked：按窗口的跨进程发键锁（tmux-helper 的 tmuxSendEscape.locked）——gate 抛错 = 不发；别的受闸发键 / Esc 插不进 gate 与 send 之间。
 */
export interface AuqIo {
  query(args: string[]): Promise<string>;
  session(): Promise<string>;
  locked(target: string, gate: () => Promise<void>, send: () => Promise<void>): Promise<void>;
  sleep(ms: number): Promise<void>;
}

export type AuqObservation =
  | { kind: "unreadable"; why: string }
  | { kind: "none"; target: AuqDialogTarget }
  /** tab 栏在、当前是 Submit(Review) 段：没有可解析的选项 */
  | { kind: "review"; target: AuqDialogTarget; tabs: string[] }
  /** raw：解析截过文字的弹框（Pi / Codex）那几行的原样，没截 = 不带 */
  | { kind: "dialog"; target: AuqDialogTarget; tabs: string[] | null; parse: AuqPaneParse; raw?: string };

const CAPTURE_LINES = 40;
const TABBAR_RE = /^\s*←\s+.*✔\s*Submit\s+→\s*$/;
const collapse = (s: string | undefined): string => (s ?? "").replace(/\s+/g, " ").trim();

/** 卡片 / Pi、Codex 解析对选项文字与描述、问题的显示上限 */
const SHOWN_MAX = 100, QUESTION_MAX = 300;

type OptionText = { label: string; description?: string };
const fullText = new WeakMap<object, OptionText>();

/** shown = 进卡片的选项（文字已截到显示上限）；full = 它的原文，身份拿原文比 */
export function keepAuqOptionText<T extends object>(shown: T, full: OptionText): T {
  fullText.set(shown, full);
  return shown;
}

/** 选项的原文；没记原文而文字顶到了显示上限 = 可能截过，原文不明 */
function optionText(o: OptionText): OptionText | null {
  return fullText.get(o) ?? (o.label.length >= SHOWN_MAX || (o.description?.length ?? 0) >= SHOWN_MAX ? null : o);
}

/** 屏上这一段选项的渲染原样（文字 + 描述）：不含光标、勾选 */
const optionsKey = (parse: AuqPaneParse): string => JSON.stringify(parse.options.map((o) => [o.label, o.description ?? ""]));

/** 屏上这一段的完整渲染身份：不含光标、勾选 */
function screenKey(obs: Extract<AuqObservation, { kind: "dialog" }>): string {
  const { parse } = obs;
  return JSON.stringify([parse.form, obs.tabs ?? parse.sections, parse.question, parse.multiSelect, optionsKey(parse), obs.raw ?? ""]);
}

/** 一段的身份里 JSONL 的原文与 pane 的渲染都能算出来的部分：问题、多选规则、选项文字；pane 把折行拼成空格，所以空白归一。描述另比（sectionOnScreen） */
const sectionKey = (question: string, multiSelect: boolean, labels: string[]): string => JSON.stringify([collapse(question), multiSelect, labels.map(collapse)]);

/** JSONL 里的一问 → 这一段的身份（还没在屏上见过） */
function sectionOf(q: AuqQuestionLike): AuqSectionIdentity {
  const texts = q.options.map(optionText);
  const known = texts.every((t) => t !== null);
  return { key: known ? sectionKey(q.question, !!q.multiSelect, texts.map((t) => t!.label)) : null, described: texts.map((t) => collapse(t?.description)), seen: null };
}

/**
 * Pi / Codex 的解析把问题截到 300 字、选项文字 / 描述截到 100 字。有一样顶到上限时，返回弹框那几行的原样（去掉光标、空白归一）：
 * 截掉的尾巴变了也认得出。问题起始行找不到就取整屏（宁可多拒）。CC 的解析不截，不带。
 */
function cappedRaw(text: string): string | undefined {
  const parse = parsePiSelectPane(text) ?? parseCodexSelectPane(text);
  if (!parse) return undefined;
  if (parse.question.length < QUESTION_MAX && parse.options.every((o) => o.label.length < SHOWN_MAX && (o.description?.length ?? 0) < SHOWN_MAX)) return undefined;
  const lines = text.split("\n").map((l) => collapse(l.replace(/[→›]/g, ""))).filter(Boolean);
  const from = lines.findLastIndex((l) => parse.question.startsWith(l));
  return lines.slice(Math.max(from, 0)).join("\n");
}

const sameTabs = (a: string[] | null, b: string[] | null): boolean => JSON.stringify(a?.map(collapse) ?? null) === JSON.stringify(b?.map(collapse) ?? null);

export function sameAuqTarget(a: AuqDialogTarget, b: AuqDialogTarget): boolean {
  return a.session === b.session && a.pane === b.pane && a.windowId === b.windowId && a.windowName === b.windowName;
}

function readScreen(text: string, target: AuqDialogTarget): AuqObservation {
  const lines = text.split("\n");
  const bar = lines.slice(-(CAPTURE_LINES + 5)).reverse().find((l) => TABBAR_RE.test(l));
  const parse = parseAuqPane(text);
  if (parse) {
    const raw = cappedRaw(text);
    return { kind: "dialog", target, tabs: parse.form === "tabbed" ? parse.sections : null, parse, ...(raw === undefined ? {} : { raw }) };
  }
  return bar ? { kind: "review", target, tabs: parseAuqTabSections(bar) } : { kind: "none", target };
}

const failed = (e: unknown): AuqObservation => ({ kind: "unreadable", why: e instanceof Error ? e.message : String(e) });

/** 钉住的 pane 现在的窗口归属；pane 不在 / 已死 = null（查询本身出错照抛） */
async function paneRow(io: AuqIo, pane: string): Promise<{ windowId: string; windowName: string } | null> {
  const out = await io.query(["list-panes", "-t", pane, "-F", "#{pane_id}\t#{pane_dead}\t#{window_id}\t#{window_name}"]);
  const row = out.split("\n").map((l) => l.split("\t")).find((r) => r[0] === pane);
  return row && row[1] === "0" && row[2] ? { windowId: row[2], windowName: row[3] ?? "" } : null;
}

/**
 * 抓屏，抓完重读现场：会话 id、pane 的窗口归属（按名字来的还要名字仍解析到这个 pane）有一样和抓之前不同，
 * 这一屏就跨了一次换代，不知道属于谁 = 读不到。
 */
async function capture(io: AuqIo, target: AuqDialogTarget, nameTarget?: string): Promise<AuqObservation> {
  const text = await io.query(["capture-pane", "-t", target.pane, "-p", "-J", "-S", `-${CAPTURE_LINES}`]);
  const row = await paneRow(io, target.pane);
  const after: AuqDialogTarget | null = row && { session: await io.session(), pane: target.pane, ...row };
  if (!after || !sameAuqTarget(target, after)) return { kind: "unreadable", why: "session or pane changed during capture" };
  if (nameTarget !== undefined && (await pinSendTarget(nameTarget, io.query, false)) !== target.pane) return { kind: "unreadable", why: "target moved during capture" };
  return readScreen(text, target);
}

/** 按名字解析当前现场再读屏：注册新代、作答入口用。名字解析不到唯一 pane = 读不到 */
export async function observeAuqByName(io: AuqIo, nameTarget: string): Promise<AuqObservation> {
  try {
    const pane = await pinSendTarget(nameTarget, io.query, false);
    if (pane === null) return { kind: "unreadable", why: "target resolves to no single pane" };
    const row = await paneRow(io, pane);
    if (!row) return { kind: "unreadable", why: `pane ${pane} is gone` };
    return await capture(io, { session: await io.session(), pane, ...row }, nameTarget);
  } catch (e) {
    return failed(e);
  }
}

/** 只读注册时钉住的那个 pane：它没了就是读不到，不改按名字找 */
export async function observeAuqPinned(io: AuqIo, pinned: AuqDialogTarget): Promise<AuqObservation> {
  try {
    const row = await paneRow(io, pinned.pane);
    if (!row) return { kind: "unreadable", why: `pane ${pinned.pane} is gone` };
    return await capture(io, { session: await io.session(), pane: pinned.pane, ...row });
  } catch (e) {
    return failed(e);
  }
}

/** pane 上这一问翻成卡片用的问题（一问的弹框选项全可见） */
export function auqQuestionFromScreen(parse: AuqPaneParse): Required<Pick<AuqQuestionLike, "question" | "header" | "options" | "multiSelect">> {
  return {
    question: parse.question,
    header: (parse.sections[0] || "").slice(0, 12),
    options: parse.options.map((o) => ({ label: o.label.slice(0, 100), description: o.description ? o.description.slice(0, 100) : undefined })),
    multiSelect: parse.multiSelect,
  };
}

/** pane 上看得到描述的选项必须和 JSONL 的原文逐字对上（没渲染描述的无从比） */
function descriptionAgrees(described: string[], parse: AuqPaneParse): boolean {
  return parse.options.every((o, i) => o.description === undefined || collapse(o.description) === (described[i] ?? ""));
}

const parsedKey = (parse: AuqPaneParse): string => sectionKey(parse.question, parse.multiSelect, parse.options.map((o) => o.label));

/** 屏上这一段是不是登记的这一段：见过的屏对屏比选项文字 + 描述，没见过的拿 JSONL 的原文比看得到的 */
function sectionOnScreen(sec: AuqSectionIdentity, parse: AuqPaneParse): boolean {
  if (sec.key === null || parsedKey(parse) !== sec.key) return false;
  return sec.seen !== null ? optionsKey(parse) === sec.seen : descriptionAgrees(sec.described, parse);
}

/**
 * JSONL 里读到的这组问题是不是屏上这个弹框：一问的要问题 / 选项 / 多选规则都对上；多问的要 tab 栏段名逐个对上、当前段是其中一问。比的是选项原文。
 * 对不上 = 这条 tool_use 说的是另一个（多半已答掉的）弹框，不能拿它的文字给屏上这个开卡。
 */
export function auqQuestionsOnScreen(questions: AuqQuestionLike[], obs: AuqObservation): boolean {
  if (obs.kind !== "dialog" || questions.length === 0) return false;
  if (!questions.some((q) => sectionOnScreen(sectionOf(q), obs.parse))) return false;
  if (questions.length === 1) return (obs.tabs?.length ?? 1) === 1;
  return sameTabs(obs.tabs, questions.map((q) => q.header ?? ""));
}

/** 注册一代：obs 必须是这组问题当前在屏上的那个弹框 */
export function auqDialogIdentity(questions: AuqQuestionLike[], obs: Extract<AuqObservation, { kind: "dialog" }>): AuqDialogIdentity {
  if (questions.length === 1) return { target: obs.target, tabs: obs.tabs, screen: screenKey(obs), sections: [] };
  const sections = questions.map(sectionOf);
  const shown = sections.find((sec) => sectionOnScreen(sec, obs.parse));
  if (shown) shown.seen = optionsKey(obs.parse);
  return { target: obs.target, tabs: obs.tabs, screen: null, sections };
}

/**
 * 屏上还是不是这一代。fresh = 发第一个键之前：必须停在可解析的问题段上（多问的要在第一段——键序列按全新弹框算）；
 * midway = 观察器保卡、键序列中途：tab 栏对得上时允许停在 Submit(Review) 段，多问的允许在任一段。
 */
export function sameAuqDialog(id: AuqDialogIdentity, obs: AuqObservation, phase: "fresh" | "midway"): boolean {
  if (obs.kind === "unreadable" || obs.kind === "none" || !sameAuqTarget(id.target, obs.target)) return false;
  if (obs.kind === "review") return phase === "midway" && id.tabs !== null && sameTabs(id.tabs, obs.tabs);
  if (id.screen !== null) return screenKey(obs) === id.screen;
  if (!sameTabs(id.tabs, obs.tabs)) return false;
  const { parse } = obs;
  const at = id.sections.findIndex((sec) => sectionOnScreen(sec, parse));
  return phase === "fresh" ? at === 0 : at >= 0;
}

/**
 * 一个键的 tmux 命令：发给钉住的 pane id，并在同一条命令里由 server 核窗口仍绑在原来的 id / 名字上、pane 没死
 * （lib/tmux-send-guard.ts 的条件）。名字写不进 tmux 格式时只留 pane 存活条件——pane id 本身已经钉死目标。
 */
function auqKeyArgs(target: AuqDialogTarget, key: string): string[] {
  if (!/^[A-Za-z0-9-]+$/.test(key) || !/^%\d+$/.test(target.pane)) throw new Error("auq key send cannot express this key or pane");
  let condition = "#{==:#{pane_dead},0}";
  try {
    condition = sendCondition(target.windowId, target.windowName, false);
  } catch (e) {
    console.warn(`⚠ AUQ 发键条件只核 pane 存活（${target.pane}）：${(e as Error).message}`);
  }
  return ["if-shell", "-F", "-t", target.pane, condition, `send-keys -t '${target.pane}' ${key}`, `display-message -p ${SEND_REFUSED}`];
}

export interface AuqSendResult {
  /** 确认发出去的键数 */
  sent: number;
  /** 停下的原因；null = 全部发完 */
  stopped: string | null;
}

/**
 * 逐键发送。每一键：拿窗口锁 → 重读钉住的 pane、核仍是同一代（current：登记着的仍是这一代）→ 带条件发出。
 * 任何一步对不上 / 读不到 / 结果不明就停，后面的键不发。键间隔 120ms：批发会被 AUQ 组件吞掉前面的导航键。
 */
export async function sendAuqKeysChecked(io: AuqIo, id: AuqDialogIdentity, keys: string[], current: () => boolean, gapMs = 120): Promise<AuqSendResult> {
  let sent = 0;
  for (const key of keys) {
    const phase = sent === 0 ? "fresh" : "midway";
    try {
      await io.locked(id.target.pane, async () => {
        const obs = await observeAuqPinned(io, id.target);
        if (!sameAuqDialog(id, obs, phase)) throw new Error(obs.kind === "unreadable" ? `pane unreadable: ${obs.why}` : "dialog changed");
        if (!current()) throw new Error("dialog superseded");
      }, async () => {
        const out = (await io.query(auqKeyArgs(id.target, key))).trim();
        if (out === SEND_REFUSED) throw new Error("window rebound or pane dead when the key was due");
        if (out) throw new Error("send result unknown");
      });
    } catch (e) {
      return { sent, stopped: e instanceof Error ? e.message : String(e) };
    }
    sent++;
    await io.sleep(gapMs);
  }
  return { sent, stopped: null };
}
