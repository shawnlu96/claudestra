/** 台账 meta 里的编排班子配置（docs 10-ledger「附：编排班子」）；从 ledger-store.ts 拆出，getMeta 用 toTeam 解析 */

/** 开了才有事件路由；dispatcher 为 null = 交付直接通知 PM。只有 owner 能设 */
export interface TeamConfig {
  dispatcher: string | null;
  /** 巡检开关，T29 读 */
  audit: boolean;
  /** 开班子那条 meta 事件的 seq：路由只管它之后的事件，开班子前的历史不补发 */
  sinceSeq: number;
}

/** 库里存的 JSON → TeamConfig；没有 sinceSeq（不是经 meta --team 写的）按没开班子算 */
export function toTeam(v: unknown): TeamConfig | null {
  if (!v || typeof v !== "object") return null;
  const t = v as Record<string, unknown>;
  if (typeof t.sinceSeq !== "number") return null;
  return { dispatcher: typeof t.dispatcher === "string" && t.dispatcher ? t.dispatcher : null, audit: t.audit !== false, sinceSeq: t.sinceSeq };
}

/** 「真 PM」：master / owner，或 PM 名单里、但不是在任调度助理的（调度助理靠 PM 身份跑 dispatch / review，名单和合并类出口不给它） */
export function isRealPmRole(role: string | null, actor: string, team: TeamConfig | null): boolean {
  return role === "master" || role === "owner" || (role === "pm" && team?.dispatcher !== actor);
}
