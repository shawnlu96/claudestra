/**
 * 页面收 Service Worker「打开」消息（web/public/sw.js 发）：品牌两族类型都认，同一条只处理一次。
 * 页面侧去重只有这一份；类型名与 src/lib/floka-browser-protocol/names.ts（openAgent / openAsk）同值
 * （web 不 import src，tests/floka-browser-protocol.test.ts 钉住两边相等）：
 *   · 新 SW 发的 type 恒为旧族、带新族 alias 与 id → 按 id 去重；旧 SW 发的没有 id → 按内容 2 秒内去重；
 *   · 只发新族 type 的 SW 也认。
 * 按 kind 分单例（chat.tsx 收 agent、asks-store.ts 收 ask）：两个监听器都会收到每条消息，同一个去重表会让先判的吃掉后判的；
 * 单例而不是每个 effect 新建：effect 重跑（换 store）不清去重记录。不论 rename.browserProtocol 档位都生效（纯收紧）。
 * 纯模块：不引 React，顶层不碰 navigator / window。去重只靠内存，不假设已有 CacheStorage。
 */
export const SW_OPEN_TYPES = {
  agent: ["cstra-open-agent", "floka-open-agent"],
  ask: ["cstra-open-ask", "floka-open-ask"],
} as const;

export type SwOpenKind = keyof typeof SW_OPEN_TYPES;
export interface SwOpen { kind: SwOpenKind; value: string; fp: string }

export function createSwInbox(kind: SwOpenKind, now: () => number = Date.now, windowMs = 2000): (raw: unknown) => SwOpen | null {
  const seen = new Map<string, number>();
  const types: readonly string[] = SW_OPEN_TYPES[kind];
  return (raw) => {
    const d = raw as { type?: unknown; id?: unknown; agent?: unknown; ask?: unknown; fp?: unknown } | null;
    if (!d || typeof d !== "object" || typeof d.type !== "string" || !types.includes(d.type)) return null;
    const v = kind === "agent" ? d.agent : d.ask;
    if (!v) return null;
    const open: SwOpen = { kind, value: String(v), fp: typeof d.fp === "string" ? d.fp : "" };
    const key = typeof d.id === "string" && d.id ? `id:${d.id}` : `c:${open.value}\n${open.fp}`;
    const t = now();
    for (const [k, at] of seen) if (k.startsWith("c:") && t - at > windowMs) seen.delete(k);
    if (seen.has(key)) return null;
    if (seen.size >= 200) seen.delete(seen.keys().next().value!);
    seen.set(key, t);
    return open;
  };
}

const inboxes: Record<SwOpenKind, (raw: unknown) => SwOpen | null> = { agent: createSwInbox("agent"), ask: createSwInbox("ask") };

/** 两个 SW message 监听器的唯一判定：是这个 kind 的「打开」消息且没处理过，才调 run */
export function onSwOpen(kind: SwOpenKind, raw: unknown, run: (o: SwOpen) => void): void {
  const o = inboxes[kind](raw);
  if (o) run(o);
}
