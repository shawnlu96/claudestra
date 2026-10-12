/**
 * 品牌头的清洗、盖章与读取，三段各管各的族：
 *   中继 → 实例（req 帧里的 base / mode / prefix / same-net）：族跟这条连接握手的族；
 *   bridge → 本机回环入口（from + mark、tunnel-mark）：进程内随机标记担保，族由本进程定；
 *   端到端（签名三件、设备头）：族由发起方定。
 * 每一段里一条消息只许出现一族；读出来一律换回 canonical 头名（forwarded），下游代码不用知道有两族。
 * off / observe 的输出与现行代码逐项相同（tests/floka-relay.test.ts 拿现行写法当对照）；所有函数不改入参里的头对象，
 * 只有 take* 按现行约定从 Headers 里删掉核过的标记头。
 */
import { timingSafeEqual } from "node:crypto";
import { FP_RE, type Headers as HeaderMap } from "../../relay-protocol.js";
import { MACHINE_PREFIX, RELAY_MODE_API, filterMachineRequestHeaders } from "../../relay-machine-path.js";
import { dropForPeer, forwardHeaders } from "../../relay-stream.js";
import {
  CANONICAL_FAMILY, DEVICE_ROLES, HOP_ROLES, LOCAL_ROLES, RELAY_FAMILIES, RELAY_FAMILY_IDS, brandFamilyOf, lowerKeys, relayFamilyOf, roleOf,
  type RelayFamilyId, type RelayHeaderRole,
} from "./families.js";
import { staged, type RelayFail, type RelayGear, type Staged } from "./gear.js";

const L = RELAY_FAMILIES[CANONICAL_FAMILY];
const STAMPED_ROLES: readonly RelayHeaderRole[] = [...HOP_ROLES, ...LOCAL_ROLES];
const fail = (reason: RelayFail["reason"]): RelayFail => ({ ok: false, reason });
type RoleValues = Partial<Record<RelayHeaderRole, string>>;

/** 新族只有接收档开到 on 才允许出现在线上 */
const enabled = (family: RelayFamilyId, gear: RelayGear): boolean => family === CANONICAL_FAMILY || gear === "on";

/** 客户端自带、中继一律不信的头。on 档两族的中继头与标记头都算：否则旧族连接上能夹带新族的来源头 */
function untrustedFromClient(gear: RelayGear): (k: string) => boolean {
  if (gear !== "on") return (k) => k.startsWith("x-forwarded-") || k === L.headers.base || k.startsWith(L.relayPrefix);
  return (k) => k.startsWith("x-forwarded-") || relayFamilyOf(k) !== null || roleOf(k, STAMPED_ROLES) !== null;
}

// ── 中继 → 实例 ─────────────────────────────────────────────────────────

export interface TunnelStamp {
  gear: RelayGear;
  /** 这条连接握手的族 */
  family: RelayFamilyId;
  ip: string;
  host: string;
  base: string;
  /** 路径模式：机器前缀 `/m/<fp>`，以及浏览器与实例是否同一出口 IP */
  machine?: { prefix: string; sameNet: boolean };
}

/** 中继发给实例的头：先清掉客户端自带的，再按连接的族盖。旧族 + off / observe 与 front 现行的头逐项相同 */
export function stampTunnelHeaders(client: HeaderMap, s: TunnelStamp): { ok: true; family: RelayFamilyId; headers: HeaderMap } | RelayFail {
  if (!enabled(s.family, s.gear)) return fail("family_not_enabled");
  const names = RELAY_FAMILIES[s.family].headers;
  const headers = forwardHeaders(client, untrustedFromClient(s.gear));
  Object.assign(headers, { "x-forwarded-for": s.ip, "x-forwarded-proto": "https", "x-forwarded-host": s.host, [names.base]: s.base });
  if (!s.machine) return { ok: true, family: s.family, headers };
  const out: HeaderMap = { ...filterMachineRequestHeaders(headers), [names.mode]: RELAY_MODE_API, [names.prefix]: s.machine.prefix };
  if (s.machine.sameNet) out[names.sameNet] = "1";
  return { ok: true, family: s.family, headers: out };
}

export interface RelayRoute { mode: "api" | "tunnel"; relayBase?: string; pathPrefix?: string; sameNetwork?: true }

/** 现行的路由读法：mode 是 api 才走路径模式并读前缀与同网提示，否则是隧道 */
function routeOf(v: RoleValues): RelayRoute {
  const base = v.base ? { relayBase: v.base } : {};
  if (v.mode !== RELAY_MODE_API) return { mode: "tunnel", ...base };
  return { mode: "api", ...base, ...(v.prefix ? { pathPrefix: v.prefix } : {}), ...(v.sameNet === "1" ? { sameNetwork: true as const } : {}) };
}

/** on 档对一族盖章头的组合检查：前缀 / 同网提示只能跟着 mode: api 出现，前缀必须是 `/m/<指纹>` */
function combinationOk(v: RoleValues): boolean {
  if (v.mode === undefined) return v.prefix === undefined && v.sameNet === undefined;
  if (v.mode !== RELAY_MODE_API || v.prefix === undefined || (v.sameNet !== undefined && v.sameNet !== "1")) return false;
  return v.prefix.startsWith(MACHINE_PREFIX) && FP_RE.test(v.prefix.slice(MACHINE_PREFIX.length));
}

type TunnelRead = { family: RelayFamilyId; route: RelayRoute; forwarded: HeaderMap };

function readTunnelStrict(h: HeaderMap, connectionFamily: RelayFamilyId): ({ ok: true } & TunnelRead) | RelayFail {
  const low = lowerKeys(h);
  // 标记头与来源头只在本机回环上才有意义，帧里出现就是有人想冒充 bridge 自己盖的章
  if (Object.keys(low).some((k) => roleOf(k, LOCAL_ROLES))) return fail("forged_marker");
  const present = new Set<RelayFamilyId>();
  const values: RoleValues = {};
  const forwarded: HeaderMap = {};
  for (const [k, v] of Object.entries(low)) {
    const hop = roleOf(k, HOP_ROLES);
    const family = hop?.family ?? relayFamilyOf(k);
    if (!family) forwarded[k] = v;
    else {
      present.add(family);
      if (hop) values[hop.role] = v;
      else forwarded[L.relayPrefix + k.slice(RELAY_FAMILIES[family].relayPrefix.length)] = v; // 表里没有的中继头：只换前缀，含义留给下游
    }
  }
  if (present.size > 1) return fail("family_conflict");
  if (present.size === 1 && !present.has(connectionFamily)) return fail("family_mismatch");
  if (!combinationOk(values)) return fail("illegal_combination");
  for (const role of HOP_ROLES) if (values[role] !== undefined) forwarded[L.headers[role]] = values[role];
  return { ok: true, family: connectionFamily, route: routeOf(values), forwarded };
}

/**
 * 实例读中继盖的头（from:"relay" 的 req 帧）。on 档：只认连接握手那一族，另一族出现 / 两族并存 / 夹带标记头都拒，
 * forwarded 里换回 canonical 头名；off / observe：只读旧族，其余头原样留着，和现行一样。
 */
export function readTunnelHeaders(h: HeaderMap, ctx: { gear: RelayGear; connectionFamily: RelayFamilyId }): Staged<TunnelRead> {
  return staged<TunnelRead>(
    ctx.gear,
    () => {
      const v: RoleValues = {};
      for (const role of HOP_ROLES) if (h[L.headers[role]] !== undefined) v[role] = h[L.headers[role]];
      return { ok: true, family: CANONICAL_FAMILY, route: routeOf(v), forwarded: { ...h } };
    },
    () => readTunnelStrict(h, ctx.connectionFamily),
  );
}

// ── bridge → 本机回环入口 ───────────────────────────────────────────────

/** 标记比对用常量时间；长度不同直接不等（标记定长，长度不泄露什么） */
function markEquals(got: string | null, expected: string): boolean {
  if (!got || got.length !== expected.length) return false;
  return timingSafeEqual(Buffer.from(got), Buffer.from(expected));
}

export interface LocalStamp { gear: RelayGear; family: RelayFamilyId; mark: string }
type Stamped = { ok: true; family: RelayFamilyId; headers: HeaderMap } | RelayFail;

/** peer 帧转给本机 peer 入口：去掉对方自带的中继头，盖来源指纹与标记。on 档两族的中继头、标记头、设备头都去 */
export function stampPeerSource(h: HeaderMap, s: LocalStamp & { from: string }): Stamped {
  if (!enabled(s.family, s.gear)) return fail("family_not_enabled");
  const strict = (k: string) => dropForPeer(k) || relayFamilyOf(k) !== null || roleOf(k, [...LOCAL_ROLES, ...DEVICE_ROLES]) !== null;
  const names = RELAY_FAMILIES[s.family].headers;
  return { ok: true, family: s.family, headers: { ...forwardHeaders(h, s.gear === "on" ? strict : dropForPeer), [names.from]: s.from, [names.mark]: s.mark } };
}

/**
 * 隧道请求转给本机 Web：品牌头只留中继基址（h 里是 canonical 头名），盖隧道标记。
 * on 档两族的品牌头都去，设备头例外——浏览器的凭据要原样交给本机 Web；基址换成所选族的头名。
 */
export function stampTunnelMark(h: HeaderMap, s: LocalStamp): Stamped {
  if (!enabled(s.family, s.gear)) return fail("family_not_enabled");
  const names = RELAY_FAMILIES[s.family].headers;
  if (s.gear !== "on") {
    const headers = forwardHeaders(h, (k) => k.startsWith("x-claudestra-") && k !== L.headers.base);
    return { ok: true, family: s.family, headers: { ...headers, [names.tunnelMark]: s.mark } };
  }
  const base = lowerKeys(h)[L.headers.base];
  const headers = forwardHeaders(h, (k) => brandFamilyOf(k) !== null && roleOf(k, DEVICE_ROLES) === null);
  return { ok: true, family: s.family, headers: { ...headers, ...(base !== undefined ? { [names.base]: base } : {}), [names.tunnelMark]: s.mark } };
}

/** 两族里出现了给定角色任一个的族 */
function familiesWith(h: globalThis.Headers, roles: readonly RelayHeaderRole[]): RelayFamilyId[] {
  return RELAY_FAMILY_IDS.filter((id) => roles.some((r) => h.has(RELAY_FAMILIES[id].headers[r])));
}

function drop(h: globalThis.Headers, roles: readonly RelayHeaderRole[], gear: RelayGear): void {
  for (const id of gear === "on" ? RELAY_FAMILY_IDS : [CANONICAL_FAMILY]) for (const r of roles) h.delete(RELAY_FAMILIES[id].headers[r]);
}

type PeerSource = { family: RelayFamilyId | null; from: string | null };

/**
 * peer 入口：标记对得上才返回来源指纹，核过的头从 h 里删掉。off / observe 与现行 takeRelayFrom 相同；
 * on 档两族并存、标记不对、有来源没标记、夹带隧道标记都拒，并把两族的三个头全删——拒了也不留给下游。
 */
export function takePeerSource(h: globalThis.Headers, expectedMark: string, gear: RelayGear): Staged<PeerSource> {
  const out = staged<PeerSource>(
    gear,
    () => {
      const from = (markEquals(h.get(L.headers.mark), expectedMark) ? h.get(L.headers.from) : null) || null;
      return { ok: true, family: from ? CANONICAL_FAMILY : null, from };
    },
    () => {
      if (familiesWith(h, ["tunnelMark"]).length) return fail("illegal_combination");
      const present = familiesWith(h, ["from", "mark"]);
      if (present.length > 1) return fail("family_conflict");
      if (!present.length) return { ok: true, family: null, from: null };
      const names = RELAY_FAMILIES[present[0]].headers;
      if (!markEquals(h.get(names.mark), expectedMark)) return fail("forged_marker");
      return { ok: true, family: present[0], from: h.get(names.from) || null };
    },
  );
  drop(h, gear === "on" ? LOCAL_ROLES : ["mark", "from"], gear);
  return out;
}

type TunnelMark = { family: RelayFamilyId | null; tunnelled: boolean };

/** 主端口 / 旧 web 端口：隧道标记对得上才算经中继来的，标记头核完就删。on 档两族并存或标记不对都拒 */
export function takeTunnelMark(h: globalThis.Headers, expectedMark: string, gear: RelayGear): Staged<TunnelMark> {
  const out = staged<TunnelMark>(
    gear,
    () => {
      const tunnelled = markEquals(h.get(L.headers.tunnelMark), expectedMark);
      return { ok: true, family: tunnelled ? CANONICAL_FAMILY : null, tunnelled };
    },
    () => {
      const present = familiesWith(h, ["tunnelMark"]);
      if (present.length > 1) return fail("family_conflict");
      if (!present.length) return { ok: true, family: null, tunnelled: false };
      if (!markEquals(h.get(RELAY_FAMILIES[present[0]].headers.tunnelMark), expectedMark)) return fail("forged_marker");
      return { ok: true, family: present[0], tunnelled: true };
    },
  );
  drop(h, ["tunnelMark"], gear);
  return out;
}

// ── 端到端 ──────────────────────────────────────────────────────────────

type GroupRead = { family: RelayFamilyId | null; values: RoleValues; forwarded: HeaderMap };

/**
 * 读一组端到端的品牌头（签名三件 SIGNATURE_ROLES、设备头 DEVICE_ROLES）。on 档两族并存就拒：
 * 一把钥匙配另一族的签名，或者两个设备头，验的人挑哪一个都可能挑到攻击者想要的那个。
 */
export function readBrandGroup(h: HeaderMap, roles: readonly RelayHeaderRole[], gear: RelayGear): Staged<GroupRead> {
  const collect = (src: HeaderMap, id: RelayFamilyId): RoleValues => {
    const v: RoleValues = {};
    for (const r of roles) if (src[RELAY_FAMILIES[id].headers[r]] !== undefined) v[r] = src[RELAY_FAMILIES[id].headers[r]];
    return v;
  };
  return staged<GroupRead>(
    gear,
    () => {
      const values = collect(h, CANONICAL_FAMILY);
      return { ok: true, family: Object.keys(values).length ? CANONICAL_FAMILY : null, values, forwarded: { ...h } };
    },
    () => {
      const low = lowerKeys(h);
      const present = RELAY_FAMILY_IDS.filter((id) => Object.keys(collect(low, id)).length > 0);
      if (present.length > 1) return fail("family_conflict");
      const values = present.length ? collect(low, present[0]) : {};
      const forwarded: HeaderMap = {};
      for (const [k, v] of Object.entries(low)) if (!roleOf(k, roles)) forwarded[k] = v;
      for (const r of roles) if (values[r] !== undefined) forwarded[L.headers[r]] = values[r];
      return { ok: true, family: present[0] ?? null, values, forwarded };
    },
  );
}
