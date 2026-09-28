/**
 * 「agent 忙不忙」的唯一判据：主回合（main）和后台活动（bg）分开报。纯函数，单测 tests/turn-state.test.ts。
 *
 * 押后闸 / flush / 两个抢占入口 / 值守都只看 main：主回合结束、只剩后台 subagent 时 CC 收到通知会正常开新回合，
 * 押着它只会让 agent 消息等到后台全部结束（git log -S agentMsgMustWait）；而那时的 C-c 会把后台 agent 全停掉。
 * bg 只给显示用（侧栏黄点仍是 paneLooksWorking，语义 = main 非 idle 或 bg）。
 */
import { controlFor } from "./runtimes/index.js";
import { CC_BUSY_RE, probeTuiContract } from "./tmux-helper.js";

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
}

export interface TurnState {
  main: MainTurn;
  bg: boolean;
}

/**
 * 主回合信号所在的区域，按输入框定位、不按固定尾部行数：底栏的后台 agent 行一多（80 列约 4 行、272 列约 6 行）
 * 就把 spinner 挤出「尾部 14 行」。above = 输入框上边框往上 12 行（spinner / 压缩行 / Tip / 任务列表最多 5 行 + 「… +N」
 * + 排队消息预览），rest = 边框到底（❯ 行、页脚）。
 * 找不到输入框（窄窗口折行、弹窗盖住）退回尾部 14 行。
 */
function turnZone(pane: string): { above: string; rest: string } {
  const lines = pane.replace(/\s+$/, "").split("\n");
  for (let i = lines.length - 1; i > 0; i--) {
    if (/^\s*❯/.test(lines[i]!) && /^\s*─{8,}/.test(lines[i - 1]!)) {
      return { above: lines.slice(Math.max(0, i - 13), i - 1).join("\n"), rest: lines.slice(i - 1).join("\n") };
    }
  }
  return { above: lines.slice(-14).join("\n"), rest: "" };
}

/**
 * 画面上是否在压缩上下文：spinner 位置那一行是「✻ Compacting conversation…」。锚定 spinner 行形态——正文里提到 compacting
 * 不算；结束后 CC 打印的是「Compacted (ctrl+o …)」，不会误判成仍在压缩。permission-watcher 置 compacting 也用它。
 */
export function paneShowsCompacting(pane: string): boolean {
  return /^\s*[·✢✳✶✻✽*]\s+Compacting\b/im.test(turnZone(pane).above);
}

/** 只认主回合在跑：spinner（CC_BUSY_RE，锚定行首）、老 TUI 的 esc to interrupt、排队消息提示。见 tests/pane-main-turn.test.ts。 */
export function paneMainTurnBusy(pane: string): boolean {
  const z = turnZone(pane);
  return CC_BUSY_RE.test(z.above) || /esc to interrupt|Press up to edit queued messages/i.test(`${z.above}\n${z.rest}`);
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
  if (i.status === "thinking") return "busy";
  // Codex / Pi 的忙闲靠 hook 上报；它们的窗口套 CC 的屏幕正则会误命中（Pi 恒判忙），只看事件态
  if (!cc) return "idle";
  if (i.pane === null) return "unknown";
  if (paneMainTurnBusy(i.pane)) return "busy";
  // CC 的横幅和忙碌标记都不在（文案改了 / 弹窗盖住）：认不出，交给调用方按各自的保守方向处理
  return probeTuiContract(i.pane).suspect ? "unknown" : "idle";
}

export function turnState(input: TurnInput): TurnState {
  // capture-pane 在窗口 resize 后会带出成片尾部空行，把 spinner 挤出「尾部 14 行」（见 tmux-helper trimTrailingBlank）；
  // 剪完是空串 = 没抓到画面（tmuxRaw 出错也返回空串），按 null 算，否则会被判成 idle
  const i = { ...input, pane: input.pane?.replace(/\s+$/, "") || null };
  const main = mainTurn(i);
  const paneBg = controlFor(i.runtime).paneHeuristics && i.pane !== null && main !== "busy" && paneLooksWorking(i.pane);
  return { main, bg: paneBg || !!i.bgActive };
}

/**
 * agent→agent 消息（和值守提醒）现在要不要先押着：主回合在跑 / 压缩中。只剩后台在跑不押。
 * 后台 subagent 结束时 CC 会立刻自动开 task-notification 回合，撞上它靠屏幕判忙（回合开头不带括号的 spinner 也认）；
 * 从 CC 排队通知到 spinner 第一帧之间仍有几十到几百毫秒看不出来——根治靠送达确认，不在这里。
 * 别按 bg-activity 的「结束」事件加时间窗：它 10 秒扫一轮，检测到时通知回合往往已经跑完（实测时序见 git log -S bgJustEnded）。
 * unknown 放行——认不出画面就押，消息可能永远投不出去。
 */
export function agentMsgMustWait(s: TurnState): boolean {
  return s.main === "busy" || s.main === "compacting";
}

/**
 * thinking 反向对账（permission-watcher）的单帧判据：事件态 thinking、CC 输入框在、主回合空闲、不是 bridge 经手的长 MCP 调用。
 * 只剩后台在跑不豁免——否则事件态卡在 thinking，上面的 main 一直是 busy，押后闸又回到「后台在跑就押」。
 */
export function thinkingLooksStuck(pane: string, status: TurnStatus, externallyBusy: boolean): boolean {
  return status === "thinking" && /❯/.test(pane) && !paneMainTurnBusy(pane) && !externallyBusy;
}
