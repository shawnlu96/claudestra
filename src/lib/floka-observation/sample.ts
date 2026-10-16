/**
 * 样本解析：只认 types.ts 里的字段，多一个键就整份拒——夹带 token / cookie / 签名的字段因此进不来。
 * 原文先过一遍凭据形状扫描，命中只报 JSON 路径、不回显值。缺的项补成 "unknown"（不是 0）：
 * 没观测到的格子在判定里和有旧流量一样拒绝退出，绝不能被当成零计数。
 */
import {
  AREAS, CLIENT_KINDS, DIRECTIONS, INFRA_ITEMS, NODE_KINDS, PAYLOAD_KINDS, SOURCES,
  type ClientCell, type Count, type InfraItem, type InfraState, type Instant, type ObservationSample,
  type ObservedNode, type PayloadCell, type TrafficCell,
} from "./types.js";

type Obj = Record<string, unknown>;
export class SampleError extends Error {}

/** 节点 id 只许小写字母数字和连字符：没有点和冒号，域名、IP、URL 都写不进来 */
const ID_RE = /^[a-z0-9][a-z0-9-]{0,31}$/;
/** 版本只收 semver 形状或短 git sha */
const VERSION_RE = /^(v?\d+(\.\d+){0,3}([-+][0-9A-Za-z.-]{1,20})?|[0-9a-f]{7,12})$/;
/** 凭据形状：本仓 token / 设备 token 前缀、cookie 赋值、PEM、长 base64 / hex 串 */
const SECRET_RES: readonly RegExp[] = [
  /\b(tok|dev)_[A-Za-z0-9_-]{6,}/, /\b(cstra|floka)_[a-z_]+=/i, /-----BEGIN /, /[A-Za-z0-9+/_-]{40,}={0,2}/, /\b[0-9a-f]{32,}\b/i,
];

const isObj = (v: unknown): v is Obj => !!v && typeof v === "object" && !Array.isArray(v);

function strict(o: unknown, path: string, keys: readonly string[]): Obj {
  if (!isObj(o)) throw new SampleError(`${path}: 要是对象`);
  const extra = Object.keys(o).filter((k) => !keys.includes(k));
  if (extra.length) throw new SampleError(`${path}: 有样本格式外的字段（${extra.length} 个，名字不回显）`);
  return o;
}

function count(v: unknown, path: string): Count {
  if (v === undefined || v === null || v === "unknown") return "unknown";
  if (typeof v === "number" && Number.isSafeInteger(v) && v >= 0) return v;
  throw new SampleError(`${path}: 要是非负整数或 "unknown"`);
}

function instant(v: unknown, path: string, allowNull: boolean): Instant {
  if (v === undefined || v === "unknown") return "unknown";
  if (v === null && allowNull) return null;
  if (typeof v === "number" && Number.isSafeInteger(v) && v > 0) return v;
  throw new SampleError(`${path}: 要是毫秒时间戳${allowNull ? "、null" : ""}或 "unknown"`);
}

function oneOf<T extends string>(v: unknown, all: readonly T[], path: string): T {
  if (typeof v === "string" && (all as readonly string[]).includes(v)) return v as T;
  throw new SampleError(`${path}: 要是 ${all.join(" / ")} 之一`);
}

function list(v: unknown, path: string): unknown[] {
  if (v === undefined) return [];
  if (!Array.isArray(v)) throw new SampleError(`${path}: 要是数组`);
  return v;
}

function node(raw: unknown, i: number): ObservedNode {
  const p = `nodes[${i}]`, o = strict(raw, p, ["id", "kind", "version", "receiveFloka", "sendFamily"]);
  if (typeof o.id !== "string" || !ID_RE.test(o.id)) throw new SampleError(`${p}.id: 只许 [a-z0-9-]，不超过 32 字`);
  const version = o.version === undefined || o.version === "unknown" ? "unknown" : o.version;
  if (version !== "unknown" && (typeof version !== "string" || !VERSION_RE.test(version))) throw new SampleError(`${p}.version: 不是版本号形状`);
  const rf = o.receiveFloka === undefined ? "unknown" : o.receiveFloka;
  if (rf !== "unknown" && typeof rf !== "boolean") throw new SampleError(`${p}.receiveFloka: 要是布尔或 "unknown"`);
  const sendFamily = o.sendFamily === undefined ? "unknown" : oneOf(o.sendFamily, ["legacy", "floka", "unknown"] as const, `${p}.sendFamily`);
  return { id: o.id, kind: oneOf(o.kind, NODE_KINDS, `${p}.kind`), version: version as string, receiveFloka: rf as boolean | "unknown", sendFamily };
}

function traffic(raw: unknown, i: number): TrafficCell {
  const p = `traffic[${i}]`, o = strict(raw, p, ["direction", "area", "source", "legacy", "floka"]);
  return {
    direction: oneOf(o.direction, DIRECTIONS, `${p}.direction`), area: oneOf(o.area, AREAS, `${p}.area`),
    source: oneOf(o.source, SOURCES, `${p}.source`), legacy: count(o.legacy, `${p}.legacy`), floka: count(o.floka, `${p}.floka`),
  };
}

function client(raw: unknown, i: number): ClientCell {
  const p = `clients[${i}]`, o = strict(raw, p, ["kind", "legacy", "offline"]);
  return { kind: oneOf(o.kind, CLIENT_KINDS, `${p}.kind`), legacy: count(o.legacy, `${p}.legacy`), offline: count(o.offline, `${p}.offline`) };
}

function payload(raw: unknown, i: number): PayloadCell {
  const p = `payloads[${i}]`, o = strict(raw, p, ["kind", "legacyLive", "maxExpiresAt"]);
  return { kind: oneOf(o.kind, PAYLOAD_KINDS, `${p}.kind`), legacyLive: count(o.legacyLive, `${p}.legacyLive`), maxExpiresAt: instant(o.maxExpiresAt, `${p}.maxExpiresAt`, true) };
}

/** 同一格子写两遍时，不知道该信哪一份：整份拒，不挑一份用 */
function unique<T>(items: T[], key: (t: T) => string, path: string): T[] {
  const seen = new Set<string>();
  for (const t of items) {
    const k = key(t);
    if (seen.has(k)) throw new SampleError(`${path}: 重复的格子 ${k}`);
    seen.add(k);
  }
  return items;
}

function windowOf(v: unknown): ObservationSample["window"] {
  if (v === undefined || v === "unknown") return "unknown";
  const o = strict(v, "window", ["start", "end"]);
  const start = instant(o.start, "window.start", false), end = instant(o.end, "window.end", false);
  if (start === "unknown" || end === "unknown") return "unknown";
  if ((end as number) <= (start as number)) throw new SampleError("window: end 要晚于 start");
  return { start: start as number, end: end as number };
}

function infraOf(v: unknown): Record<InfraItem, InfraState> {
  const o = v === undefined ? {} : strict(v, "infra", INFRA_ITEMS);
  const out = {} as Record<InfraItem, InfraState>;
  for (const k of INFRA_ITEMS) out[k] = o[k] === undefined ? "unknown" : oneOf(o[k], ["done", "pending", "unknown"] as const, `infra.${k}`);
  return out;
}

/** 原文里有凭据形状就整份拒，报出现在第几个字符附近，不回显 */
function scanSecrets(text: string): void {
  for (const re of SECRET_RES) {
    const m = re.exec(text);
    if (m) throw new SampleError(`样本含疑似凭据（第 ${m.index} 字符附近，内容不回显）；样本只许脱敏计数`);
  }
}

export function parseSample(text: string): ObservationSample {
  scanSecrets(text);
  let raw: unknown;
  try { raw = JSON.parse(text); } catch { throw new SampleError("样本不是合法 JSON"); }
  const o = strict(raw, "sample", ["v", "fleet", "window", "allNewSendAt", "rollbackPeriodMs", "nodes", "traffic", "sessions", "clients", "pending", "payloads", "infra"]);
  if (o.v !== 1) throw new SampleError("sample.v: 只认 1");
  const fleet = o.fleet === undefined ? {} : strict(o.fleet, "fleet", ["machines"]);
  const machines = count(fleet.machines, "fleet.machines");
  const rollback = count(o.rollbackPeriodMs, "rollbackPeriodMs");
  const sessions = o.sessions === undefined ? {} : strict(o.sessions, "sessions", ["legacyMcp"]);
  const pending = o.pending === undefined ? {} : strict(o.pending, "pending", ["legacyCalls", "maxExpiresAt"]);
  return {
    v: 1, fleet: { machines }, window: windowOf(o.window),
    allNewSendAt: instant(o.allNewSendAt, "allNewSendAt", true), rollbackPeriodMs: rollback,
    nodes: unique(list(o.nodes, "nodes").map(node), (n) => n.id, "nodes"),
    traffic: unique(list(o.traffic, "traffic").map(traffic), (t) => `${t.direction}/${t.area}/${t.source}`, "traffic"),
    sessions: { legacyMcp: count(sessions.legacyMcp, "sessions.legacyMcp") },
    clients: unique(list(o.clients, "clients").map(client), (c) => c.kind, "clients"),
    pending: { legacyCalls: count(pending.legacyCalls, "pending.legacyCalls"), maxExpiresAt: instant(pending.maxExpiresAt, "pending.maxExpiresAt", true) },
    payloads: unique(list(o.payloads, "payloads").map(payload), (p) => p.kind, "payloads"),
    infra: infraOf(o.infra),
  };
}
