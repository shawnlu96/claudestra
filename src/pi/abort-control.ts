/**
 * Pi 扩展里 bridge 叫停（ws {type:"abort"}）的那一段：中止当前回合，并把「停之前 steer 进去、Pi 还没注入上下文」的 bridge 消息作废
 * （回执里列出来，bridge 逐条告诉发送方「没执行、要的话请重发」）。只依赖自己，扩展（claudestra-extension.ts）直接加载。
 * - TUI 模式：Pi 的中止处理把排队的 steer 消息退回输入框（同它的 Esc）。输入框不动（PM 定：终端里的人可能正在打字），
 *   回执里报退回了几条，bridge 写进 ⏹ 抬头；
 * - 叫停之后到 Pi settle 之前，Pi 自己又开的每一轮都再中止一次：TUI 下 ctx.abort() 不取消自动重试的退避和自动压缩，退避 / 压缩完
 *   Pi 会 continue；--mode rpc 下排队的消息马上续跑。这期间 bridge 送来的消息（多半就是那条「停」）不 steer（会被再中止退回输入框），
 *   押到 settle 后当新一轮投。单测 tests/pi-abort-control.test.ts。
 */

export interface AbortableCtx {
  abort?(): void;
  isIdle?(): boolean;
  hasPendingMessages?(): boolean;
  ui?: { getEditorText?(): string };
}

/** 一条 bridge 送进来的消息（Pi 在跑时 steer 进去） */
export interface SteeredMessage {
  text: string;
  messageId?: string;
}

/** 叫停之后最多这么久还在「叫停中」：Pi 的重试退避最长 8 秒，压缩可能更久；等不到 settle 就放开，别把后来的消息一直押着 */
const STOP_HOLD_MS = 60_000;

/** user 消息的正文（Pi 的 message.content 是字符串或 [{type:"text", text}]） */
function textOf(message: unknown): string | null {
  const m = message as { role?: string; content?: unknown } | null;
  if (!m || m.role !== "user") return null;
  if (typeof m.content === "string") return m.content;
  if (!Array.isArray(m.content)) return null;
  return m.content.map((c: { type?: string; text?: string }) => (c?.type === "text" ? (c.text ?? "") : "")).join("");
}

export function createAbortControl(now: () => number = Date.now) {
  let runCtx: AbortableCtx | undefined; // 最近一次 agent_start 的上下文
  let stoppedAt: number | undefined; // 叫停的时刻；settle 时清
  /** 本轮 steer 进去、还没出现在上下文里的 bridge 消息（按先后） */
  let steered: SteeredMessage[] = [];
  /** 叫停中送来的 bridge 消息：settle 后交回扩展投 */
  let deferred: string[] = [];
  const stopping = () => stoppedAt !== undefined && now() - stoppedAt < STOP_HOLD_MS;

  return {
    onRunStart(ctx: AbortableCtx): void {
      runCtx = ctx;
      if (stopping()) ctx.abort?.();
    },
    /** bridge 送来一条消息（注入之前调）：streaming = Pi 正在跑、这条会 steer 进去排队。返回 true = 叫停中，先别注入 */
    onBridgeMessage(m: SteeredMessage, streaming: boolean): boolean {
      if (stopping()) return deferred.push(m.text) > 0;
      if (streaming) steered.push(m);
      return false;
    },
    /** Pi 的 message_start：排队的消息注入上下文了（模型会看到、会照做），不再算「没执行」 */
    onMessageStart(message: unknown): void {
      const text = textOf(message);
      const i = text === null ? -1 : steered.findIndex((s) => s.text === text);
      if (i >= 0) steered.splice(i, 1);
    },
    /** Pi 停稳了：叫停到此为止，返回叫停中押下的 bridge 消息（按先后，扩展当新一轮投） */
    onSettled(): string[] {
      const late = deferred;
      steered = [], deferred = [], stoppedAt = undefined;
      return late;
    },
    /** 中止当前回合；返回回执的内容：结果、作废的消息 id、其中几条被 Pi 退回了输入框。没在跑 = idle（空闲时 abort 无意义，也没有排队的） */
    abort(): { result: "aborted" | "idle"; voided: string[]; inEditor: number } {
      const ctx = runCtx;
      if (!ctx || ctx.isIdle?.()) return { result: "idle", voided: [], inEditor: 0 };
      const voided = ctx.hasPendingMessages?.() ? steered : [];
      steered = [];
      stoppedAt = now();
      ctx.abort?.();
      const editor = ctx.ui?.getEditorText?.() ?? "";
      const ids = voided.map((v) => v.messageId).filter((id): id is string => !!id);
      return { result: "aborted", voided: ids, inEditor: voided.filter((v) => editor.includes(v.text)).length };
    },
  };
}
