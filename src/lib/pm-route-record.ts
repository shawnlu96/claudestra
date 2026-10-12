import { AsyncLocalStorage } from "node:async_hooks";
import type { DigestRecord } from "./pm-digest-store.js";
import type { PmRouteRecord } from "./pm-route-types.js";

interface Scope { route: PmRouteRecord; recorded: boolean }
const context = new AsyncLocalStorage<Scope>();

/** 原 PMDIG 分类仍自己一次原子写入记录和队列；这个同步作用域只追加 route 标签。 */
export function withPmRouteRecord<T>(route: PmRouteRecord, action: (scope: Scope) => T): T {
  const scope = { route, recorded: false };
  return context.run(scope, () => action(scope));
}

export function tagPmRouteRecord(rec: DigestRecord, log: readonly DigestRecord[], window: number): DigestRecord {
  const scope = context.getStore();
  if (!scope) return rec;
  scope.recorded = true;
  const { route } = scope;
  const duplicate = log.some((r) => r.project === rec.project && r.route?.messageId === route.messageId
    && rec.at - r.at < window);
  return duplicate ? rec : { ...rec, route };
}

/** 旧记录无新字段合法；拒绝坏标签而不是让投递路径在统计时抛错。 */
export function validPmRouteRecord(value: unknown): boolean {
  if (value === undefined) return true;
  if (!value || typeof value !== "object") return false;
  const r = value as PmRouteRecord;
  return typeof r.messageId === "string" && ["off", "observe", "on"].includes(r.mode) && Array.isArray(r.tags) && r.tags.every((t) =>
    !!t && ["auto", "digest", "judge", "owner"].includes(t.route) && typeof t.rule === "string" && typeof t.reason === "string"
    && (t.item === undefined || (Number.isInteger(t.item) && t.item > 0)) && (t.type === undefined || typeof t.type === "string"));
}
