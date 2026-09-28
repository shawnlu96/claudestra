/**
 * Pi 扩展里 bridge 叫停（ws {type:"abort"}）的那一段：中止当前回合，并把「停之前 steer 进去、Pi 还没注入上下文」的 bridge 消息作废
 * （回执里列出来，bridge 逐条告诉发送方「没执行、要的话请重发」）。只依赖自己，扩展（claudestra-extension.ts）直接加载。
 * - TUI 模式：Pi 的中止处理把排队的 steer 消息退回输入框（同它的 Esc）——把作废的这几条从输入框里拿掉，人在终端里打的字留着，
 *   否则它们会跟着下一次回车一起提交；
 * - 没有这个处理（--mode rpc）：Pi 马上拿排队消息开下一轮（agent-session _handlePostAgentRun）——那一轮在 agent_start 上再中止一次，
 *   bridge 的下一条消息（就是那条「停」）到了、或过了 3 秒就不再拦。单测 tests/pi-abort-control.test.ts。
 */

export interface AbortableCtx {
  abort?(): void;
  isIdle?(): boolean;
  hasPendingMessages?(): boolean;
  ui?: { getEditorText?(): string; setEditorText?(text: string): void };
}

/** 一条 bridge 送进来的消息（Pi 在跑时 steer 进去） */
export interface SteeredMessage {
  text: string;
  messageId?: string;
}

const REABORT_WINDOW_MS = 3_000;

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
  let reabortUntil = 0;
  /** 本轮 steer 进去、还没出现在上下文里的 bridge 消息（按先后） */
  let steered: SteeredMessage[] = [];

  return {
    onRunStart(ctx: AbortableCtx): void {
      runCtx = ctx;
      if (now() < reabortUntil) {
        reabortUntil = 0;
        ctx.abort?.();
      }
    },
    /** bridge 送来一条消息（注入之前调）：streaming = Pi 正在跑、这条会 steer 进去排队 */
    onBridgeMessage(m: SteeredMessage, streaming: boolean): void {
      reabortUntil = 0;
      if (streaming) steered.push(m);
    },
    /** Pi 的 message_start：排队的消息注入上下文了（模型会看到、会照做），不再算「没执行」 */
    onMessageStart(message: unknown): void {
      const text = textOf(message);
      const i = text === null ? -1 : steered.findIndex((s) => s.text === text);
      if (i >= 0) steered.splice(i, 1);
    },
    onSettled(): void {
      steered = [];
    },
    /** 中止当前回合；返回结果和作废的消息。没在跑 = idle（空闲时 abort 无意义，也没有排队的） */
    abort(): { result: "aborted" | "idle"; voided: SteeredMessage[] } {
      const ctx = runCtx;
      if (!ctx || ctx.isIdle?.()) return { result: "idle", voided: [] };
      const voided = ctx.hasPendingMessages?.() ? steered : [];
      steered = [];
      ctx.abort?.();
      const ui = ctx.ui;
      if (voided.length && ui?.getEditorText && ui.setEditorText) {
        let t = ui.getEditorText();
        for (const v of voided) t = t.replace(v.text, "");
        ui.setEditorText(t.replace(/^\s+|\s+$/g, ""));
      }
      if (ctx.hasPendingMessages?.()) reabortUntil = now() + REABORT_WINDOW_MS;
      return { result: "aborted", voided };
    },
  };
}
