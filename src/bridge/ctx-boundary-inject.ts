/**
 * 往 Claude Code 会话里注入一次压缩。自动压缩（ctx-boundary.ts）、Discord 手动按钮、T35 的批量动作都走 injectCompact，
 * 共用一份画面判定（lib/ctx-boundary-decision.ts paneBlock）和一份 15 分钟注入守卫（落盘，bridge 重启也不重复注入）。
 * 敲字和回车分开：敲完再读一次画面，输入框里正好是这条、底部也没冒出对话框才按回车。
 * 设计 docs/architecture/context-boundary.md；单测 tests/ctx-boundary-inject.test.ts（依赖全部可注入）。
 */
import { isMasterAgent } from "../lib/registry.js";
import { statePath } from "../lib/paths.js";
import { readJsonStateSync } from "../lib/state-file.js";
import { MASTER_WINDOW_NAME, tmuxRawStrict, windowKey } from "../lib/tmux-helper.js";
import { paneLooksWorking, paneShowsApiRetry } from "../lib/turn-state.js";
import { compactCommand, effectiveAction, type CompactAction } from "../lib/ctx-boundary-policy.js";
import { paneQuotaState, readLpPane, stripAnsi, type PaneQuotaState } from "../lib/lp-state.js";
import { paneBlock, SKIP_REASON_TEXT, type PaneBlock, type PaneGate } from "../lib/ctx-boundary-decision.js";
import { PersistedMap } from "./persisted-map.js";

/** 刚注入过压缩的窗口：15 分钟内谁也不能再注入（手动按钮也不行），看板也不拿它当 /status 抓取源（压缩中 pane 像闲着，抓取会硬中断它） */
const INJECT_GUARD_MS = 15 * 60_000;
const GUARD_FILE = statePath("ctx-boundary-injected.json");
const QUEUED_RE = /Press up to edit queued messages/i;
/** CC 的前台进程名：npm 装的是 claude.exe（09-29 实测）；node 启动的老装法、原生安装器的版本号文件名也算。其余（zsh…）一律不发 */
const CC_COMMAND_RE = /^(claude(\.exe)?|node|\d+\.\d+\.\d+)$/;
/** 敲完字等 CC 画出来：每 200ms 看一次，最多 5 次（186 字的保留清单实测一次就齐） */
const SETTLE_MS = 200;
const SETTLE_TRIES = 5;

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

/** 一次抓屏：`capture-pane -p -e`（esc 给画面判定，plain 是去色后的），加 tmux 报的 copy-mode 和前台进程名 */
export interface PaneCapture {
  plain: string;
  esc: string;
  inMode: boolean;
  command: string;
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

type InjectSkip = PaneBlock | "pane-unknown" | "recent";
/** failed 且 leftover：敲进去的字没提交、还留在输入框里（调用方要告诉 owner） */
export type InjectResult =
  | { status: "executed" | "queued"; line: string }
  | { status: "skipped"; reason: InjectSkip; text: string }
  | { status: "failed"; error: string; leftover?: boolean };

let injectedAt: Map<string, number> = new Map();
/** 敲了字、因为对话框没按回车的窗口 → 那条命令：之后每轮看一眼，输入框里正好是它就删掉 */
const pendingEcho = new Map<string, string>();

/**
 * bridge 启动时 "live"：守卫换成落盘的表。manager 的 dry-run 进程用 "read-only"：只读一份快照，
 * 不写、坏文件也不挪（PersistedMap 读坏文件会把它改名）。测试不调，用内存表。
 */
export function loadInjectGuard(mode: "live" | "read-only"): void {
  const isTs = (v: unknown) => typeof v === "number";
  if (mode === "live") {
    injectedAt = new PersistedMap<number>(GUARD_FILE, "上下文边界注入守卫", isTs);
    return;
  }
  const r = readJsonStateSync(GUARD_FILE);
  const data = r.status === "ok" && r.data && typeof r.data === "object" ? (r.data as Record<string, unknown>) : {};
  injectedAt = new Map(Object.entries(data).filter((e): e is [string, number] => isTs(e[1])));
}

export function resetInjectState(): void {
  injectedAt = new Map();
  pendingEcho.clear();
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

const norm = (s: string) => s.replace(/\s+/g, ""); // CC 按词折行，折行处的空格会被吃掉：去掉空白再比（09-29 真 CC 实测）
const errText = (e: unknown) => (e as Error).message;
const skip = (reason: InjectSkip): InjectResult => ({ status: "skipped", reason, text: SKIP_REASON_TEXT[reason] });

type Typed = { kind: "ok" | "abort"; pane: PaneCapture } | { kind: "blocked"; why: string } | { kind: "mismatch" };

/** 敲完之后的画面：输入框正好是 line → ok（正在压缩 / 排队 / API 重试 → abort，删掉别叠）；框被对话框挡住 → blocked；字对不上 → mismatch */
async function typedFrame(target: string, line: string, deps: InjectDeps): Promise<Typed> {
  const want = norm(line);
  for (let i = 1; ; i++) {
    await deps.sleep(SETTLE_MS);
    const p = await deps.capture(target);
    if (!p) return { kind: "blocked", why: SKIP_REASON_TEXT["pane-unknown"] };
    const r = deps.readPane(p.plain, p.esc);
    const g = paneGateOf(p, r);
    const blocked = keysBlocked(g);
    if (blocked) return { kind: "blocked", why: SKIP_REASON_TEXT[blocked] };
    const got = norm(r.inputText);
    if (r.draft && got === want) return { kind: g.compacting || g.apiRetry || g.queued ? "abort" : "ok", pane: p };
    // 还没画完（框还空着，或只画出前半截）就再等一帧
    if (i >= SETTLE_TRIES || (r.draft && !want.startsWith(got))) return { kind: "mismatch" };
  }
}

/** 输入框里两帧都正好是自己敲的那条，才按退格删；删完再看一眼框是不是空了（T35 清回显同一个做法） */
async function eraseOwnEcho(target: string, line: string, deps: InjectDeps): Promise<"erased" | "blocked" | "not-ours" | "failed"> {
  for (let i = 0; i < 2; i++) {
    if (i) await deps.sleep(300);
    const p = await deps.capture(target);
    if (!p) return "blocked";
    const r = deps.readPane(p.plain, p.esc);
    if (keysBlocked(paneGateOf(p, r))) return "blocked";
    if (!r.draft || norm(r.inputText) !== norm(line)) return "not-ours";
  }
  try {
    await deps.erase(target, [...line].length);
  } catch (e) {
    console.error(`🧭 上下文边界 删回显失败 ${target}:`, errText(e));
    return "failed";
  }
  await deps.sleep(SETTLE_MS);
  const p = await deps.capture(target);
  return p && !deps.readPane(p.plain, p.esc).draft ? "erased" : "failed";
}

/** 上次因为对话框没按回车、字还留在框里的窗口：框里正好是那条就删掉；框里换成了别的字（owner 动过）就不管了 */
export async function sweepPendingEcho(deps: InjectDeps, log: (l: string) => void): Promise<void> {
  for (const [target, line] of pendingEcho) {
    const r = await eraseOwnEcho(target, line, deps);
    if (r === "blocked") continue;
    pendingEcho.delete(target);
    log(`🧭 上下文边界 ${target} 上次没提交的压缩命令：${r === "erased" ? "已删掉" : r === "not-ours" ? "输入框里已经不是它了，不动" : "删了没删干净，不再管"}`);
  }
}

/**
 * 注入一次压缩（拿不准目标时用 ctx-boundary.ts 的 injectTargetFor(name)）。15 分钟守卫对所有调用方生效，没有绕过开关。
 * 先读画面（pane 由调用方传入时用它）：读不到 / paneBlock 挡住 → 不敲键。执行者的 save-compact 改成 compact。
 * 敲字 → 再读画面 → 输入框正好是这条才回车；忙的时候回车会排队到回合结束（queued），闲着就是立刻执行（executed）。
 */
export async function injectCompact(
  t: InjectTarget,
  opts: { action: CompactAction; keep?: string | null; pane?: PaneCapture | null },
  deps: InjectDeps = liveInjectDeps,
): Promise<InjectResult> {
  const left = guardLeftMs(t.target, deps.now());
  if (left > 0) return { status: "skipped", reason: "recent", text: `${SKIP_REASON_TEXT.recent}，还要等 ${Math.ceil(left / 60_000)} 分钟` };
  const pane = opts.pane !== undefined ? opts.pane : await deps.capture(t.target);
  if (!pane) return skip("pane-unknown"); // 多半是窗口不在：盲敲只会假报「已开始」
  const blocked = paneBlock(paneGateOf(pane, deps.readPane(pane.plain, pane.esc)));
  if (blocked) return skip(blocked);
  const line = compactCommand(effectiveAction(t.executor, opts.action), opts.keep ?? null);
  try {
    await deps.type(t.target, line);
  } catch (e) {
    return { status: "failed", error: errText(e) };
  }
  const typed = await typedFrame(t.target, line, deps);
  if (typed.kind === "mismatch") return { status: "failed", error: "输入框里的字和敲进去的对不上（可能有人同时在打字），没按回车，也没删", leftover: true };
  if (typed.kind === "blocked") {
    pendingEcho.set(t.target, line);
    return { status: "failed", error: `敲完字画面变了（${typed.why}），没按回车；字先留在输入框里，对话框关掉后自动删`, leftover: true };
  }
  if (typed.kind === "abort") {
    if ((await eraseOwnEcho(t.target, line, deps)) === "erased") return skip("compacting");
    pendingEcho.set(t.target, line);
    return { status: "failed", error: "敲完字发现已经在压缩 / 排队，没按回车；删字没删干净，之后再试", leftover: true };
  }
  try {
    await deps.enter(t.target);
  } catch (e) {
    pendingEcho.set(t.target, line);
    return { status: "failed", error: errText(e), leftover: true };
  }
  noteCompactInjected(t.target, deps.now());
  return { status: paneLooksWorking(typed.pane.plain) ? "queued" : "executed", line };
}

/** 全用 strict：tmuxRaw 吞非零退出，窗口不在时会拿到空串、发键也「成功」，后面就对着不存在的窗口报「已发送」 */
async function capturePane(t: string): Promise<PaneCapture | null> {
  try {
    const [mode = "", command = ""] = ((await tmuxRawStrict(["list-panes", "-t", t, "-F", "#{pane_in_mode}\t#{pane_current_command}"])).split("\n")[0] ?? "").split("\t");
    const esc = await tmuxRawStrict(["capture-pane", "-t", t, "-p", "-e"]);
    const plain = stripAnsi(esc);
    return plain.trim() ? { plain, esc, inMode: mode.trim() !== "" && mode.trim() !== "0", command: command.trim() } : null;
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
  erase: (t, n) => sendKeys(t, Array<string>(n).fill("BSpace")),
  sleep: (ms) => Bun.sleep(ms),
};
