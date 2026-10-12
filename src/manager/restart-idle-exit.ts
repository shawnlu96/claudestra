/**
 * `manager restart --idle-only` 的退出（hardening-CCIDLE1 第 5 轮审查 pre-exit-await / last-read-race）。
 *
 * 以前 idleSkip 放行后 manager 按名字进 gracefulExit：首个 C-c 之前 sendKey 还要 await 查窗口 id 记账（noteProgramInput），
 * 这段等待里开始的回合照样被打断；最后一次窗口读取若是过时快照，按名字发键还会落到换过的新窗口。现在：
 * - 退出绑定复核过的窗口 id（拍身份时那唯一一个），不按名字：窗口换了，键落不到新窗口上，查不到旧窗口就跳过；
 * - 首个可能打断回合的动作（C-c / 退出指令 / ACP 宿主的 childPids → SIGTERM）之前，先把异步准备做完（查窗口 id 记账、查子进程），
 *   准备夹在一次完整复核的首尾回合代际之间，复核收尾是同步读，之后不再 await 就发出；复核不过 = 跳过，不发任何键，launcher 留 pending；
 * - 首个动作若是 Esc / 整行（Codex 只在画面在跑时才按 Esc）= 不像空闲，直接跳过；一次拒绝之后的所有动作都拒（ACP 的 catch 吞掉也不会改走别的键）。
 * 第 6 轮 last-read-race：programInputNoter 的 keyOf 吞掉 list-panes 错误退回 windowKey，旧窗口不在也照样「准备好」，退出返回 false 进 kill-window /
 * new-window。所以准备先严格按 id 查已核窗口（查询失败 / 查到的不是它 = 抛 = 跳过），首个键也严格发（tmux 报错 = 跳过，没有键落地），都不再回到 manager 重建。
 * tests/claude-update-audit-idle-exit.test.ts。
 */
import { gracefulExitWindow } from "../lib/runtimes/graceful-exit.js";
import { tmuxWindowOps } from "../lib/runtimes/window-ops.js";
import type { ManagedRuntimeAdapter, WindowOps } from "../lib/runtimes/types.js";
import { programInputNoter, tmuxRawStrict } from "../lib/tmux-helper.js";
import { idleSkip, parseIdleExpect, type IdleSkip } from "./restart-idle.js";

/** 发键的两步：异步准备（查窗口 id，返回同步记账函数）+ 发出（调用当下就 spawn，前面不隔 await） */
export interface ExitKeyIO {
  prepare(target: string): Promise<(text?: string) => void>;
  send(args: string[]): Promise<unknown>;
}

/** 复核闸：prepare 在复核里跑完（idleSkip 的 prepare 参数） */
type IdleGate = (prepare: () => Promise<void>) => Promise<IdleSkip | null>;

export interface IdleExitDeps {
  gate: IdleGate;
  io: ExitKeyIO;
  ops(name: string, target: string): WindowOps;
  exit(win: WindowOps, adapter: ManagedRuntimeAdapter): Promise<boolean>;
}

/** 严格的发键准备：已核窗口 id 此刻查得到、查到的就是它，才取记账函数；查询出错 / 窗口不在 / 不是它 = 抛（复核跳过） */
export async function strictExitPrepare(
  target: string,
  query: (target: string) => Promise<string> = (t) => tmuxRawStrict(["list-panes", "-t", t, "-F", "#{window_id}"]),
  noter: ExitKeyIO["prepare"] = programInputNoter,
): Promise<(text?: string) => void> {
  const id = (await query(target)).split("\n")[0]?.trim() ?? "";
  if (id !== target) throw new Error(`已核窗口 ${target} 查不到（${id || "无"}）`);
  return noter(target);
}

/** 准备严格；首个键严格发（idleGuardedOps.key 把 tmux 报错转成跳过），过闸之后的键照旧走 WindowOps */
export const LIVE_EXIT_IO: ExitKeyIO = { prepare: (t) => strictExitPrepare(t), send: (args) => tmuxRawStrict(args) };

class IdleExitRefused extends Error {
  constructor(readonly skip: IdleSkip) {
    super(skip.error);
  }
}

const skipOf = (name: string, why: string): IdleSkip => {
  console.error(`[restart] ${name} 按 --idle-only 复核不重启：${why}`);
  return { name, ok: false, skipped: why, error: `已跳过（--idle-only 复核）：${why}` };
};

/** 包一层 WindowOps：首个可能打断回合的动作前过闸，过了之后原样转发 */
function idleGuardedOps(win: WindowOps, gate: IdleGate, io: ExitKeyIO = LIVE_EXIT_IO): WindowOps {
  let state: "armed" | "open" | IdleExitRefused = "armed";
  const pass = async <T>(prep: () => Promise<T>): Promise<T> => {
    if (state instanceof IdleExitRefused) throw state;
    let ready: { v: T } | undefined;
    const skip = await gate(async () => { ready = { v: await prep() }; });
    if (skip || !ready) throw (state = new IdleExitRefused(skip ?? skipOf(win.name, "发键准备没完成")));
    state = "open";
    return ready.v;
  };
  const refuse = (what: string) => {
    if (state === "armed") state = new IdleExitRefused(skipOf(win.name, `退出要先${what}：画面不像空闲`));
    return Promise.reject(state);
  };
  const key = async (args: string[], text?: string): Promise<void> => {
    const note = await pass(() => io.prepare(win.target));
    note(text); // 同步记账，紧接着发出：收尾同步核代际之后不再有 I/O 等待
    try {
      await io.send(["send-keys", "-t", win.target, ...args]);
    } catch (e) {
      // 首个键发不出（窗口刚没了）：没有键落地，按跳过报，不让 manager 进强杀 / 重建
      throw (state = new IdleExitRefused(skipOf(win.name, `首个退出键没发出去：${(e as Error).message.slice(0, 200)}`)));
    }
  };
  return {
    ...win,
    sendKey: (k) => (state === "open" ? win.sendKey(k) : key([k])),
    sendLiteral: (text) => (state === "open" ? win.sendLiteral(text) : key(["-l", "--", text], text)),
    sendEscape: () => (state === "open" ? win.sendEscape() : refuse("按 Esc")),
    sendLine: (text) => (state === "open" ? win.sendLine(text) : refuse("发整行")),
    childPids: () => (state === "open" ? win.childPids() : pass(() => win.childPids())), // ACP：查完子进程就同步 SIGTERM
  };
}

/** 单窗口的 --idle-only 退出：返回 gracefulExit 的结果，或跳过条目（没碰窗口） */
export async function idleGracefulExit(
  name: string,
  windowId: string,
  raw: string,
  adapter: ManagedRuntimeAdapter,
  deps: IdleExitDeps = { gate: (prepare) => idleSkip(name, raw, undefined, prepare), io: LIVE_EXIT_IO, ops: tmuxWindowOps, exit: gracefulExitWindow },
): Promise<boolean | IdleSkip> {
  const want = parseIdleExpect(raw);
  if (!want || want.windows.length !== 1 || want.windows[0] !== windowId) {
    return skipOf(name, `要退出的窗口 ${windowId || "无"} 不是拍身份时那一个（${want?.windows.join(",") || "无"}）`);
  }
  try {
    return await deps.exit(idleGuardedOps(deps.ops(name, windowId), deps.gate, deps.io), adapter);
  } catch (e) {
    if (e instanceof IdleExitRefused) return e.skip;
    throw e;
  }
}
