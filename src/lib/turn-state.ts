/**
 * 「agent 忙不忙」的唯一判据：主回合（main）和后台活动（bg）分开报。纯函数，单测 tests/turn-state.test.ts。
 *
 * 押后闸 / flush / 两个抢占入口 / 值守都只看 main：主回合结束、只剩后台 subagent 时 CC 收到通知会正常开新回合，
 * 押着它只会让 agent 消息等到后台全部结束（git log -S agentMsgMustWait）；而那时的 C-c 会把后台 agent 全停掉。
 * bg 只给显示用（侧栏黄点仍是 paneLooksWorking，语义 = main 非 idle 或 bg）。
 */
import { controlFor } from "./runtimes/index.js";
import { paneLooksWorking, paneMainTurnBusy, paneShowsCompacting, probeTuiContract } from "./tmux-helper.js";

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

function mainTurn(i: TurnInput): MainTurn {
  if (i.status === "compacting") return "compacting";
  if (i.status === "thinking") return "busy";
  // Codex / Pi 的忙闲靠 hook 上报；它们的窗口套 CC 的屏幕正则会误命中（Pi 恒判忙），只看事件态
  if (!controlFor(i.runtime).paneHeuristics) return "idle";
  if (i.pane === null) return "unknown";
  // 手动 /compact 开始到 watcher 置 compacting 之间只有画面知道；排在 busy 前面，人类消息才不会 C-c 掉压缩
  if (paneShowsCompacting(i.pane)) return "compacting";
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
 * 后台 subagent 结束时 CC 会立刻自动开 task-notification 回合，撞上它靠屏幕判忙（spinner 一出来 main 就是 busy）；
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
