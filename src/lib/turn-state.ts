/**
 * 「agent 忙不忙」的唯一判据：主回合（main）和后台活动（bg）分开报。纯函数，单测 tests/turn-state.test.ts。
 *
 * 押后闸 / flush / 两个抢占入口 / Autopilot 都只看 main：主回合结束、只剩后台 subagent 时 CC 收到通知会正常开新回合，
 * 押着它只会让 agent 消息等到后台全部结束（git log -S agentMsgMustWait）；而那时的 C-c 会把后台 agent 全停掉。
 * bg 只给显示用（侧栏黄点仍是 paneLooksWorking，语义 = main 非 idle 或 bg）。
 */
import { controlFor } from "./runtimes/index.js";
import { CC_BUSY_RE, paneIdleVerdict, probeTuiContract } from "./tmux-helper.js";

type MainTurn = "busy" | "idle" | "compacting" | "unknown";

/** event-bus 的 AgentTurnStatus（src/lib 不能 import bridge，这里按字面量收） */
type TurnStatus = "thinking" | "done" | "compacting" | undefined;

export interface TurnInput {
  /** 窗口尾部画面；抓不到（没窗口 / tmux 出错）= null */
  pane: string | null;
  status?: TurnStatus;
  runtime?: string | null;
  /** bg-activity 里还有没结束的 subagent / bg shell */
  bgActive?: boolean;
  /** 事件态 thinking、画面却空闲时，约 1 秒后再抓的一帧（见 stuckThinkingIdle） */
  paneAgain?: string | null;
  /** 这个 agent 多久没有活动了：会话记录没有新写入、bridge 也没投过消息（毫秒） */
  quietMs?: number;
}

export interface TurnState {
  main: MainTurn;
  bg: boolean;
}

/** 输入框边框：顶格、整行只有 ─（去掉行尾空白后至少 3 个）。对话里「─── 小标题」这类混了文字的行不算，窄窗口里短的整行边框算 */
const isBoxRule = (l: string | undefined): boolean => l !== undefined && /^─{3,}$/.test(l.replace(/\s+$/, ""));

/**
 * 真输入框在画面里的上下边框行号，按框的形状认、不看 ❯ 后面的字（草稿首行可以是「1. 先修测试」「2.1.283 …」）：
 * 顶格整行边框正下方是顶格的 ❯（shell 模式是 !），到下一条顶格整行边框之间只有缩进的续行或空行，下边框以下没有顶格文字
 * （状态栏都缩进；权限框、AskUserQuestion 的「Enter to select」提示行、额度菜单都是顶格）。从下往上找，草稿多长都行；
 * 找不到 = null。对话里贴进来的输入框都有缩进，认不成。90 张真 / 合成画面见 tests/turn-zone.test.ts、额度判定 lib/quota-wall-text.ts。
 */
export function inputBox(lines: string[]): { top: number; bottom: number } | null {
  for (let i = lines.length - 1; i > 0; i--) {
    if (!/^[❯!](\s|$)/.test(lines[i]!) || !isBoxRule(lines[i - 1])) continue;
    let j = i + 1;
    while (j < lines.length && !isBoxRule(lines[j]) && (lines[j] === "" || /^\s/.test(lines[j]!))) j++;
    if (j < lines.length && isBoxRule(lines[j]) && !lines.slice(j + 1).some((l) => /^\S/.test(l))) return { top: i - 1, bottom: j };
  }
  return null;
}

/**
 * 主回合信号所在的区域，按输入框定位、不按固定尾部行数：底栏的后台 agent 行一多（80 列约 4 行、272 列约 6 行）
 * 就把 spinner 挤出「尾部 14 行」。above = 输入框上边框往上 12 行（spinner / 压缩行 / Tip / 任务列表最多 5 行 + 「… +N」
 * + 排队消息预览），rest = 上边框到底（❯ 行、草稿、页脚），footer = 下边框以下（状态栏、页脚）。
 * 找不到输入框退回尾部 14 行，footer 只取最后 3 行。
 */
function turnZone(pane: string): { above: string; rest: string; footer: string; box: boolean } {
  const lines = pane.replace(/\s+$/, "").split("\n");
  const b = inputBox(lines);
  if (!b) return { above: lines.slice(-14).join("\n"), rest: "", footer: lines.slice(-3).join("\n"), box: false };
  return { above: lines.slice(Math.max(0, b.top - 12), b.top).join("\n"), rest: lines.slice(b.top).join("\n"), footer: lines.slice(b.bottom + 1).join("\n"), box: true };
}

/** 顶格、spinner 字形开头的行：真 spinner / 压缩行 / 重试横幅都在第 0 列，对话和工具输出里的同样字样都有缩进 */
const spinnerRows = (zone: string): string[] => zone.split("\n").filter((l) => /^[·✢✳✶✻✽*]\s/.test(l));
const spinnerBusy = (zone: string): boolean => spinnerRows(zone).some((l) => CC_BUSY_RE.test(l));
/** spinner 位置（输入框上方，没有输入框 = 尾部 14 行）有顶格的 spinner 在跑：撞墙画面判「其实还在跑」只认这个（lib/quota-wall-text.ts） */
export const paneSpinnerBusy = (pane: string): boolean => spinnerBusy(turnZone(pane).above);

/**
 * 画面上是否在压缩上下文：spinner 位置那一行是「✻ Compacting conversation…」。锚定 spinner 行形态——正文里提到 compacting
 * 不算；结束后 CC 打印的是「Compacted (ctrl+o …)」，不会误判成仍在压缩。permission-watcher 置 compacting 也用它。
 */
export function paneShowsCompacting(pane: string): boolean {
  return spinnerRows(turnZone(pane).above).some((l) => /^\S\s+Compacting\b/i.test(l));
}

/**
 * spinner 位置换成了 API 重试 / 限流横幅（「✻ Repeated 529 … · Retrying in 38s」「✻ Waiting for API response · will retry in 5s」）。
 * 压缩中碰上重试时「Compacting conversation…」会被它替换掉：这时不能据此判定压缩结束（permission-watcher 的兜底收敛）。
 */
export function paneShowsApiRetry(pane: string): boolean {
  return spinnerRows(turnZone(pane).above).some((l) => /\b(?:retrying|will retry)\b/i.test(l));
}

/**
 * 只认主回合在跑：顶格的 spinner 行（CC_BUSY_RE）、真输入框页脚里老 TUI 的 esc to interrupt、顶格的排队消息提示。见 tests/pane-main-turn.test.ts。
 * 不拿 CC_BUSY_RE 扫整段：它的「esc to cancel」会命中权限弹窗 / 额度菜单的「Esc to cancel」，贴进对话的忙画面也会命中，
 * 判成忙就会往空闲输入框或权限弹窗上发 C-c（后者等于替人拒了权限）。见 tests/turn-zone.test.ts。
 */
export function paneMainTurnBusy(pane: string): boolean {
  const z = turnZone(pane);
  if (spinnerBusy(z.above)) return true;
  if (`${z.above}\n${z.rest}`.split("\n").some((l) => /^❯ Press up to edit queued messages/.test(l))) return true;
  // 老 TUI 的 esc to interrupt 在页脚（有没有 ⏵⏵、窄窗口折不折行都一样）；输入框上方贴进来的同样字样不算
  return /esc\s+to\s+interrupt/i.test(z.footer);
}

/**
 * 画面呈现「工作中」的任一信号（侧栏黄点）：主回合，或后台——「Waiting for N background agent(s)」、
 * 底栏 agents 行「◯ general-purpose  Anal… 1m 13s · ↓ 58.1k tokens」。空闲态的「✻ Worked for 46s · done」不含任何信号。
 */
export function paneLooksWorking(pane: string): boolean {
  const tail = pane.split("\n").slice(-14).join("\n");
  return paneMainTurnBusy(pane) || /Waiting for \d+ background/i.test(tail) || /\b(\d+m\s*)?\d+s\s*·\s*[↓↑]\s*[\d.]+k?\s*tokens/i.test(tail);
}

function mainTurn(i: TurnInput): MainTurn {
  if (i.status === "compacting") return "compacting";
  const cc = controlFor(i.runtime).paneHeuristics;
  // 压缩先于 thinking 判：回合中途的自动压缩事件态还是 thinking，手动 /compact 到 watcher 置态之间事件态是 done——
  // 这两段只有画面知道；判成 busy 的话人类消息会 C-c 掉压缩
  if (cc && i.pane !== null && paneShowsCompacting(i.pane)) return "compacting";
  if (i.status === "thinking") return cc && stuckThinkingIdle(i) ? "idle" : "busy";
  // Codex / Pi 的忙闲靠 hook 上报；它们的窗口套 CC 的屏幕正则会误命中（Pi 恒判忙），只看事件态
  if (!cc) return "idle";
  if (i.pane === null) return "unknown";
  if (paneMainTurnBusy(i.pane)) return "busy";
  // CC 的横幅和忙碌标记都不在（文案改了 / 弹窗盖住）：认不出，交给调用方按各自的保守方向处理
  return probeTuiContract(i.pane).suspect ? "unknown" : "idle";
}

/** 画面明确显示主回合空闲：输入框在、没有 spinner / 压缩 / API 重试横幅，而且 TUI 契约没失效（认不出不算空闲） */
export function paneClearlyIdle(pane: string | null | undefined): boolean {
  if (!pane?.trim()) return false;
  return paneIdleVerdict(pane) === "idle" && !paneMainTurnBusy(pane) && !paneShowsCompacting(pane) && !paneShowsApiRetry(pane);
}

/** 两帧都空闲之外，还要这么久没有任何活动：回合刚开始的几百毫秒里 spinner 还没出来，但消息刚投、会话记录刚写 */
export const STUCK_THINKING_QUIET_MS = 8_000;

/**
 * 事件态卡在 thinking（从终端打断不发 Stop、回合结束后又被点亮）而画面明确空闲：以画面为准。
 * 条件全要：相隔约 1 秒的两帧都明确空闲，且这段时间足够安静。压缩中、重试中、认不出画面一律不算，保持判忙。
 * 只对 CC（画面判据）有效，Codex / Pi 的忙闲只看事件态。单测 tests/turn-state.test.ts。
 */
function stuckThinkingIdle(i: Pick<TurnInput, "pane" | "paneAgain" | "quietMs">): boolean {
  return paneClearlyIdle(i.pane) && paneClearlyIdle(i.paneAgain) && (i.quietMs ?? 0) >= STUCK_THINKING_QUIET_MS;
}

export function turnState(input: TurnInput): TurnState {
  // capture-pane 在窗口 resize 后会带出成片尾部空行，把 spinner 挤出「尾部 14 行」（见 tmux-helper trimTrailingBlank）；
  // 剪完是空串 = 没抓到画面（tmuxRaw 出错也返回空串），按 null 算，否则会被判成 idle
  const i = { ...input, pane: input.pane?.replace(/\s+$/, "") || null, paneAgain: input.paneAgain?.replace(/\s+$/, "") || null };
  const main = mainTurn(i);
  const paneBg = controlFor(i.runtime).paneHeuristics && i.pane !== null && main !== "busy" && paneLooksWorking(i.pane);
  return { main, bg: paneBg || !!i.bgActive };
}

/**
 * agent→agent 消息（和 Autopilot 提醒）现在要不要先押着：主回合在跑 / 压缩中。只剩后台在跑不押。
 * 后台 subagent 结束时 CC 会立刻自动开 task-notification 回合，撞上它靠屏幕判忙（回合开头不带括号的 spinner 也认）；
 * 从 CC 排队通知到 spinner 第一帧之间仍有几十到几百毫秒看不出来——根治靠送达确认，不在这里。
 * 别按 bg-activity 的「结束」事件加时间窗：它 10 秒扫一轮，检测到时通知回合往往已经跑完（实测时序见 git log -S bgJustEnded）。
 * unknown 放行——认不出画面就押，消息可能永远投不出去。
 */
export function agentMsgMustWait(s: TurnState): boolean {
  return s.main === "busy" || s.main === "compacting";
}

/**
 * thinking 反向对账（permission-watcher）的单帧判据：事件态 thinking、顶格的真输入框在、主回合空闲、不是 bridge 经手的长 MCP 调用。
 * 只剩后台在跑不豁免——否则事件态卡在 thinking，上面的 main 一直是 busy，押后闸又回到「后台在跑就押」。
 * 权限框 / AskUserQuestion / 额度菜单里的「❯ 1.」不是输入框：认成输入框，弹窗开 2 分钟就会被收成 done。
 */
export function thinkingLooksStuck(pane: string, status: TurnStatus, externallyBusy: boolean): boolean {
  return status === "thinking" && turnZone(pane).box && !paneMainTurnBusy(pane) && !externallyBusy;
}
