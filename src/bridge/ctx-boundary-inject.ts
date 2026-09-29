/**
 * 往 Claude Code 会话里注入一次压缩。自动压缩（ctx-boundary.ts）、Discord 手动按钮、T35 的批量动作都走 injectCompact，
 * 共用一份画面判定（lib/ctx-boundary-decision.ts paneBlock）、一份 15 分钟注入守卫（落盘，bridge 重启也不重复注入）和按窗口的执行权（withWindow）。
 * 敲字和回车分开：敲完再读一次画面，输入框里正好是这条、底部也没冒出对话框才按回车。按窗口大小从长到短挑一档（lib/ctx-boundary-fit.ts），
 * 敲完只看得到后半截（窗口放不下）就删掉、退一档。
 * 设计 docs/architecture/context-boundary.md；单测 tests/ctx-boundary-inject.test.ts（依赖全部可注入）。
 */
import { AsyncLocalStorage } from "node:async_hooks";
import { isMasterAgent } from "../lib/registry.js";
import { statePath } from "../lib/paths.js";
import { readJsonStateSync } from "../lib/state-file.js";
import { MASTER_WINDOW_NAME, MASTER_WINDOW_TARGET, tmuxRawStrict, windowKey, windowTarget } from "../lib/tmux-helper.js";
import { paneLooksWorking, paneShowsApiRetry } from "../lib/turn-state.js";
import { effectiveAction, normalizeCompactKeep, type CompactAction, type CompactKeep } from "../lib/ctx-boundary-policy.js";
import { boxShows, normBox, ourRemainder, sizeText, tierNote, tiersThatFit, type PaneSize } from "../lib/ctx-boundary-fit.js";
import { paneQuotaState, readLpPane, stripAnsi, type PaneQuotaState } from "../lib/lp-state.js";
import { paneBlock, SKIP_REASON_TEXT, type PaneBlock, type PaneGate } from "../lib/ctx-boundary-decision.js";
import { PersistedMap } from "./persisted-map.js";

/** 刚注入过压缩的窗口：15 分钟内谁也不能再注入（手动按钮也不行），看板也不拿它当 /status 抓取源（压缩中 pane 像闲着，抓取会硬中断它） */
const INJECT_GUARD_MS = 15 * 60_000;
const GUARD_FILE = statePath("ctx-boundary-injected.json");
const PENDING_FILE = statePath("ctx-boundary-pending-echo.json");
/** 留在框里的字等多久还没删成（窗口一直不在 / 对话框一直开着）就不管了，落盘文件不留死条目 */
const PENDING_TTL_MS = 24 * 3600_000;
const QUEUED_RE = /Press up to edit queued messages/i;
/** CC 的前台进程名：npm 装的是 claude.exe（09-29 实测）；node 启动的老装法、原生安装器的版本号文件名也算。其余（zsh…）一律不发 */
const CC_COMMAND_RE = /^(claude(\.exe)?|node|\d+\.\d+\.\d+)$/;
/** 敲完字等 CC 画出来：每 200ms 看一次，最多 5 次（186 字的保留清单实测一次就齐） */
const SETTLE_MS = 200;
const SETTLE_TRIES = 5;
/** 退格分批发，每批后核对：一次 send-keys 带上千个 BSpace 会被 tmux 以 command too long 拒掉（1509 字实测删不掉） */
const ERASE_BATCH = 200;

/** 往哪个窗口注入、按不按执行者对待（执行者不跑 save-compact，见 lib effectiveAction） */
export interface InjectTarget {
  name: string;
  target: string;
  executor: boolean;
}

/** agent 的 tmux 窗口名：大总管在 registry 里叫 agent-master，窗口却叫 master，直接拿 registry 名拼 windowTarget 永远读不到它的画面 */
export function agentWindowName(name: string): string {
  return isMasterAgent(name) ? MASTER_WINDOW_NAME : name;
}

/** 注入 / 抓屏目标：大总管走 window 0（窗口名不一定还叫 master），其余按窗口名精确匹配 */
export const agentTarget = (name: string): string => (isMasterAgent(name) ? MASTER_WINDOW_TARGET : windowTarget(name));

/** 一次抓屏：`capture-pane -p -e`（esc 给画面判定，plain 是去色后的），加 tmux 报的 copy-mode、前台进程名和窗格宽高 */
export interface PaneCapture {
  plain: string;
  esc: string;
  inMode: boolean;
  command: string;
  /** 读不到（测试里不给）就不估放不放得下，全靠敲完的核对 */
  size?: PaneSize | null;
}

type PaneRead = PaneQuotaState & { inputText: string };

export interface InjectDeps {
  now(): number;
  capture(target: string): Promise<PaneCapture | null>;
  readPane(plain: string, esc: string): PaneRead;
  type(target: string, text: string): Promise<void>;
  enter(target: string): Promise<void>;
  erase(target: string, count: number): Promise<void>;
  sleep(ms: number): Promise<void>;
}

type InjectSkip = PaneBlock | "pane-unknown" | "recent" | "window-small" | "busy";
/** failed 且 leftover：敲进去的字没提交、还留在输入框里（调用方要告诉 owner）；note：窗口放不下、退了档 */
export type InjectResult =
  | { status: "executed" | "queued"; line: string; note?: string }
  | { status: "skipped"; reason: InjectSkip; text: string }
  | { status: "failed"; error: string; leftover?: boolean };

/** 敲了字没提交、还留在框里的：text 是框里还剩的、自己敲的那段；inflight 是最后一批不知道生效了几个的退格（lib ourRemainder） */
interface Pending {
  text: string;
  at: number;
  inflight?: number;
}

let injectedAt: Map<string, number> = new Map();
/** 窗口 → 自己留在框里的字：之后每轮（自动注入开关关着也跑）看一眼，框里正好是它就删掉 */
let pendingEcho: Map<string, Pending> = new Map();

/**
 * bridge 启动时 "live"：守卫和待删的字换成落盘的表（bridge 重启不丢）。manager 的 dry-run 进程用 "read-only"：
 * 只读一份守卫快照，不写、坏文件也不挪（PersistedMap 读坏文件会把它改名）；dry-run 不删字，待删表留空。测试不调，用内存表。
 */
export function loadInjectState(mode: "live" | "read-only"): void {
  const isTs = (v: unknown) => typeof v === "number";
  if (mode === "live") {
    injectedAt = new PersistedMap<number>(GUARD_FILE, "上下文边界注入守卫", isTs);
    const isPending = (v: unknown) =>
      !!v && typeof (v as Pending).text === "string" && typeof (v as Pending).at === "number" && ["number", "undefined"].includes(typeof (v as Pending).inflight);
    pendingEcho = new PersistedMap<Pending>(PENDING_FILE, "上下文边界待删的字", isPending);
    return;
  }
  const r = readJsonStateSync(GUARD_FILE);
  const data = r.status === "ok" && r.data && typeof r.data === "object" ? (r.data as Record<string, unknown>) : {};
  injectedAt = new Map(Object.entries(data).filter((e): e is [string, number] => isTs(e[1])));
  pendingEcho = new Map();
}

export function resetInjectState(): void {
  injectedAt = new Map();
  pendingEcho = new Map();
}

/**
 * 按窗口的执行权：自动压缩、手动按钮、批量动作往同一个窗口发键前先拿到它，拿不到就跳过（不排队：等到手时画面和守卫早变了）。
 * 在第一次 await 之前同步拿到；守卫和画面都在拿到之后才查，敲字、回车、删字全程持有，finally 放掉。同一条流程里再进
 * （批量「开 LP 再压缩」的最后一步、自动压缩一轮里调 injectCompact）直接放行：认 AsyncLocalStorage 记下的这一次持有，放掉后遗留的回调不算。
 * 只管 bridge 进程：会发键的入口都在这里（CLI 的批量也经 ws 进 bridge）。tests/inject-lock.test.ts
 */
const windowHolders = new Map<string, { who: string; id: symbol }>();
const heldHere = new AsyncLocalStorage<ReadonlyMap<string, symbol>>();

/** 当前这条流程是不是正拿着这个窗口 */
export function holdsWindow(target: string): boolean {
  const key = windowKey(target);
  const id = heldHere.getStore()?.get(key);
  return id !== undefined && windowHolders.get(key)?.id === id;
}

/** 拿到窗口执行权再跑 fn；别人拿着就返回 busy(谁在用)，fn 不跑。who 是给被挡的一方看的（「批量动作」「自动压缩」） */
export async function withWindow<T>(target: string, who: string, fn: () => Promise<T>, busy: (holder: string) => T): Promise<T> {
  if (holdsWindow(target)) return fn();
  const key = windowKey(target);
  const holder = windowHolders.get(key);
  if (holder) return busy(holder.who);
  const id = Symbol(who);
  windowHolders.set(key, { who, id });
  try {
    return await heldHere.run(new Map([...(heldHere.getStore() ?? []), [key, id]]), fn);
  } finally {
    windowHolders.delete(key);
  }
}

export function compactInjectedRecently(target: string, now = Date.now()): boolean {
  return guardLeftMs(target, now) > 0;
}

/** 守卫还剩多久（0 = 不在守卫期） */
function guardLeftMs(target: string, now: number): number {
  const ts = injectedAt.get(windowKey(target));
  return ts === undefined ? 0 : Math.max(0, ts + INJECT_GUARD_MS - now);
}

function noteCompactInjected(target: string, now: number): void {
  for (const [k, ts] of injectedAt) if (now - ts >= INJECT_GUARD_MS) injectedAt.delete(k); // 过期的顺手清掉，落盘文件不长大
  injectedAt.set(windowKey(target), now);
}

export function paneGateOf(p: PaneCapture, r: PaneQuotaState): PaneGate {
  return { ...r, queued: QUEUED_RE.test(p.plain), apiRetry: paneShowsApiRetry(p.plain), copyMode: p.inMode, notCc: !CC_COMMAND_RE.test(p.command) };
}

/** 敲字之后还能不能按键：不是 CC、copy-mode、对话框 / 菜单、撞墙没开 LP 时一个键都不按 */
function keysBlocked(g: PaneGate): PaneBlock | null {
  const b = paneBlock(g);
  return b === "not-cc" || b === "copy-mode" || b === "menu" || b === "quota-wall" ? b : null;
}

const errText = (e: unknown) => (e as Error).message;
const skip = (reason: Exclude<InjectSkip, "window-small" | "busy">): InjectResult => ({ status: "skipped", reason, text: SKIP_REASON_TEXT[reason] });

type Typed = { kind: "ok" | "abort"; pane: PaneCapture } | { kind: "blocked"; why: string } | { kind: "cut" } | { kind: "mismatch" };

/**
 * 敲完之后的画面：输入框正好是 line → ok（正在压缩 / 排队 / API 重试 → abort，删掉别叠）；框被对话框挡住 → blocked；
 * 显示区满了、两帧都只看到后半截 → cut（窗口放不下，删掉退一档）；框里有 line 里没有的字（owner 同时在打字）→ mismatch
 */
async function typedFrame(target: string, line: string, deps: InjectDeps): Promise<Typed> {
  const want = normBox(line);
  let prev: string | null = null;
  for (let i = 1; ; i++) {
    await deps.sleep(SETTLE_MS);
    const p = await deps.capture(target);
    if (!p) return { kind: "blocked", why: SKIP_REASON_TEXT["pane-unknown"] };
    const r = deps.readPane(p.plain, p.esc);
    const g = paneGateOf(p, r);
    const blocked = keysBlocked(g);
    if (blocked) return { kind: "blocked", why: SKIP_REASON_TEXT[blocked] };
    const got = r.draft ? normBox(r.inputText) : "";
    if (got === want) return { kind: g.compacting || g.apiRetry || g.queued ? "abort" : "ok", pane: p };
    const cut = got !== "" && boxShows(got, r.inputText.split("\n").length, line, p.size);
    if (cut && got === prev) return { kind: "cut" };
    // 还没画完（框还空着，或只画出一段）就再等一帧
    if (i >= SETTLE_TRIES || !want.includes(got)) return cut ? { kind: "cut" } : { kind: "mismatch" };
    prev = got;
  }
}

/** 输入框里的字（去掉空白，框空 = ""）和占几行；对话框 / copy-mode / 不是 CC / 读不到 → null，一个键都不能再按 */
async function readBox(target: string, deps: InjectDeps): Promise<{ got: string; rows: number; size: PaneSize | null } | null> {
  const p = await deps.capture(target);
  if (!p) return null;
  const r = deps.readPane(p.plain, p.esc);
  if (keysBlocked(paneGateOf(p, r))) return null;
  return r.draft ? { got: normBox(r.inputText), rows: r.inputText.split("\n").length, size: p.size ?? null } : { got: "", rows: 0, size: p.size ?? null };
}

type Erased = { r: "erased" | "blocked" | "not-ours" | "failed"; left: string; inflight?: number };

/**
 * 输入框里两帧都正好是自己敲的那段（窗口放不下时是它的后半截），才按退格删（T35 清回显同一个做法）。退格每批 ≤ERASE_BATCH 个，
 * 每批后核对框里剩下的正好是前半截（还没画完就再等一帧）：对不上（owner 动了、退格丢了）就停，不多删一个字；被对话框挡住也停。
 * 停下时 left 是这一批之前的那段、inflight 是这一批的个数：不知道生效了几个，下一轮按框里实际剩的算（lib ourRemainder）。
 */
async function eraseOwnEcho(target: string, text: string, deps: InjectDeps, inflight = 0): Promise<Erased> {
  let mine = "";
  for (let i = 0; i < 2; i++) {
    if (i) await deps.sleep(300);
    const b = await readBox(target, deps);
    if (b === null) return { r: "blocked", left: text, inflight };
    const m = ourRemainder(b.got, b.rows, text, inflight, b.size);
    if (m === null || (i > 0 && m !== mine)) return { r: "not-ours", left: text };
    mine = m;
  }
  let left = [...mine];
  while (left.length) {
    // 先删零头：之后每批剩下的都是 ERASE_BATCH 的整数倍，中途框里不会只剩「/compact 」——那时 CC 会在后面画灰色参数提示，核对对不上（真 CC 实测）
    const n = left.length % ERASE_BATCH || ERASE_BATCH;
    const before = left.join("");
    try {
      await deps.erase(target, n);
    } catch (e) {
      console.error(`🧭 上下文边界 删回显失败 ${target}:`, errText(e));
      return { r: "failed", left: before, inflight: n };
    }
    left = left.slice(0, left.length - n);
    const want = left.join("");
    for (let i = 1; ; i++) {
      await deps.sleep(SETTLE_MS);
      const b = await readBox(target, deps);
      if (b === null) return { r: "blocked", left: before, inflight: n };
      if (want ? boxShows(b.got, b.rows, want, b.size) : b.got === "") break;
      if (i >= SETTLE_TRIES) return { r: "failed", left: before, inflight: n };
    }
  }
  return { r: "erased", left: "" };
}

function keepPending(target: string, e: { left: string; inflight?: number }, now: number): void {
  const had = pendingEcho.get(target);
  pendingEcho.set(target, { text: e.left, at: had?.at ?? now, ...(e.inflight ? { inflight: e.inflight } : {}) });
}

/**
 * 上次没按回车、字还留在框里的窗口：框里正好是那段就删掉；删到一半停下（对话框、退格丢了）就记下还剩的，下轮接着删；
 * 框里换成了别的字（owner 动过）就不管了；挡了一整天也不管了
 */
export async function sweepPendingEcho(deps: InjectDeps, log: (l: string) => void): Promise<void> {
  // 别人正在这个窗口发键：这轮不删，留到下一轮
  for (const [target, p] of [...pendingEcho]) await withWindow(target, "上下文边界（删上次留下的字）", () => sweepOne(target, p, deps, log), () => undefined);
}

async function sweepOne(target: string, p: Pending, deps: InjectDeps, log: (l: string) => void): Promise<void> {
  const e = deps.now() - p.at > PENDING_TTL_MS ? { r: "expired" as const, left: p.text } : await eraseOwnEcho(target, p.text, deps, p.inflight ?? 0);
  if (e.r === "blocked" || e.r === "failed") {
    if (e.left !== p.text || e.inflight !== p.inflight) keepPending(target, e, deps.now());
    return;
  }
  pendingEcho.delete(target);
  const what = { erased: "已删掉", "not-ours": "输入框里已经不是它了，不动", expired: "一天都没删成，不再管" }[e.r];
  log(`🧭 上下文边界 ${target} 上次没提交的压缩命令：${what}`);
}

const windowSmall = (size: PaneSize | null | undefined): InjectResult => ({
  status: "skipped",
  reason: "window-small",
  text: `${sizeText(size)}太小，连 /compact 都放不下，已跳过（把窗口拉大就行）`,
});

const windowBusy = (who: string): InjectResult => ({ status: "skipped", reason: "busy", text: `${who}正在操作这个窗口，这次没敲` });

/**
 * 注入一次压缩（拿不准目标时用 ctx-boundary.ts 的 injectTargetFor(name)）。15 分钟守卫对所有调用方生效，没有绕过开关。
 * 先拿窗口执行权（别人拿着就跳过），再查守卫、读画面：pane 只在调用方自己拿着这个窗口时用（锁里抓的），否则锁里重抓；
 * 读不到 / paneBlock 挡住 → 不敲键。执行者的 save-compact 改成 compact。
 * 按窗口大小从长到短挑一档敲（放不下的不敲）→ 再读画面 → 输入框正好是这条才回车；只看得到后半截就删掉、敲下一档。
 * 忙的时候回车会排队到回合结束（queued），闲着就是立刻执行（executed）。
 */
export function injectCompact(
  t: InjectTarget,
  opts: { action: CompactAction; keep?: CompactKeep | null; pane?: PaneCapture | null },
  deps: InjectDeps = liveInjectDeps,
): Promise<InjectResult> {
  const pane = holdsWindow(t.target) ? opts.pane : undefined;
  return withWindow(t.target, "另一次压缩注入", () => injectHeld(t, { ...opts, pane }, deps), windowBusy);
}

async function injectHeld(t: InjectTarget, opts: Parameters<typeof injectCompact>[1], deps: InjectDeps): Promise<InjectResult> {
  const left = guardLeftMs(t.target, deps.now());
  if (left > 0) return { status: "skipped", reason: "recent", text: `${SKIP_REASON_TEXT.recent}，还要等 ${Math.ceil(left / 60_000)} 分钟` };
  // 类型上只收 normalizeCompactKeep 产出的；运行时再过一遍，强转进来的也拦得住
  const k = opts.keep == null ? null : normalizeCompactKeep(opts.keep);
  if (k && (!k.ok || k.keep !== opts.keep)) return { status: "failed", error: `保留清单不合格（${k.ok ? "没有规范化" : k.why}），没敲` };
  const pane = opts.pane !== undefined ? opts.pane : await deps.capture(t.target);
  if (!pane) return skip("pane-unknown"); // 多半是窗口不在：盲敲只会假报「已开始」
  const blocked = paneBlock(paneGateOf(pane, deps.readPane(pane.plain, pane.esc)));
  if (blocked) return skip(blocked);
  const { all, fit } = tiersThatFit(effectiveAction(t.executor, opts.action), k?.ok ? k.keep : null, pane.size ?? null);
  for (const [i, tier] of fit.entries()) {
    const r = await typeAndSubmit(t.target, tier.line, deps);
    if (r === "cut") {
      if (i === fit.length - 1) return windowSmall(pane.size);
      continue;
    }
    if (r.status === "executed" || r.status === "queued") {
      const note = tierNote(all, tier, pane.size);
      return note ? { ...r, note } : r;
    }
    return r;
  }
  return windowSmall(pane.size);
}

/** 敲一档、核对、回车。只看得到后半截（窗口放不下）→ 删干净返回 "cut"，调用方敲下一档；删不干净就记待删、报 leftover */
async function typeAndSubmit(target: string, line: string, deps: InjectDeps): Promise<InjectResult | "cut"> {
  try {
    await deps.type(target, line);
  } catch (e) {
    return { status: "failed", error: errText(e) };
  }
  const typed = await typedFrame(target, line, deps);
  if (typed.kind === "mismatch") return { status: "failed", error: "输入框里的字和敲进去的对不上（可能有人同时在打字），没按回车，也没删", leftover: true };
  if (typed.kind === "blocked") {
    keepPending(target, { left: line }, deps.now());
    return { status: "failed", error: `敲完字画面变了（${typed.why}），没按回车；字先留在输入框里，对话框关掉后自动删`, leftover: true };
  }
  if (typed.kind === "cut" || typed.kind === "abort") {
    const e = await eraseOwnEcho(target, line, deps);
    if (e.r === "erased") return typed.kind === "cut" ? "cut" : skip("compacting");
    keepPending(target, e, deps.now());
    const why = typed.kind === "cut" ? "窗口放不下，敲进去的命令只显示得出后半截" : "敲完字发现已经在压缩 / 排队";
    return { status: "failed", error: `${why}，没按回车；删字没删干净，之后再删`, leftover: true };
  }
  try {
    await deps.enter(target);
  } catch (e) {
    keepPending(target, { left: line }, deps.now());
    return { status: "failed", error: errText(e), leftover: true };
  }
  noteCompactInjected(target, deps.now());
  return { status: paneLooksWorking(typed.pane.plain) ? "queued" : "executed", line };
}

/** 全用 strict：tmuxRaw 吞非零退出，窗口不在时会拿到空串、发键也「成功」，后面就对着不存在的窗口报「已发送」 */
async function capturePane(t: string): Promise<PaneCapture | null> {
  try {
    const fmt = "#{pane_in_mode}\t#{pane_current_command}\t#{pane_width}\t#{pane_height}\t#{alternate_on}";
    const [mode = "", command = "", w = "", h = "", alt = ""] = ((await tmuxRawStrict(["list-panes", "-t", t, "-F", fmt])).split("\n")[0] ?? "").split("\t");
    const esc = await tmuxRawStrict(["capture-pane", "-t", t, "-p", "-e"]);
    const plain = stripAnsi(esc);
    // alternate_on 分得出 CC 的渲染器：fullscreen 用备用屏（1），默认渲染器不用（0）；输入框行数上限只在 fullscreen 下有（ctx-boundary-fit.ts）
    const fullscreen = alt.trim() === "1" ? true : alt.trim() === "0" ? false : undefined;
    const size = Number(w) > 0 && Number(h) > 0 ? { width: Number(w), height: Number(h), ...(fullscreen === undefined ? {} : { fullscreen }) } : null;
    return plain.trim() ? { plain, esc, inMode: mode.trim() !== "" && mode.trim() !== "0", command: command.trim(), size } : null;
  } catch {
    return null; // 窗口不在 / tmux 出错：按「读不到画面」跳过，不盲敲
  }
}

const sendKeys = async (t: string, keys: string[]) => void (await tmuxRawStrict(["send-keys", "-t", t, ...keys]));

export const liveInjectDeps: InjectDeps = {
  now: () => Date.now(),
  capture: capturePane,
  readPane: (plain, esc) => ({ ...paneQuotaState(plain, esc), inputText: readLpPane(esc.trim() ? esc : plain).inputText }),
  type: (t, text) => sendKeys(t, ["-l", "--", text]),
  enter: (t) => sendKeys(t, ["Enter"]),
  erase: (t, n) => sendKeys(t, Array<string>(n).fill("BSpace")), // 调用方按 ERASE_BATCH 分批
  sleep: (ms) => Bun.sleep(ms),
};
