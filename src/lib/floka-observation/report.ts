/**
 * 报告只由解析后的样本拼出：数值、枚举、受限 id，没有一处回显样本原文，因此天然脱敏。
 * 没观测到的格子原样写 "unknown"，不补 0；退出结论与理由来自 exit.ts，阻塞单列（中心观察缺实现）。
 */
import { centerBlocked, exitReasons } from "./exit.js";
import { PAYLOAD_LIFETIMES, requiredWindowMs } from "./lifetimes.js";
import type { ObservationGear } from "./gear.js";
import {
  AREAS, CENTER_AREAS, CLIENT_KINDS, DIRECTIONS, NODE_KINDS, PAYLOAD_KINDS,
  type Count, type ExitReason, type InfraItem, type InfraState, type Instant, type ObservationSample, type ObservedNode,
} from "./types.js";

type FamilyCounts = { legacy: Count; floka: Count };

export interface ObservationReport {
  v: 1;
  gear: ObservationGear;
  generatedAt: number;
  families: Record<string, Record<string, Record<string, FamilyCounts>>>;
  versions: Record<string, Omit<ObservedNode, "kind">[]>;
  sessions: { legacyMcp: Count };
  clients: Record<string, { legacy: Count; offline: Count }>;
  pending: { legacyCalls: Count; maxExpiresAt: Instant };
  payloads: Record<string, { lifetimeMs: number | "unknown"; legacyLive: Count; maxExpiresAt: Instant }>;
  window: {
    start: number | "unknown"; end: number | "unknown"; requiredMs: number;
    allNewSendAt: Instant; rollbackPeriodMs: number | "unknown"; rollbackEndsAt: number | "unknown";
  };
  infra: Record<InfraItem, InfraState>;
  blockers: string[];
  exit: { ok: boolean; reasons: ExitReason[] };
}

function families(s: ObservationSample): ObservationReport["families"] {
  const out: ObservationReport["families"] = {};
  for (const d of DIRECTIONS) {
    out[d] = {};
    for (const a of AREAS) {
      out[d][a] = {};
      for (const src of CENTER_AREAS.includes(a) ? ["machine", "center"] : ["machine"]) {
        const cell = s.traffic.find((t) => t.direction === d && t.area === a && t.source === src);
        out[d][a][src] = cell ? { legacy: cell.legacy, floka: cell.floka } : { legacy: "unknown", floka: "unknown" };
      }
    }
  }
  return out;
}

function windowOf(s: ObservationSample): ObservationReport["window"] {
  const w = s.window === "unknown" ? { start: "unknown" as const, end: "unknown" as const } : s.window;
  const rollbackEndsAt = typeof s.allNewSendAt === "number" && typeof s.rollbackPeriodMs === "number"
    ? s.allNewSendAt + s.rollbackPeriodMs : "unknown";
  return { ...w, requiredMs: requiredWindowMs(), allNewSendAt: s.allNewSendAt, rollbackPeriodMs: s.rollbackPeriodMs, rollbackEndsAt };
}

export function buildReport(s: ObservationSample, gear: ObservationGear, now: number): ObservationReport {
  const versions: ObservationReport["versions"] = {};
  for (const k of NODE_KINDS) versions[k] = s.nodes.filter((n) => n.kind === k).map(({ kind: _kind, ...rest }) => rest);
  const clients: ObservationReport["clients"] = {};
  for (const k of CLIENT_KINDS) {
    const c = s.clients.find((x) => x.kind === k);
    clients[k] = c ? { legacy: c.legacy, offline: c.offline } : { legacy: "unknown", offline: "unknown" };
  }
  const payloads: ObservationReport["payloads"] = {};
  for (const k of PAYLOAD_KINDS) {
    const p = s.payloads.find((x) => x.kind === k);
    payloads[k] = { lifetimeMs: PAYLOAD_LIFETIMES[k], legacyLive: p ? p.legacyLive : "unknown", maxExpiresAt: p ? p.maxExpiresAt : "unknown" };
  }
  const reasons = exitReasons(s, now);
  return {
    v: 1, gear, generatedAt: now, families: families(s), versions,
    sessions: { ...s.sessions }, clients, pending: { ...s.pending }, payloads, window: windowOf(s),
    infra: { ...s.infra }, blockers: centerBlocked(s) ? ["center_observation_missing"] : [],
    exit: { ok: reasons.length === 0, reasons },
  };
}
