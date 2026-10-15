/**
 * 收兼容的退出判定：所有条件都由样本里的实测证明才放行，任何一格 "unknown" 都记一条拒绝理由。
 * 顺序：节点全认新族且全发新族 → 切新之后的完整窗口里每格旧计数都是实测 0 → 存量载荷全过期 / 实测无存活
 * → 回滚期已满 → 基础设施（域名、VAPID、systemd/nginx、安装副本）完成。只产出理由列表，不做任何写入。
 */
import { requiredWindowMs } from "./lifetimes.js";
import {
  AREAS, CENTER_AREAS, CLIENT_KINDS, DIRECTIONS, INFRA_ITEMS, NODE_KINDS, PAYLOAD_KINDS,
  type Count, type ExitReason, type Instant, type ObservationSample,
} from "./types.js";

type Push = (code: string, subject?: string) => void;

/** 旧计数必须是实测 0：>0 是有旧流量，"unknown" 是没观测到，两者都拒 */
function zero(c: Count, push: Push, code: string, subject?: string): void {
  if (c === "unknown") push(`${code}_unknown`, subject);
  else if (c > 0) push(code, subject);
}

/** 存量最晚过期时刻必须已过：null = 实测没有存量；"unknown" = 没观测到 */
function expired(at: Instant, now: number, push: Push, code: string, subject?: string): void {
  if (at === "unknown") push(`${code}_unknown`, subject);
  else if (at !== null && at > now) push(code, subject);
}

function nodes(s: ObservationSample, push: Push): void {
  if (s.fleet.machines === "unknown" || s.fleet.machines === 0) push("fleet_unknown");
  for (const kind of NODE_KINDS) {
    const have = s.nodes.filter((n) => n.kind === kind).length;
    const want = kind === "machine" && typeof s.fleet.machines === "number" ? s.fleet.machines : 1;
    if (have < want) push("fleet_incomplete", kind);
  }
  for (const n of s.nodes) {
    if (n.version === "unknown") push("node_version_unknown", n.id);
    if (n.receiveFloka !== true) push(n.receiveFloka === "unknown" ? "node_receive_unknown" : "node_receive_not_new", n.id);
    if (n.sendFamily !== "floka") push(n.sendFamily === "unknown" ? "node_send_unknown" : "node_send_not_new", n.id);
  }
}

function traffic(s: ObservationSample, push: Push): void {
  for (const direction of DIRECTIONS) {
    for (const area of AREAS) {
      const sources = CENTER_AREAS.includes(area) ? (["machine", "center"] as const) : (["machine"] as const);
      for (const source of sources) {
        const subject = `${direction}/${area}/${source}`;
        const cell = s.traffic.find((t) => t.direction === direction && t.area === area && t.source === source);
        zero(cell ? cell.legacy : "unknown", push, "legacy_traffic", subject);
      }
    }
  }
}

function windowCheck(s: ObservationSample, now: number, push: Push): void {
  const switched = s.allNewSendAt;
  if (switched === null) push("not_all_send_new");
  else if (switched === "unknown") push("switch_time_unknown");
  if (s.window === "unknown") { push("window_unknown"); return; }
  if (s.window.end > now) push("window_in_future");
  if (typeof switched === "number" && s.window.start < switched) push("window_before_switch");
  if (s.window.end - s.window.start < requiredWindowMs()) push("window_too_short");
}

function rollback(s: ObservationSample, now: number, push: Push): void {
  if (s.rollbackPeriodMs === "unknown") { push("rollback_unknown"); return; }
  if (typeof s.allNewSendAt !== "number") return;
  if (now - s.allNewSendAt < s.rollbackPeriodMs) push("rollback_open");
}

function holders(s: ObservationSample, now: number, push: Push): void {
  zero(s.sessions.legacyMcp, push, "legacy_sessions");
  for (const kind of CLIENT_KINDS) {
    const c = s.clients.find((x) => x.kind === kind);
    zero(c ? c.legacy : "unknown", push, "legacy_clients", kind);
    zero(c ? c.offline : "unknown", push, "offline_clients", kind);
  }
  zero(s.pending.legacyCalls, push, "pending_calls");
  expired(s.pending.maxExpiresAt, now, push, "pending_unexpired");
  for (const kind of PAYLOAD_KINDS) {
    const p = s.payloads.find((x) => x.kind === kind);
    zero(p ? p.legacyLive : "unknown", push, "payload_live", kind);
    expired(p ? p.maxExpiresAt : "unknown", now, push, "payload_unexpired", kind);
  }
}

/** 中心（私仓中继 / 台账中心）的观察一格都没有：这是缺实现，列为阻塞而不是零流量 */
export function centerBlocked(s: ObservationSample): boolean {
  return !s.traffic.some((t) => t.source === "center");
}

export function exitReasons(s: ObservationSample, now: number): ExitReason[] {
  const out: ExitReason[] = [];
  const push: Push = (code, subject) => out.push(subject === undefined ? { code } : { code, subject });
  nodes(s, push);
  traffic(s, push);
  windowCheck(s, now, push);
  rollback(s, now, push);
  holders(s, now, push);
  for (const item of INFRA_ITEMS) if (s.infra[item] !== "done") push(`infra_${s.infra[item]}`, item);
  if (centerBlocked(s)) push("center_observation_missing");
  return out;
}

