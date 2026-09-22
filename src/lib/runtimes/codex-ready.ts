/**
 * Codex 的就绪判据（纯逻辑 + WindowOps，单测用假窗口）。
 *
 * 就绪只认 channel-server 写的 tmux 窗口选项 @claudestra_ready=1（不嗅 TUI 文案）；
 * 失败分三类：线程被占（occupied）、启动对话框（blocked-dialog）、回到 shell（exited）。
 */
import { isAtShell, PI_READY_OPTION } from "../tmux-helper.js";
import type { ReadyResult, WindowOps } from "./types.js";

/** channel-server 注册成功后写的就绪标记（与 Pi 扩展同一个窗口选项） */
export const CODEX_READY_OPTION = PI_READY_OPTION;

/** 线程被别的进程占着写（另一个 TUI / ChatGPT.app 的 app-server）：resume 起不来，restart 会改 fork 重试 */
export const OCCUPIED_RE = /already has an active writer/i;

/**
 * 启动期对话框。**绝不替用户按 Enter**：更新框默认高亮「Update now」，hooks 审查框按下去
 * 等于替 owner 批准，信任框同理——一律立即失败，把屏幕上那句话带回给调用方。
 * （正常启动参数已关掉这三个：check_for_update_on_startup=false / --dangerously-bypass-hook-trust /
 * projects 信任内联表。还弹出来 = Codex 版本变了或参数没生效，需要人看。）
 */
export const BLOCKING_DIALOG_RE = /Hooks need review|Do you trust|Update available/i;

/**
 * 对话框的结构特征：选项行（「› 1. Update now」）或「Press enter to continue」。
 * 光有关键词不够——resume 的 TUI 会先把历史对话渲染进 pane（早于 @claudestra_ready），
 * 历史里提到 "Update available" 的会话就会被误判成对话框、整个窗口被清理掉。
 */
const DIALOG_SHAPE_RE = /^\s*(?:[›>❯]\s*)?1\.\s|press enter to continue/im;

/** 只看 pane 末尾这么多非空行：对话框与报错都画在底部，更早的是历史回放 */
const VERDICT_TAIL_LINES = 15;

/** 启动前 pane 里已有的命中次数：复用窗口时，上一次启动留下的报错 / 对话框文字不能再算一次 */
export interface PaneBaseline {
  occupied: number;
  dialog: number;
}

function countMatches(text: string, re: RegExp): number {
  const g = new RegExp(re.source, re.flags.includes("g") ? re.flags : `${re.flags}g`);
  return (text.match(g) || []).length;
}

/** pane 里命中的那一行（报错信息用） */
function matchedLine(pane: string, re: RegExp): string {
  return (pane.split("\n").find((l) => re.test(l)) || "").trim().slice(0, 200);
}

const nonEmptyTail = (pane: string, n: number) => pane.split("\n").filter((l) => l.trim()).slice(-n);

const verdictTail = (pane: string) => nonEmptyTail(pane, VERDICT_TAIL_LINES).join("\n");

export function paneBaseline(pane: string): PaneBaseline {
  const tail = verdictTail(pane);
  return { occupied: countMatches(tail, OCCUPIED_RE), dialog: countMatches(tail, BLOCKING_DIALOG_RE) };
}

/** 一轮屏幕判定：命中返回失败结果，没命中返回 null（继续等） */
async function paneVerdict(win: WindowOps, pane: string, base: PaneBaseline, round: number): Promise<ReadyResult | null> {
  const tail = verdictTail(pane);
  // active writer 是 codex 退出前打的最后一句（E15：立即回到 shell）。codex 还在跑 = 这句话是
  // 历史回放里的文字，不算；所以只在 pane 下已经没有子进程时认
  if (countMatches(tail, OCCUPIED_RE) > base.occupied) {
    const kids = await win.childPids().catch(() => [] as number[]); // 查不到按「没有」算：与 exited 同口径
    if (kids.length === 0) return { ready: false, reason: "occupied", detail: matchedLine(tail, OCCUPIED_RE) };
  }
  if (countMatches(tail, BLOCKING_DIALOG_RE) > base.dialog && DIALOG_SHAPE_RE.test(tail)) {
    return { ready: false, reason: "blocked-dialog", detail: matchedLine(tail, BLOCKING_DIALOG_RE) };
  }
  // 窗口回到 shell = codex 已退出（参数错、登录过期……），不必等满预算。
  // 只看屏幕会误判：oh-my-zsh 的「➜  dir」提示符后面跟着刚键入的长命令，TUI 接管屏幕前
  // 那一行照样像 shell——所以再要求 pane 下已经没有子进程（codex 在跑时它就是 pane 的子进程）
  if (round > 4 && isAtShell(nonEmptyTail(pane, 3).join("\n"))) {
    const kids = await win.childPids().catch(() => [] as number[]); // 查不到子进程按「没有」算，只影响早退判定
    if (kids.length === 0) return { ready: false, reason: "exited", detail: nonEmptyTail(pane, 4).join(" | ").slice(0, 300) };
  }
  return null;
}

export async function waitCodexReady(
  win: WindowOps,
  budget: { rounds: number; pollMs: number },
  base: PaneBaseline,
): Promise<ReadyResult> {
  for (let i = 0; i < budget.rounds; i++) {
    if ((await win.getOption(CODEX_READY_OPTION)) === "1") return { ready: true };
    const pane = await win.capture(200).catch(() => ""); // 截屏失败本轮当空屏，下一轮再看
    const verdict = await paneVerdict(win, pane, base, i);
    if (verdict) return verdict;
    await win.sleep(budget.pollMs);
  }
  return { ready: false, reason: "timeout" };
}
