/**
 * 本端气泡的守门标记（纯逻辑，tests/web-guard-marks.test.ts）：按发送接口回的 messageId 认气泡，不按正文猜（同文、超长都认得准）。
 * 事件和发送回执谁先到都行：回执没到时先收到的终态记在 finals，回执到了再合上，不会把「已丢弃」盖回「等放行」。
 */
export type GuardMarkState = "held" | "dropped";
type Action = "quarantined" | "released" | "dropped";
/** 回执迟迟不到的终态不能无限攒：留最近这么多条 */
const FINALS_MAX = 200;

export function createGuardMarks() {
  const marks = new Map<string, GuardMarkState>(); // 气泡 id → 状态
  const bubbles = new Map<string, string>(); // messageId → 气泡 id
  const finals = new Map<string, "released" | "dropped">();
  const apply = (bubble: string, s: GuardMarkState | "released") => {
    if (s === "released") marks.delete(bubble);
    else marks.set(bubble, s);
  };
  return {
    /** 发送接口回了 guarded */
    sent(messageId: string | undefined, bubbleId: string): void {
      if (messageId) bubbles.set(messageId, bubbleId);
      apply(bubbleId, (messageId && finals.get(messageId)) || "held");
    },
    /** 流里的守门事件（manage 设备的 chat_guard，或发件凭据自己的 chat_guard_status） */
    event(messageId: string, action: Action): void {
      const s = action === "quarantined" ? "held" : action;
      const bubble = bubbles.get(messageId);
      if (bubble) return apply(bubble, s);
      if (s === "held") return;
      finals.set(messageId, s);
      if (finals.size > FINALS_MAX) finals.delete(finals.keys().next().value!);
    },
    of: (bubbleId: string): GuardMarkState | null => marks.get(bubbleId) ?? null,
  };
}
