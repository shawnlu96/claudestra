/**
 * 升级闸对 transport=acp 窗口的判法（窗口里是宿主日志，画面不作数）：经 bridge 问宿主 AcpTurnLoop.busy（ws turn_status，
 * bridge/acp-turn-status.ts）。fail-closed：只有宿主明确答「空闲」才放行；查询失败、回包不合法、宿主不答（没连上 bridge、
 * 升级前起的旧宿主不认这个调用）一律当忙——在回合中途重启全员比晚点升级糟。代价是旧宿主会一直挡，所以连续查不到就往
 * #control 报一次（同一个更新版本里每个 agent 只报一次），说清是谁、怎么处理。tests/busy-windows.test.ts。
 */
export type AcpTurn = "busy" | "idle" | "unknown";

export interface AcpGateDeps {
  /** bridge 对 turn_status 的原始回包；连不上 / 超时 / bridge 回 error 就抛 */
  query(names: string[]): Promise<unknown>;
  /** 发到 #control，送到了回 true */
  notify(text: string): Promise<boolean>;
  log(msg: string): void;
}

/** 连续这么多次查不到才报：bridge 刚重启、宿主还在退避重连时查不到一两次是正常的 */
const UNKNOWN_STREAK = 2;
const TURNS: readonly AcpTurn[] = ["busy", "idle", "unknown"];

/** 回包 → 每个问到的 agent 的回合态；缺字段、值认不出、整包不合法的一律 unknown */
export function parseTurns(raw: unknown, names: string[]): Record<string, AcpTurn> {
  const turns = (raw as { turns?: unknown } | null | undefined)?.turns;
  const valueOf = (n: string) => (turns && typeof turns === "object" ? (turns as Record<string, unknown>)[n] : undefined);
  return Object.fromEntries(names.map((n) => [n, TURNS.find((t) => t === valueOf(n)) ?? "unknown"]));
}

const noticeText = (names: string[], key: string) =>
  `⚠️ 自动更新（${key}）被挡住：ACP agent ${names.join("、")} 连续查不到回合状态（宿主没答：多半是升级前起的旧宿主不认这个查询，或宿主没连上 bridge）。` +
  `为了不在回合中途重启，升级会一直等。确认空闲后逐个 ${names.map((n) => `\`bun src/manager.ts restart ${n.replace(/^agent-/, "")}\``).join("、")}` +
  ` 让宿主换上新代码；急着升级就手动 \`bun src/manager.ts update\`。`;

/** 返回「问这些 ACP agent，挡住升级的是谁」；key = 这次要升到的版本（SHA / tag），给了才发通知 */
export function acpTurnGate(deps: AcpGateDeps): (names: string[], key?: string) => Promise<string[]> {
  let streaks = new Map<string, number>();
  /** 这个版本已经报过的 agent；宿主答过（不再未知）或不再是 ACP 窗口就移出，之后再卡住会重报 */
  let notified = { key: "", agents: new Set<string>() };
  return async (names, key) => {
    if (!names.length) {
      streaks = new Map();
      notified = { key: notified.key, agents: new Set() };
      return [];
    }
    let why = "宿主没答";
    let turns: Record<string, AcpTurn>;
    try {
      turns = parseTurns(await deps.query(names), names);
    } catch (e) {
      why = `问 bridge 失败：${e instanceof Error ? e.message : String(e)}`; // 下一行日志带上原因；全部按未知 = 全部挡住
      turns = parseTurns(null, names);
    }
    const unknown = names.filter((n) => turns[n] === "unknown");
    streaks = new Map(unknown.map((n) => [n, (streaks.get(n) ?? 0) + 1]));
    if (unknown.length) deps.log(`⚠️ ${unknown.join(", ")} 的 ACP 回合态未知（${why}），按忙挡住升级`);
    const stuck = unknown.filter((n) => (streaks.get(n) ?? 0) >= UNKNOWN_STREAK);
    const kept = key === undefined || key === notified.key ? [...notified.agents].filter((n) => unknown.includes(n)) : [];
    notified = { key: key ?? notified.key, agents: new Set(kept) };
    const fresh = stuck.filter((n) => !notified.agents.has(n));
    if (key && fresh.length && (await deps.notify(noticeText(fresh, key)))) notified = { key, agents: new Set([...kept, ...fresh]) };
    return names.filter((n) => turns[n] !== "idle");
  };
}
