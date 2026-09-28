/**
 * 「agent 忙不忙」的唯一判据：主回合（main）和后台活动（bg）分开报。纯函数，单测 tests/turn-state.test.ts。
 *
 * 押后闸 / flush / 两个抢占入口 / 值守都只看 main：主回合结束、只剩后台 subagent 时 CC 收到通知会正常开新回合，
 * 押着它只会让 agent 消息等到后台全部结束（押过 17 分钟）；而那时的 C-c 会把后台 agent 全停掉。
 * bg 只给显示用（侧栏黄点仍是 paneLooksWorking，语义 = main 非 idle 或 bg）。
 */
import { controlFor } from "./runtimes/index.js";
import { paneLooksWorking, paneMainTurnBusy, probeTuiContract } from "./tmux-helper.js";

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
  /** 最近一个后台 subagent 结束的时刻（ms），没有 = undefined */
  bgEndedAt?: number;
  now: number;
}

export interface TurnState {
  main: MainTurn;
  bg: boolean;
  /** 后台 subagent 刚结束：CC 马上要排 task-notification 开回合，这时到的通知可能落进回合开头的丢弃窗口 */
  bgJustEnded: boolean;
}

/** 防撞窗口。只罩得住 subagent（结束信号及时）；bg shell 靠 3 分钟无输出才判结束，罩不住 */
export const BG_SETTLE_MS = 10_000;

function mainTurn(i: TurnInput): MainTurn {
  if (i.status === "compacting") return "compacting";
  if (i.status === "thinking") return "busy";
  // Codex / Pi 的忙闲靠 hook 上报；它们的窗口套 CC 的屏幕正则会误命中（Pi 恒判忙），只看事件态
  if (!controlFor(i.runtime).paneHeuristics) return "idle";
  if (i.pane === null) return "unknown";
  if (paneMainTurnBusy(i.pane)) return "busy";
  // CC 的横幅和忙碌标记都不在（文案改了 / 弹窗盖住）：认不出，交给调用方按各自的保守方向处理
  return probeTuiContract(i.pane).suspect ? "unknown" : "idle";
}

export function turnState(input: TurnInput): TurnState {
  // capture-pane 在窗口 resize 后会带出成片尾部空行，把 spinner 挤出「尾部 14 行」（见 tmux-helper trimTrailingBlank）
  const i = { ...input, pane: input.pane === null ? null : input.pane.replace(/\s+$/, "") };
  const main = mainTurn(i);
  const paneBg = controlFor(i.runtime).paneHeuristics && i.pane !== null && main !== "busy" && paneLooksWorking(i.pane);
  const sinceEnd = i.bgEndedAt === undefined ? Infinity : i.now - i.bgEndedAt;
  return { main, bg: paneBg || !!i.bgActive, bgJustEnded: sinceEnd >= 0 && sinceEnd < BG_SETTLE_MS };
}

/**
 * agent→agent 消息（和值守提醒）现在要不要先押着：主回合在跑 / 压缩中 / 后台刚结束。
 * unknown 放行——认不出画面就押，消息可能永远投不出去；误投的代价只是撞上一次丢弃窗口。
 */
export function agentMsgMustWait(s: TurnState): boolean {
  return s.main === "busy" || s.main === "compacting" || s.bgJustEnded;
}
