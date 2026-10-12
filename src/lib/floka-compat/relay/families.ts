/**
 * 中继品牌族对照表：旧族（claudestra / cstra）与新族（floka）在线上出现的每个带品牌的名字各占一格。
 * 旧族的值一律取自现有 canonical 常量，这里不重写；新族只在本目录出现，接线前不影响任何线上行为。
 * 不带品牌的东西（域名、VAPID、peer URL / slug、`relay://<指纹>`、帧字段、from:"relay"）不在表里，兼容层碰不到它们。
 * 两个进程内标记头的 canonical 常量在 src/bridge（lib 不能反向 import），旧族写字面量，由 tests/floka-relay.test.ts 钉住相等。
 */
import { RELAY_BASE_HEADER, RELAY_FROM_HEADER, SUBPROTOCOL, type Headers } from "../../relay-protocol.js";
import { RELAY_MODE_HEADER, RELAY_PREFIX_HEADER, RELAY_SAME_NET_HEADER } from "../../relay-machine-path.js";
import { DEVICE_HEADER } from "../../devices.js";
import { SIG_HEADERS } from "../../instance-signature.js";

export type RelayFamilyId = "legacy" | "floka";

/** 中继盖给实例的头（随 req 帧走，族跟连接握手的族） */
export const HOP_ROLES = ["base", "mode", "prefix", "sameNet"] as const;
/** bridge 进程发给本机回环入口的头（进程内随机标记 + 它担保的来源指纹） */
export const LOCAL_ROLES = ["from", "mark", "tunnelMark"] as const;
/** peer 请求签名的三个头（端到端，族由发起方定） */
export const SIGNATURE_ROLES = ["sigKey", "sigTs", "sigSig"] as const;
/** 浏览器的设备头 */
export const DEVICE_ROLES = ["device"] as const;
export type RelayHeaderRole = (typeof HOP_ROLES | typeof LOCAL_ROLES | typeof SIGNATURE_ROLES | typeof DEVICE_ROLES)[number];

export interface RelayFamily {
  id: RelayFamilyId;
  /** Sec-WebSocket-Protocol */
  subprotocol: string;
  /** 握手签名原文的首行（用途前缀） */
  authPurpose: string;
  headers: Readonly<Record<RelayHeaderRole, string>>;
  /** 中继头的公共前缀：客户端自带的整段不信 */
  relayPrefix: string;
  /** 这一族所有品牌头的前缀 */
  brandPrefixes: readonly string[];
}

const LEGACY: RelayFamily = {
  id: "legacy",
  subprotocol: SUBPROTOCOL,
  authPurpose: "claudestra-relay-auth-v2",
  headers: {
    from: RELAY_FROM_HEADER, base: RELAY_BASE_HEADER, mode: RELAY_MODE_HEADER, prefix: RELAY_PREFIX_HEADER, sameNet: RELAY_SAME_NET_HEADER,
    mark: "x-claudestra-relay-mark", tunnelMark: "x-claudestra-tunnel-mark",
    device: DEVICE_HEADER, sigKey: SIG_HEADERS.key, sigTs: SIG_HEADERS.ts, sigSig: SIG_HEADERS.sig,
  },
  relayPrefix: "x-claudestra-relay-",
  brandPrefixes: ["x-claudestra-", "x-cstra-"],
};

const FLOKA: RelayFamily = {
  id: "floka",
  subprotocol: "floka-relay.v2",
  authPurpose: "floka-relay-auth-v2",
  headers: {
    from: "x-floka-relay-from", base: "x-floka-relay-base", mode: "x-floka-relay-mode", prefix: "x-floka-relay-prefix", sameNet: "x-floka-relay-same-net",
    mark: "x-floka-relay-mark", tunnelMark: "x-floka-tunnel-mark",
    device: "x-floka-device", sigKey: "x-floka-key", sigTs: "x-floka-ts", sigSig: "x-floka-sig",
  },
  relayPrefix: "x-floka-relay-",
  brandPrefixes: ["x-floka-"],
};

export const RELAY_FAMILIES: Readonly<Record<RelayFamilyId, RelayFamily>> = { legacy: LEGACY, floka: FLOKA };
export const RELAY_FAMILY_IDS: readonly RelayFamilyId[] = ["legacy", "floka"];
/** 发送的缺省族，也是进程内部统一使用的头名 */
export const CANONICAL_FAMILY: RelayFamilyId = "legacy";

export function isRelayFamilyId(v: unknown): v is RelayFamilyId {
  return v === "legacy" || v === "floka";
}

/** 这个头名属于哪一族的品牌前缀；都不是返回 null */
export function brandFamilyOf(name: string): RelayFamilyId | null {
  return RELAY_FAMILY_IDS.find((id) => RELAY_FAMILIES[id].brandPrefixes.some((p) => name.startsWith(p))) ?? null;
}

/** 这个头名属于哪一族的中继前缀；都不是返回 null */
export function relayFamilyOf(name: string): RelayFamilyId | null {
  return RELAY_FAMILY_IDS.find((id) => name.startsWith(RELAY_FAMILIES[id].relayPrefix)) ?? null;
}

/** 这个头名在给定角色里是哪一族的哪个角色 */
export function roleOf(name: string, roles: readonly RelayHeaderRole[]): { family: RelayFamilyId; role: RelayHeaderRole } | null {
  for (const id of RELAY_FAMILY_IDS) {
    const role = roles.find((r) => RELAY_FAMILIES[id].headers[r] === name);
    if (role) return { family: id, role };
  }
  return null;
}

/** 键统一小写的副本；不改入参 */
export function lowerKeys(h: Headers): Headers {
  const out: Headers = {};
  for (const [k, v] of Object.entries(h)) out[k.toLowerCase()] = v;
  return out;
}
