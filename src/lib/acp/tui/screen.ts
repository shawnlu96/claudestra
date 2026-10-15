/**
 * ACP 终端视图（TTY 上的新画法，src/acp-host.ts 接线；出异常自动退回 tty-screen.ts 的逐行视图，见 guard.ts）。
 * 两个入口，和逐行视图同一个接口（TtyScreen）：show(段) 收宿主翻好的段（transcript.ts：已脱敏、已截断），update(更新) 收原始 session/update。
 * 屏幕分两块：上面是定稿内容（写一行进一行 tmux 滚动记录，之后不再动），下面是底栏（在跑的工具、思考预览、表格预览、输入框、状态栏），
 * 有变化就擦掉重画（painter.ts）。正文边收边按 Markdown 排（transcript-stream.ts 只放整行，message.ts / markdown.ts 逐行排），不整屏重画历史。
 * 分层与给新 harness 接入：docs/architecture/acp-terminal.md。tests/acp-tui-screen.test.ts。
 */
import { redactSecrets } from "../../redact-secrets.js";
import { createTextStream } from "../transcript-stream.js";
import { clipThought } from "../transcript.js";
import type { TtyScreen } from "../tty-screen.js";
import { elapsed, type TurnState } from "../tty-status.js";
import { itemRows, kindOf, toolOf, toolRows, toolSpans, type ItemKind } from "./blocks.js";
import { inputBox, statusLine, type InputDraft } from "./footer.js";
import { createSessionInfo, createThought, createToolTracker, type LiveTool, type Settled } from "./live.js";
import { createMessageWriter } from "./message.js";
import { createPainter, GAP_MARK } from "./painter.js";
import { fitLine, sgr, span } from "./text.js";

export interface TuiIo {
  write(s: string): void;
  columns(): number;
  rows?(): number;
}

export interface TuiScreen extends TtyScreen {
  /** 会话配置项（宿主出给 bridge 的 configOptions，acp-host.ts 接线）：状态栏的模型 / effort */
  config(raw: unknown): void;
}

/** 前面空一行再画的元素（一组工具调用、结果之间不空）；回合分隔后面也空一行，和输入框的线隔开 */
const GAP: ReadonlySet<ItemKind> = new Set(["message", "inbound", "permission", "plan", "stop", "thinking", "failure", "notice"]);
const LIVE_TOOLS = 5, LIVE_TABLE = 8;

type Rec = Record<string, any>;

/** 底栏的「正在发生」：思考预览、还压着的表格、在跑的工具（计时 + 转圈，按秒走） */
function liveRows(thought: string | null, table: string[], running: readonly LiveTool[], cols: number, t: number): string[] {
  const out: string[] = [];
  if (thought !== null) out.push(fitLine([span(`✻ ${thought || "思考中…"}`, "2;3")], cols));
  out.push(...table.slice(0, LIVE_TABLE));
  out.push(...running.slice(0, LIVE_TOOLS).map((x) => fitLine(toolSpans(x, elapsed(t - x.since), Math.floor(t / 1000)), cols)));
  if (running.length > LIVE_TOOLS) out.push(sgr("2", `  … 还有 ${running.length - LIVE_TOOLS} 个在跑`));
  return out;
}

export function createTuiScreen(io: TuiIo, state: () => TurnState, now: () => number = Date.now, input?: () => InputDraft | undefined): TuiScreen {
  const stream = createTextStream(), tools = createToolTracker(now), thought = createThought(), info = createSessionInfo();
  const cols = () => Math.max(8, io.columns());
  let busySince: number | null = null, inTools = false;
  /** 思考段先压着：紧跟的 agent_thought_chunk 带来原文就按原文多行重排（段是压成一行的），没有就照段画 */
  let thinking: { item: string; at: Date } | null = null;
  const gap = (): string[] => ((inTools = false), [GAP_MARK]);
  const msg = createMessageWriter(cols, gap);

  const painter = createPainter(io, () => {
    const s = state(), c = cols(), t = now();
    busySince = s.busy ? (busySince ?? t) : null;
    const d = input?.();
    const fixed = [...(d ? inputBox(d, c) : []), statusLine(s, info.get(), busySince === null ? 0 : t - busySince, c)];
    const live = liveRows(thought.active() ? thought.preview() : null, msg.pending(), tools.running(), c, t);
    return [...live.slice(-Math.max(0, (io.rows?.() ?? 40) - 2 - fixed.length)), ...fixed];
  });

  /** 定稿的工具调用：一组连着的工具前面空一行，组内不空 */
  const settledRows = (s: Settled[]): string[] => {
    if (!s.length) return [];
    const lead = inTools ? [] : gap();
    inTools = true;
    return [...lead, ...s.flatMap((x) => [...(x.tool ? toolRows(x.tool, cols()) : []), ...(x.result ? itemRows("result", x.result, cols(), new Date()) : [])])];
  };

  const piece = (item: string, at: Date): string[] => {
    const kind = kindOf(item);
    if (kind !== "result" && kind !== "inbound") thought.clear();
    switch (kind) {
      case "message":
        return [...msg.lines(item.split("\n")), ...msg.end()];
      case "tool":
        return (tools.start(toolOf(item).name, toolOf(item).arg), []);
      case "result":
        return (tools.result(item), []);
      case "stop":
        info.compacting(false);
        return [...settledRows(tools.endTurn()), ...gap(), ...itemRows(kind, item, cols(), at), GAP_MARK];
      default:
        if (item === "✻ 上下文已压缩") info.compacting(false);
        inTools = false;
        return [...(GAP.has(kind) ? gap() : []), ...itemRows(kind, item, cols(), at)];
    }
  };

  /** 压着的思考段落下去：text = 紧跟的 agent_thought_chunk 原文（没有就照段画） */
  const flushThinking = (text?: string): string[] => {
    if (!thinking) return [];
    const { item, at } = thinking;
    thinking = null;
    return piece(text === undefined ? item : `✻ ${clipThought(text)}`, at);
  };

  return {
    show(item, at = new Date()) {
      const out = [...flushThinking(), ...settledRows(tools.orphans())];
      const pieces = stream.settle(item).map(redactSecrets);
      // 流着的正文的终稿：只补没显示的行（可能一行都不剩）；对不上时 settle 原样还回整段，按新消息重画
      if (msg.open() && kindOf(item) === "message" && !(pieces.length === 1 && pieces[0] === redactSecrets(item))) {
        out.push(...msg.lines(pieces.flatMap((p) => p.split("\n"))), ...msg.end());
      } else {
        if (kindOf(item) !== "inbound") out.push(...msg.end());
        for (const p of pieces) {
          if (kindOf(p) === "thinking" && p !== "✻ 上下文已压缩") thinking = { item: p, at };
          else out.push(...piece(p, at));
        }
      }
      painter.commit(out);
    },
    update(update) {
      const u = (update ?? {}) as Rec;
      const text = u.sessionUpdate === "agent_thought_chunk" && typeof u.content?.text === "string" ? u.content.text : undefined;
      // 压着的思考段配上它的原文：已经进滚动记录了，底栏不再预览一遍
      const own = thinking !== null && text !== undefined;
      const out = [...flushThinking(text), ...msg.lines(stream.chunk(u))];
      if (text !== undefined && !own) thought.add(text);
      else if (["agent_message_chunk", "tool_call", "plan"].includes(u.sessionUpdate)) thought.clear();
      info.update(u);
      out.push(...settledRows(tools.update(u)));
      painter.commit(out);
    },
    print: (line) => ((inTools = false), painter.commit(itemRows("plain", redactSecrets(line), cols(), new Date()))),
    config: (raw) => void (info.config(raw) && painter.commit([])),
    tick: () => painter.commit([...flushThinking(), ...settledRows(tools.orphans())]),
    resize: () => painter.redraw(),
    close: () => (painter.commit(flushThinking()), painter.close()),
  };
}
