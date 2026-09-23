/**
 * 未读计数的「哪些行算数」规则（纯函数，tests/web-unread-keys.test.ts）。
 *
 * App 图标角标 = agent_unread 全表之和，而侧栏只能清掉**列表里看得见**的 agent。
 * 表里若留着列表里没有的行，角标就永远降不到 0：
 *   - 已删除的 agent（manager kill 不会、也不该跨进程去删 web 的库）；
 *   - master：bridge 事件里叫 "master"，前端会话名是 "__master__"，按设计不计未读
 *     （markActiveRead 不给它发已读），却一直在被 +1。
 */

/** 这条回复要不要计未读。agent 为 bridge 侧短名（已去掉 agent- 前缀）。 */
export function countsUnread(agent: string): boolean {
  return !!agent && agent !== "master";
}

/**
 * 找出该清掉的行：不在当前 agent 列表里的（前端名，去掉 agent- 前缀后比较）。
 * 返回要删的 agent，以及其中是否有 count>0 的（决定要不要向各端同步角标）。
 */
export function unreadOrphans(
  rows: { agent: string; count: number }[],
  liveNames: Iterable<string>,
): { agents: string[]; hadUnread: boolean } {
  const live = new Set<string>();
  for (const n of liveNames) live.add(n.replace(/^agent-/, ""));
  const gone = rows.filter((r) => !countsUnread(r.agent) || !live.has(r.agent));
  return { agents: gone.map((r) => r.agent), hadUnread: gone.some((r) => r.count > 0) };
}

/**
 * 这条发给 api: 地址的回复算不算「我的」对话（推送 + 计未读）。只有本 web 自己的 token 算：
 * peer 和其它 token 跟 agent 的往来不打扰 owner（2026-09-23：peer 每问一次 agent，owner 手机就响）。
 * myChatId 拿不到（老 bridge 没有 /whoami）时退回旧行为：所有 api: 对话都算。
 */
export function isMyApiChat(chatId: string, myChatId: string | null): boolean {
  if (!chatId.startsWith("api:")) return false;
  return !myChatId || chatId === myChatId;
}
