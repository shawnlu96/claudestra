/**
 * Codex 原生回合账（T52 Codex 复审 #204 第 6–7 轮）：只认 rollout 里 event_msg 的 task_started / task_complete / turn_aborted，
 * 按频道记开着的回合和未决投递。消费关系只按先后判：一条投递只能被「它投出去之后才到的 task_started」消费，回合结束只清被这个
 * 回合消费的；之后才投的继续挂着。基线未知时投的也记。账本绑定 sessionId 和 watcher 代际：重挂（从 EOF 读，中间可能漏了边界）、
 * 换会话一律 known=false、未决保留，旧代际的回调写不进来。超过容量转成 unknown，不丢条目倒推空闲。
 * 投递失败能不能收 done 只看 codexConfirmedIdle。tests/pi-abort-control.test.ts
 */

export type CodexTurnMark = { kind: "start" | "end"; turnId: string };

/** rollout 一行是不是原生回合边界（task_complete 带 error 也算结束）；不是 JSON / 不是边界 = null */
export function codexTurnMark(line: string): CodexTurnMark | null {
  if (!line.includes('"event_msg"')) return null;
  let e: { type?: unknown; payload?: { type?: unknown; turn_id?: unknown } };
  try {
    e = JSON.parse(line);
  } catch {
    return null; // 半行 / 坏行：不是边界，watcher 那边照常按自己的规则处理这一行
  }
  const t = e?.type === "event_msg" ? e.payload?.type : undefined;
  const turnId = typeof e?.payload?.turn_id === "string" ? e.payload.turn_id : "";
  if (t === "task_started") return { kind: "start", turnId };
  if (t === "task_complete" || t === "turn_aborted") return { kind: "end", turnId };
  return null;
}

/** 一个频道最多挂这么多条未决投递；超了就当拿不准（overflow），直到换会话 / 被清掉 */
const PENDING_CAP = 200;

interface Book {
  /** 这一代 watcher 见过原生边界（连续读着）；重挂 / 换会话后为 false */
  known: boolean;
  open: Set<string>;
  /** 未决投递：messageId → 被哪个回合消费（还没被消费 = ""） */
  pending: Map<string, string>;
  overflow: boolean;
  sessionId: string;
  /** 当前这一代 watcher（jsonl-watcher 的 state 对象）；旧代际的回调不认 */
  gen: object | null;
}

const books = new Map<string, Book>();
const bookOf = (ch: string): Book => {
  let b = books.get(ch);
  if (!b) books.set(ch, (b = { known: false, open: new Set(), pending: new Map(), overflow: false, sessionId: "", gen: null }));
  return b;
};

/** jsonl-watcher 新建一代监听时调（从文件末尾开始读，中间的边界可能漏了）：known=false，未决投递保留；换了会话连开着的回合一起作废 */
export function attachCodexTurns(runtime: string | undefined, channelId: string, sessionId: string, gen: object): void {
  if (runtime !== "codex" || !channelId) return;
  const b = bookOf(channelId);
  if (b.sessionId && b.sessionId !== sessionId) b.overflow = false;
  b.open.clear();
  b.sessionId = sessionId;
  b.gen = gen;
  b.known = false;
}

/** watcher 每读一行 Codex rollout 调一次（别的 runtime 直接返回）。gen = 读这一行的那一代 watcher */
export function noteCodexTurnLine(runtime: string | undefined, channelId: string, line: string, gen?: object): void {
  if (runtime !== "codex" || !channelId) return;
  const m = codexTurnMark(line);
  if (!m) return;
  const b = bookOf(channelId);
  if (gen && b.gen && b.gen !== gen) return; // 旧代际的 watcher 回调
  b.known = true;
  if (m.kind === "start") {
    b.open.add(m.turnId);
    for (const [id, by] of b.pending) if (!by) b.pending.set(id, m.turnId || "?"); // 这之前投的被这个回合消费
    return;
  }
  if (!m.turnId) return; // turn_aborted 没带 turn_id：不知道结束的是哪一个，已开的回合不清
  b.open.delete(m.turnId);
  for (const [id, by] of b.pending) if (by === m.turnId) b.pending.delete(id);
}

/** 消息 ws.send 给了 Codex 频道（基线未知也记，作为未决） */
export function noteCodexSent(channelId: string, messageId: string): void {
  const b = bookOf(channelId);
  if (b.overflow) return;
  b.pending.set(messageId, "");
  if (b.pending.size > PENDING_CAP) {
    b.overflow = true;
    b.pending.clear(); // 已经拿不准了，清掉只为不占内存；overflow 让 codexConfirmedIdle 一直为 false
  }
}

/** channel-server 报这条没投进 Codex：它不会开回合，不再算未决 */
export function noteCodexFailed(channelId: string, messageId: string): void {
  books.get(channelId)?.pending.delete(messageId);
}

/** 确认空闲：这一代 watcher 见过原生边界、没有开着的回合、没有未决投递、没溢出 */
export function codexConfirmedIdle(channelId: string): boolean {
  const b = books.get(channelId);
  return !!b && b.known && !b.overflow && b.open.size === 0 && b.pending.size === 0;
}

/** agent 被 kill / 频道复用前清掉 */
export function forgetCodexTurns(channelId: string): void {
  books.delete(channelId);
}
