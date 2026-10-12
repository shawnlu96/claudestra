/**
 * 中继品牌族兼容层（src/lib/floka-compat/relay/）：握手定族、能力与发送选族、头的清洗 / 盖章 / 读取。
 * 「旧端口」只用现行 canonical 常量与函数写成，不 import 兼容层——它既是四向混跑里的老版本，也是 off / observe 的对照。
 * 全部在内存里跑：没有 socket、没有 fetch。
 */
import { describe, expect, test } from "bun:test";
import { generateKeyPairSync, type KeyObject } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import {
  PROTOCOL_VERSION, RELAY_BASE_HEADER, RELAY_FROM, RELAY_FROM_HEADER, SUBPROTOCOL, asAuth, asReq, authSignature, verifyAuthSignature,
  type Headers as HeaderMap,
} from "../src/lib/relay-protocol.js";
import { RELAY_MODE_API, RELAY_MODE_HEADER, RELAY_PREFIX_HEADER, RELAY_SAME_NET_HEADER, filterMachineRequestHeaders } from "../src/lib/relay-machine-path.js";
import { dropForPeer, forwardHeaders } from "../src/lib/relay-stream.js";
import { DEVICE_HEADER } from "../src/lib/devices.js";
import { SIG_HEADERS } from "../src/lib/instance-signature.js";
import { RELAY_MARK_HEADER, TUNNEL_MARK_HEADER, takeRelayFrom } from "../src/bridge/relay-inbound.js";
import { DEVICE_ROLES, RELAY_FAMILIES, SIGNATURE_ROLES, type RelayFamilyId } from "../src/lib/floka-compat/relay/families.js";
import { RELAY_RENAME_KEY, parseRelayRename, type RelayGear, type RelayRename } from "../src/lib/floka-compat/relay/gear.js";
import { acceptSubprotocol, admitCapability, planSend, signRelayAuth, verifyRelayAuth, type RelayCapability } from "../src/lib/floka-compat/relay/handshake.js";
import {
  readBrandGroup, readTunnelHeaders, stampPeerSource, stampTunnelHeaders, stampTunnelMark, takePeerSource, takeTunnelMark, type RelayRoute,
} from "../src/lib/floka-compat/relay/headers.js";

const FP = "16f9-b5d1-30fb-8923";
const EVIL_FP = "dead-beef-dead-beef";
const BASE = "relay.test";
const MARK = "m".repeat(43);
const LEGACY = RELAY_FAMILIES.legacy, FLOKA = RELAY_FAMILIES.floka;
const QUIET: readonly RelayGear[] = ["off", "observe"];
const rename = (receive: RelayGear, send: RelayGear): RelayRename => ({ receive, send });

function newKey(): { privateKey: KeyObject; key: string } {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  return { privateKey, key: publicKey.export({ format: "jwk" }).x as string };
}

/** 冻住入参：兼容层要是改了入参里的头，严格模式下这里直接抛 */
const frozen = (h: HeaderMap): HeaderMap => Object.freeze({ ...h });

// ── 现行写法（对照）：front.tunnelHeaders、relay-inbound / relay-dispatch 的读法 ──

function baselineTunnelHeaders(client: HeaderMap, ip: string, host: string, machine?: { prefix: string; sameNet: boolean }): HeaderMap {
  const untrusted = (k: string) => k.startsWith("x-forwarded-") || k === RELAY_BASE_HEADER || k.startsWith("x-claudestra-relay-");
  const headers = forwardHeaders(client, untrusted);
  Object.assign(headers, { "x-forwarded-for": ip, "x-forwarded-proto": "https", "x-forwarded-host": host, [RELAY_BASE_HEADER]: BASE });
  if (!machine) return headers;
  const out: HeaderMap = { ...filterMachineRequestHeaders(headers), [RELAY_MODE_HEADER]: RELAY_MODE_API, [RELAY_PREFIX_HEADER]: machine.prefix };
  if (machine.sameNet) out[RELAY_SAME_NET_HEADER] = "1";
  return out;
}

function baselineRoute(h: HeaderMap): RelayRoute {
  const base = h[RELAY_BASE_HEADER] ? { relayBase: h[RELAY_BASE_HEADER] } : {};
  if (h[RELAY_MODE_HEADER] !== RELAY_MODE_API) return { mode: "tunnel", ...base };
  return {
    mode: "api", ...base,
    ...(h[RELAY_PREFIX_HEADER] ? { pathPrefix: h[RELAY_PREFIX_HEADER] } : {}), ...(h[RELAY_SAME_NET_HEADER] === "1" ? { sameNetwork: true as const } : {}),
  };
}

// ── fake 端口 ───────────────────────────────────────────────────────────

interface Accepted { family: RelayFamilyId; subprotocol: string }
interface RelayPort {
  accept(offered: string): Accepted | null;
  verify(family: RelayFamilyId, a: { key: string; nonce: string; name: string; slug: string }, sig: string): boolean;
  /** welcome 之后才给的能力声明；老中继没有 */
  capability: unknown;
  stamp(family: RelayFamilyId, client: HeaderMap): HeaderMap;
}
interface InstancePort {
  offer(): { family: RelayFamilyId; subprotocol: string };
  sign(family: RelayFamilyId, privateKey: KeyObject, a: { key: string; nonce: string; name: string; slug: string }): string;
  learn(claim: unknown, authenticated: boolean): void;
  route(family: RelayFamilyId, h: HeaderMap): RelayRoute | string;
}

const MACHINE = { prefix: `/m/${FP}`, sameNet: true };

const oldRelay = (): RelayPort => ({
  accept: (offered) => (offered.split(",").map((s) => s.trim()).includes(SUBPROTOCOL) ? { family: "legacy", subprotocol: SUBPROTOCOL } : null),
  verify: (_f, a, sig) => verifyAuthSignature(a.key, a.nonce, a.name, a.slug, sig),
  capability: undefined,
  stamp: (_f, client) => baselineTunnelHeaders(client, "203.0.113.9", BASE, MACHINE),
});

const newRelay = (r: RelayRename): RelayPort => ({
  accept: (offered) => {
    const a = acceptSubprotocol(offered, r.receive);
    return a.ok ? { family: a.family, subprotocol: a.subprotocol } : null;
  },
  verify: (family, a, sig) => verifyRelayAuth(family, a, sig).ok,
  capability: { families: r.receive === "on" ? ["legacy", "floka"] : ["legacy"] },
  stamp: (family, client) => {
    const s = stampTunnelHeaders(client, { gear: r.receive, family, ip: "203.0.113.9", host: BASE, base: BASE, machine: MACHINE });
    if (!s.ok) throw new Error(s.reason);
    return s.headers;
  },
});

const oldInstance = (): InstancePort => ({
  offer: () => ({ family: "legacy", subprotocol: SUBPROTOCOL }),
  sign: (_f, privateKey, a) => authSignature(privateKey, a.nonce, a.key, a.name, a.slug),
  learn: () => {},
  route: (_f, h) => baselineRoute(h),
});

const newInstance = (r: RelayRename): InstancePort & { known: RelayCapability | null } => {
  const port = {
    known: null as RelayCapability | null,
    offer: () => planSend(r, port.known),
    sign: signRelayAuth,
    learn: (claim: unknown, authenticated: boolean) => {
      const c = admitCapability(claim, { authenticated });
      if (c.ok) port.known = c.capability;
    },
    route: (family: RelayFamilyId, h: HeaderMap) => {
      const read = readTunnelHeaders(h, { gear: r.receive, connectionFamily: family });
      return read.ok ? read.route : read.reason;
    },
  };
  return port;
};

/** 一次完整的连接：子协议 → hello / auth / welcome → 中继转一条浏览器请求。帧都过 canonical 的形状校验 */
function connect(instance: InstancePort, relay: RelayPort) {
  const { privateKey, key } = newKey();
  const offer = instance.offer();
  const accepted = relay.accept(offer.subprotocol);
  if (!accepted) return { refused: true as const, offered: offer.subprotocol };
  const hello = { t: "hello", v: PROTOCOL_VERSION, nonce: "n".repeat(43), ts: 1790000000 };
  const fields = { key, nonce: hello.nonce, name: "mac", slug: "mac" };
  const auth = asAuth({ t: "auth", v: PROTOCOL_VERSION, ...fields, sig: instance.sign(offer.family, privateKey, fields) });
  if (!auth || !relay.verify(accepted.family, fields, auth.sig)) return { refused: true as const, offered: offer.subprotocol };
  instance.learn(relay.capability, true);
  const req = asReq({
    t: "req", id: "r_1_abc", from: RELAY_FROM, method: "GET", path: "/api/v1/agents?x=1",
    headers: relay.stamp(accepted.family, { accept: "application/json", cookie: "cstra_dev=abc; other=1" }),
  });
  return { refused: false as const, family: accepted.family, subprotocol: accepted.subprotocol, auth, req: req!, route: instance.route(accepted.family, req!.headers) };
}

const EXPECTED_ROUTE: RelayRoute = { mode: "api", relayBase: BASE, pathPrefix: `/m/${FP}`, sameNetwork: true };
const ON = rename("on", "on");

describe("[验收线 1] fake 端口四向混跑", () => {
  test("旧↔旧、旧实例→新中继、新实例→旧中继都走旧族；新↔新第一次也是旧族，握手后学到能力才计划新族", () => {
    for (const [instance, relay] of [[oldInstance(), oldRelay()], [oldInstance(), newRelay(ON)], [newInstance(ON), oldRelay()]] as const) {
      for (let round = 0; round < 2; round++) {
        const c = connect(instance, relay);
        expect(c).toMatchObject({ refused: false, family: "legacy", subprotocol: SUBPROTOCOL, route: EXPECTED_ROUTE });
      }
    }
    const instance = newInstance(ON), relay = newRelay(ON);
    expect(instance.offer().family).toBe("legacy"); // 能力未知
    const first = connect(instance, relay);
    expect(first).toMatchObject({ refused: false, family: "legacy", route: EXPECTED_ROUTE });
    expect(instance.known).toEqual({ families: ["legacy", "floka"] });
    const second = connect(instance, relay);
    expect(second).toMatchObject({ refused: false, family: "floka", subprotocol: FLOKA.subprotocol, route: EXPECTED_ROUTE });
    // 双认不改帧：auth 帧的版本与字段集合在两族下相同，req 帧除头名外相同
    if (first.refused || second.refused) throw new Error("unreachable");
    expect(second.auth.v).toBe(PROTOCOL_VERSION);
    expect(Object.keys(second.auth).sort()).toEqual(Object.keys(first.auth).sort());
    expect({ ...second.req, headers: null }).toEqual({ ...first.req, headers: null });
    expect(second.req.headers[FLOKA.headers.base]).toBe(BASE);
    expect(Object.keys(second.req.headers).filter((k) => k.startsWith("x-claudestra-"))).toEqual([]);
  });

  test("能力未知、未认证的声明、不合法的声明都不让发送切新；档位不齐也不切", () => {
    const cap: RelayCapability = { families: ["legacy", "floka"] };
    expect(planSend(ON, null)).toEqual({ family: "legacy", subprotocol: SUBPROTOCOL, candidate: null });
    expect(planSend(ON, { families: ["legacy"] }).family).toBe("legacy");
    expect(planSend(ON, cap)).toEqual({ family: "floka", subprotocol: FLOKA.subprotocol, candidate: null });
    expect(planSend(rename("on", "off"), cap)).toEqual({ family: "legacy", subprotocol: SUBPROTOCOL, candidate: null });
    expect(planSend(rename("on", "observe"), cap)).toEqual({ family: "legacy", subprotocol: SUBPROTOCOL, candidate: "floka" });
    expect(planSend(rename("observe", "on"), cap).family).toBe("legacy"); // 手工拼出来的非法档位组合也不发新族

    expect(admitCapability(cap, { authenticated: false })).toEqual({ ok: false, reason: "unauthenticated_capability" });
    expect(admitCapability(cap, { authenticated: true })).toEqual({ ok: true, capability: cap });
    for (const bad of [null, "floka", {}, { families: "floka" }, { families: ["floka"] }, { families: ["legacy", "other"] }]) {
      expect(admitCapability(bad, { authenticated: true })).toEqual({ ok: false, reason: "capability_invalid" });
    }
    const instance = newInstance(ON);
    instance.learn(cap, false); // 握手前塞进来的声明
    expect(instance.known).toBeNull();
    expect(instance.offer().family).toBe("legacy");
  });

  test("rename.relay：缺省全 off；只写一个档位只动接收；读不懂退回 off；发送 on 需要接收 on", () => {
    expect(RELAY_RENAME_KEY).toBe("rename.relay");
    expect(parseRelayRename(undefined)).toEqual({ rename: rename("off", "off"), problems: [] });
    expect(parseRelayRename("on")).toEqual({ rename: rename("on", "off"), problems: [] });
    expect(parseRelayRename({ receive: "on", send: "on" }).rename).toEqual(ON);
    expect(parseRelayRename({ send: "observe" }).rename).toEqual(rename("off", "observe"));
    for (const bad of ["ON", "yes", 1, true, ["on"]]) {
      const p = parseRelayRename(bad);
      expect(p.rename).toEqual(rename("off", "off"));
      expect(p.problems.length).toBe(1);
    }
    const capped = parseRelayRename({ receive: "observe", send: "on" });
    expect(capped.rename).toEqual(rename("observe", "observe"));
    expect(capped.problems.length).toBe(1);
  });
});

describe("[验收线 2] 冲突、伪标记与混搭拒绝；清洗后客户端注入不了可信来源", () => {
  test("子协议：on 档两族同报拒，认不出的拒；握手签名只按连接的族验，用途混搭单独报", () => {
    expect(acceptSubprotocol(`${SUBPROTOCOL}, ${FLOKA.subprotocol}`, "on")).toEqual({ ok: false, reason: "illegal_combination" });
    expect(acceptSubprotocol("floka-relay.v3", "on")).toEqual({ ok: false, reason: "subprotocol_required" });
    expect(acceptSubprotocol(null, "on")).toEqual({ ok: false, reason: "subprotocol_required" });
    expect(acceptSubprotocol(FLOKA.subprotocol, "on")).toEqual({ ok: true, family: "floka", subprotocol: FLOKA.subprotocol });

    const { privateKey, key } = newKey();
    const a = { key, nonce: "n".repeat(43), name: "mac", slug: "mac" };
    const legacySig = signRelayAuth("legacy", privateKey, a), flokaSig = signRelayAuth("floka", privateKey, a);
    expect(legacySig).toBe(authSignature(privateKey, a.nonce, a.key, a.name, a.slug)); // 旧族签名与 canonical 逐字节相同
    expect(legacySig).not.toBe(flokaSig);
    expect(verifyRelayAuth("legacy", a, legacySig)).toEqual({ ok: true, family: "legacy" });
    expect(verifyRelayAuth("floka", a, flokaSig)).toEqual({ ok: true, family: "floka" });
    expect(verifyRelayAuth("floka", a, legacySig)).toEqual({ ok: false, reason: "auth_family_mismatch" });
    expect(verifyRelayAuth("legacy", a, flokaSig)).toEqual({ ok: false, reason: "auth_family_mismatch" });
    expect(verifyAuthSignature(a.key, a.nonce, a.name, a.slug, flokaSig)).toBe(false); // 新族签名挪不成旧族握手
    expect(verifyRelayAuth("floka", { ...a, slug: "other" }, flokaSig)).toEqual({ ok: false, reason: "auth_failed" });
    expect(verifyRelayAuth("floka", { ...a, key: "not-a-key" }, flokaSig)).toEqual({ ok: false, reason: "auth_failed" });
  });

  test("中继盖的头：两族并存、与连接的族不符、夹带标记头、非法组合一律拒", () => {
    const read = (h: HeaderMap, connectionFamily: RelayFamilyId = "legacy") => readTunnelHeaders(frozen(h), { gear: "on", connectionFamily });
    const api = (f: typeof LEGACY) => ({ [f.headers.base]: BASE, [f.headers.mode]: "api", [f.headers.prefix]: `/m/${FP}` });
    expect(read({ ...api(LEGACY), [FLOKA.headers.base]: "evil.test" })).toEqual({ ok: false, reason: "family_conflict" });
    expect(read({ ...api(LEGACY), "x-floka-relay-anything": "1" })).toEqual({ ok: false, reason: "family_conflict" });
    expect(read(api(FLOKA), "legacy")).toEqual({ ok: false, reason: "family_mismatch" });
    expect(read(api(LEGACY), "floka")).toEqual({ ok: false, reason: "family_mismatch" });
    for (const f of [LEGACY, FLOKA]) {
      for (const role of ["from", "mark", "tunnelMark"] as const) {
        expect(read({ ...api(f), [f.headers[role]]: EVIL_FP }, f.id)).toEqual({ ok: false, reason: "forged_marker" });
      }
      const bads: HeaderMap[] = [
        { [f.headers.base]: BASE, [f.headers.prefix]: `/m/${FP}` }, // 有前缀没 mode
        { [f.headers.base]: BASE, [f.headers.sameNet]: "1" },
        { ...api(f), [f.headers.mode]: "admin" },
        { [f.headers.base]: BASE, [f.headers.mode]: "api" }, // api 没前缀
        { ...api(f), [f.headers.prefix]: "/m/../admin" },
        { ...api(f), [f.headers.sameNet]: "yes" },
      ];
      for (const bad of bads) expect(read(bad, f.id)).toEqual({ ok: false, reason: "illegal_combination" });
      // 合法的：换回 canonical 头名，路由与旧族读出来的一样
      const ok = read({ ...api(f), [f.headers.sameNet]: "1", accept: "a/b" }, f.id);
      expect(ok).toEqual({
        ok: true, family: f.id, route: EXPECTED_ROUTE,
        forwarded: { accept: "a/b", [RELAY_BASE_HEADER]: BASE, [RELAY_MODE_HEADER]: "api", [RELAY_PREFIX_HEADER]: `/m/${FP}`, [RELAY_SAME_NET_HEADER]: "1" },
      });
    }
    expect(read({ accept: "a/b" }, "floka")).toEqual({ ok: true, family: "floka", route: { mode: "tunnel" }, forwarded: { accept: "a/b" } });
  });

  test("本机标记：两族并存、标记不对、有来源没标记、夹带隧道标记都拒，头全删", () => {
    const take = (init: Record<string, string>) => {
      const h = new Headers(init);
      return { result: takePeerSource(h, MARK, "on"), left: [...h.keys()].sort() };
    };
    for (const f of [LEGACY, FLOKA]) {
      expect(take({ [f.headers.from]: FP, [f.headers.mark]: MARK, accept: "x" })).toEqual({ result: { ok: true, family: f.id, from: FP }, left: ["accept"] });
      expect(take({ [f.headers.from]: EVIL_FP, [f.headers.mark]: "w".repeat(43) })).toEqual({ result: { ok: false, reason: "forged_marker" }, left: [] });
      expect(take({ [f.headers.from]: EVIL_FP })).toEqual({ result: { ok: false, reason: "forged_marker" }, left: [] });
      expect(take({ [f.headers.from]: FP, [f.headers.mark]: MARK, [f.headers.tunnelMark]: MARK }))
        .toEqual({ result: { ok: false, reason: "illegal_combination" }, left: [] });
    }
    // 真标记配上另一族伪造的来源：不能让攻击者挑哪一族的指纹生效
    expect(take({ [LEGACY.headers.from]: FP, [LEGACY.headers.mark]: MARK, [FLOKA.headers.from]: EVIL_FP })).toEqual({ result: { ok: false, reason: "family_conflict" }, left: [] });
    expect(take({ accept: "x" })).toEqual({ result: { ok: true, family: null, from: null }, left: ["accept"] });

    const tunnel = (init: Record<string, string>) => {
      const h = new Headers(init);
      return { result: takeTunnelMark(h, MARK, "on"), left: [...h.keys()] };
    };
    expect(tunnel({ [FLOKA.headers.tunnelMark]: MARK })).toEqual({ result: { ok: true, family: "floka", tunnelled: true }, left: [] });
    expect(tunnel({ [LEGACY.headers.tunnelMark]: MARK })).toEqual({ result: { ok: true, family: "legacy", tunnelled: true }, left: [] });
    expect(tunnel({ [FLOKA.headers.tunnelMark]: "w".repeat(43) })).toEqual({ result: { ok: false, reason: "forged_marker" }, left: [] });
    expect(tunnel({ [FLOKA.headers.tunnelMark]: MARK, [LEGACY.headers.tunnelMark]: MARK })).toEqual({ result: { ok: false, reason: "family_conflict" }, left: [] });
    expect(tunnel({})).toEqual({ result: { ok: true, family: null, tunnelled: false }, left: [] });
  });

  test("签名三件与设备头：一组里两族并存就拒；单族换回 canonical 头名", () => {
    const sig = (f: typeof LEGACY) => ({ [f.headers.sigKey]: "k", [f.headers.sigTs]: "1", [f.headers.sigSig]: "s" });
    expect(readBrandGroup(frozen({ ...sig(LEGACY), [FLOKA.headers.sigSig]: "evil" }), SIGNATURE_ROLES, "on")).toEqual({ ok: false, reason: "family_conflict" });
    expect(readBrandGroup(frozen({ [DEVICE_HEADER]: "1", [FLOKA.headers.device]: "1" }), DEVICE_ROLES, "on")).toEqual({ ok: false, reason: "family_conflict" });
    const read = readBrandGroup(frozen({ ...sig(FLOKA), authorization: "Bearer t" }), SIGNATURE_ROLES, "on");
    expect(read).toEqual({
      ok: true, family: "floka", values: { sigKey: "k", sigTs: "1", sigSig: "s" },
      forwarded: { authorization: "Bearer t", [SIG_HEADERS.key]: "k", [SIG_HEADERS.ts]: "1", [SIG_HEADERS.sig]: "s" },
    });
    expect(readBrandGroup({ accept: "x" }, DEVICE_ROLES, "on")).toEqual({ ok: true, family: null, values: {}, forwarded: { accept: "x" } });
    // off：只读旧族，新族的头当普通头留着、不参与验签
    expect(readBrandGroup(frozen(sig(FLOKA)), SIGNATURE_ROLES, "off")).toEqual({ ok: true, family: null, values: {}, forwarded: sig(FLOKA) });
  });

  test("清洗：客户端把两族的来源 / 基址 / 模式 / 标记全塞上，经中继与 bridge 两道后一个都不生效", () => {
    const hostile: HeaderMap = { accept: "application/json", "x-forwarded-for": "10.0.0.1", "x-floka-relay-new": "1", "x-claudestra-relay-new": "1" };
    for (const f of [LEGACY, FLOKA]) {
      Object.assign(hostile, {
        [f.headers.from]: EVIL_FP, [f.headers.mark]: MARK, [f.headers.tunnelMark]: MARK, [f.headers.base]: "evil.test",
        [f.headers.mode]: "api", [f.headers.prefix]: `/m/${EVIL_FP}`, [f.headers.sameNet]: "1",
      });
    }
    for (const family of ["legacy", "floka"] as const) {
      const names = RELAY_FAMILIES[family].headers;
      // 隧道（没有机器路径）：客户端塞的 mode / prefix 不能把它变成路径模式
      const stamped = stampTunnelHeaders(frozen(hostile), { gear: "on", family, ip: "203.0.113.9", host: `mac.${BASE}`, base: BASE });
      if (!stamped.ok) throw new Error(stamped.reason);
      expect(stamped.headers).toEqual({
        accept: "application/json", "x-forwarded-for": "203.0.113.9", "x-forwarded-proto": "https", "x-forwarded-host": `mac.${BASE}`, [names.base]: BASE,
      });
      const read = readTunnelHeaders(stamped.headers, { gear: "on", connectionFamily: family });
      expect(read).toMatchObject({ ok: true, route: { mode: "tunnel", relayBase: BASE } });

      // peer 帧：对方自带的两族来源头都去掉，只有 bridge 盖的指纹进得了 peer 入口
      const peer = stampPeerSource(frozen({ ...hostile, cookie: "c=1", [DEVICE_HEADER]: "1", [FLOKA.headers.device]: "1" }), { gear: "on", family, from: FP, mark: MARK });
      if (!peer.ok) throw new Error(peer.reason);
      expect(peer.headers).toEqual({ accept: "application/json", [names.from]: FP, [names.mark]: MARK });
      expect(takePeerSource(new Headers(peer.headers), MARK, "on")).toEqual({ ok: true, family, from: FP });

      // 隧道转本机 Web：品牌头只留基址与设备头，标记是 bridge 的
      const web = stampTunnelMark(frozen({ ...hostile, [RELAY_BASE_HEADER]: BASE, [DEVICE_HEADER]: "1" }), { gear: "on", family, mark: MARK });
      if (!web.ok) throw new Error(web.reason);
      expect(web.headers).toEqual({ accept: "application/json", "x-forwarded-for": "10.0.0.1", [DEVICE_HEADER]: "1", [names.base]: BASE, [names.tunnelMark]: MARK });
    }
    // 直连进来、不知道标记的客户端：哪一族的来源头都换不成可信来源
    for (const gear of ["off", "observe", "on"] as const) {
      const direct = takePeerSource(new Headers({ ...hostile, [LEGACY.headers.mark]: "guess", [FLOKA.headers.mark]: "guess" }), MARK, gear);
      expect(direct.ok ? direct.from : null).toBeNull();
    }
    // 没开 on 的一方不许盖新族
    for (const gear of QUIET) {
      const refused = { ok: false, reason: "family_not_enabled" } as const;
      expect(stampTunnelHeaders({}, { gear, family: "floka", ip: "1.1.1.1", host: BASE, base: BASE })).toEqual(refused);
      expect(stampPeerSource({}, { gear, family: "floka", from: FP, mark: MARK })).toEqual(refused);
      expect(stampTunnelMark({}, { gear, family: "floka", mark: MARK })).toEqual(refused);
    }
  });
});

describe("[验收线 3] off / observe 不改变原路由结果；帧字段与无品牌地址不变", () => {
  const api = (f: typeof LEGACY) => ({ [f.headers.base]: BASE, [f.headers.mode]: "api", [f.headers.prefix]: `/m/${FP}`, [f.headers.sameNet]: "1" });
  const CORPUS: HeaderMap[] = [
    {},
    { accept: "a/b", cookie: "cstra_dev=abc; other=1", "x-forwarded-for": "10.0.0.1" },
    api(LEGACY),
    api(FLOKA),
    { ...api(LEGACY), ...api(FLOKA), [FLOKA.headers.base]: "evil.test" },
    { [RELAY_BASE_HEADER]: BASE, [RELAY_MODE_HEADER]: "admin", [RELAY_PREFIX_HEADER]: "/x" },
    { [RELAY_FROM_HEADER]: EVIL_FP, [RELAY_MARK_HEADER]: "guess", [TUNNEL_MARK_HEADER]: "guess", [FLOKA.headers.from]: EVIL_FP, [FLOKA.headers.mark]: MARK },
    { [SIG_HEADERS.key]: "k", [FLOKA.headers.sigSig]: "s", [DEVICE_HEADER]: "1", "x-claudestra-relay-new": "1", "x-floka-relay-new": "1" },
  ];

  test("中继盖头、实例读路由、bridge 盖本机标记：与现行写法逐项相同", () => {
    for (const gear of QUIET) {
      for (const h of CORPUS) {
        for (const machine of [undefined, { prefix: `/m/${FP}`, sameNet: false }, MACHINE]) {
          const stamped = stampTunnelHeaders(frozen(h), { gear, family: "legacy", ip: "203.0.113.9", host: BASE, base: BASE, machine });
          expect(stamped).toEqual({ ok: true, family: "legacy", headers: baselineTunnelHeaders(h, "203.0.113.9", BASE, machine) });
        }
        const read = readTunnelHeaders(frozen(h), { gear, connectionFamily: "legacy" });
        expect(read).toMatchObject({ ok: true, family: "legacy", route: baselineRoute(h), forwarded: h });
        expect(stampPeerSource(frozen(h), { gear, family: "legacy", from: FP, mark: MARK })).toEqual({
          ok: true, family: "legacy", headers: { ...forwardHeaders(h, dropForPeer), [RELAY_FROM_HEADER]: FP, [RELAY_MARK_HEADER]: MARK },
        });
        expect(stampTunnelMark(frozen(h), { gear, family: "legacy", mark: MARK })).toEqual({
          ok: true, family: "legacy",
          headers: { ...forwardHeaders(h, (k) => k.startsWith("x-claudestra-") && k !== RELAY_BASE_HEADER), [TUNNEL_MARK_HEADER]: MARK },
        });
      }
    }
  });

  test("peer 入口与隧道标记：返回值与删掉的头都和现行 takeRelayFrom / socketTrust 的判定相同", () => {
    const cases: Record<string, string>[] = [
      ...CORPUS,
      { [RELAY_FROM_HEADER]: FP, [RELAY_MARK_HEADER]: MARK },
      { [RELAY_FROM_HEADER]: FP, [RELAY_MARK_HEADER]: MARK, [FLOKA.headers.from]: EVIL_FP, [FLOKA.headers.mark]: MARK },
      { [RELAY_MARK_HEADER]: MARK },
      { [TUNNEL_MARK_HEADER]: MARK, [FLOKA.headers.tunnelMark]: MARK },
    ];
    for (const gear of QUIET) {
      for (const c of cases) {
        const ours = new Headers(c), theirs = new Headers(c);
        const got = takePeerSource(ours, MARK, gear);
        expect(got.ok ? got.from : "rejected").toBe(takeRelayFrom(theirs, MARK));
        expect([...ours.entries()]).toEqual([...theirs.entries()]);

        const h = new Headers(c);
        const tunnel = takeTunnelMark(h, MARK, gear);
        expect(tunnel.ok ? tunnel.tunnelled : "rejected").toBe(c[TUNNEL_MARK_HEADER] === MARK);
        const expected = new Headers(c);
        expected.delete(TUNNEL_MARK_HEADER);
        expect([...h.entries()]).toEqual([...expected.entries()]);
      }
    }
  });

  test("子协议：off / observe 与现行判定相同（列表里有旧子协议就收，只有新族的照旧拒）", () => {
    const offers = [null, "", SUBPROTOCOL, ` ${SUBPROTOCOL} `, `other, ${SUBPROTOCOL}`, FLOKA.subprotocol, `${SUBPROTOCOL}, ${FLOKA.subprotocol}`, "claudestra-relay.v1"];
    for (const gear of QUIET) {
      for (const offered of offers) {
        const accepted = (offered ?? "").split(",").map((s) => s.trim()).includes(SUBPROTOCOL);
        expect(acceptSubprotocol(offered, gear)).toMatchObject(accepted ? { ok: true, family: "legacy", subprotocol: SUBPROTOCOL } : { ok: false, reason: "subprotocol_required" });
      }
    }
  });

  test("off 不带 observed；observe 报告候选族或 on 档会给的拒绝理由，决定不变", () => {
    expect("observed" in acceptSubprotocol(FLOKA.subprotocol, "off")).toBe(false);
    expect(acceptSubprotocol(FLOKA.subprotocol, "observe")).toEqual({ ok: false, reason: "subprotocol_required", observed: { candidate: "floka", wouldReject: null } });
    expect(acceptSubprotocol(SUBPROTOCOL, "observe").observed).toEqual({ candidate: "legacy", wouldReject: null });
    expect(acceptSubprotocol(`${SUBPROTOCOL},${FLOKA.subprotocol}`, "observe").observed).toEqual({ candidate: null, wouldReject: "illegal_combination" });

    expect(readTunnelHeaders(api(FLOKA), { gear: "observe", connectionFamily: "floka" }).observed).toEqual({ candidate: "floka", wouldReject: null });
    expect(readTunnelHeaders({ ...api(LEGACY), ...api(FLOKA) }, { gear: "observe", connectionFamily: "legacy" }).observed).toEqual({ candidate: null, wouldReject: "family_conflict" });
    expect("observed" in readTunnelHeaders(api(FLOKA), { gear: "off", connectionFamily: "legacy" })).toBe(false);

    const h = new Headers({ [FLOKA.headers.from]: FP, [FLOKA.headers.mark]: MARK });
    expect(takePeerSource(h, MARK, "observe")).toEqual({ ok: true, family: null, from: null, observed: { candidate: "floka", wouldReject: null } });
    expect(h.get(FLOKA.headers.from)).toBe(FP); // observe 不删新族的头：和 off 一样原样留着
    expect(takeTunnelMark(new Headers({ [FLOKA.headers.tunnelMark]: "guess" }), MARK, "observe").observed).toEqual({ candidate: null, wouldReject: "forged_marker" });
    expect(readBrandGroup({ [FLOKA.headers.device]: "1" }, DEVICE_ROLES, "observe").observed).toEqual({ candidate: "floka", wouldReject: null });
  });

  test("帧字段与无品牌地址：兼容层只换头名，头的值、路径、指纹、relay:// 地址、域名都原样", () => {
    const values = {
      referer: `https://relay.floka.ai/m/${FP}/chat`, "x-peer-url": `relay://${FP}`, origin: "https://claudestra.example", authorization: "Bearer claudestra-token",
    };
    const frame = asReq({ t: "req", id: "r_1_abc", from: RELAY_FROM, to: FP, method: "post", path: `/api/v1/peers/x?u=relay://${FP}`, headers: values, body: "claudestra" })!;
    const before = structuredClone(frame);
    for (const gear of ["off", "observe", "on"] as const) {
      for (const family of gear === "on" ? (["legacy", "floka"] as const) : (["legacy"] as const)) {
        const stamped = stampTunnelHeaders(frozen(frame.headers), { gear, family, ip: "203.0.113.9", host: BASE, base: BASE, machine: MACHINE });
        if (!stamped.ok) throw new Error(stamped.reason);
        expect(stamped.headers).toMatchObject(values);
        expect(stamped.headers[RELAY_FAMILIES[family].headers.prefix]).toBe(`/m/${FP}`);
        const read = readTunnelHeaders(stamped.headers, { gear, connectionFamily: family });
        if (!read.ok) throw new Error(read.reason);
        expect(read.forwarded).toMatchObject(values);
        expect(read.route).toEqual(EXPECTED_ROUTE);
      }
    }
    expect(frame).toEqual(before);
    expect(RELAY_FROM).toBe("relay");
  });
});

describe("[验收线 4] 族表完整、与 canonical 常量一致，库里没有网络", () => {
  test("旧族每一格都等于现行常量；新族一格不缺、与旧族没有任何重名", () => {
    expect(LEGACY.subprotocol).toBe(SUBPROTOCOL);
    expect(LEGACY.headers).toEqual({
      from: RELAY_FROM_HEADER, base: RELAY_BASE_HEADER, mode: RELAY_MODE_HEADER, prefix: RELAY_PREFIX_HEADER, sameNet: RELAY_SAME_NET_HEADER,
      mark: RELAY_MARK_HEADER, tunnelMark: TUNNEL_MARK_HEADER, device: DEVICE_HEADER, sigKey: SIG_HEADERS.key, sigTs: SIG_HEADERS.ts, sigSig: SIG_HEADERS.sig,
    });
    expect(Object.keys(FLOKA.headers).sort()).toEqual(Object.keys(LEGACY.headers).sort());
    const names = (f: typeof LEGACY) => [f.subprotocol, f.authPurpose, f.relayPrefix, ...f.brandPrefixes, ...Object.values(f.headers)];
    expect(names(FLOKA).filter((n) => names(LEGACY).includes(n))).toEqual([]);
    expect(names(FLOKA).every((n) => /^(x-)?floka-/.test(n))).toBe(true);
    for (const f of [LEGACY, FLOKA]) {
      for (const [role, name] of Object.entries(f.headers)) {
        expect(f.brandPrefixes.some((p) => name.startsWith(p))).toBe(true);
        if (["from", "base", "mode", "prefix", "sameNet", "mark"].includes(role)) expect(name.startsWith(f.relayPrefix)).toBe(true);
      }
    }
  });

  test("兼容层不开连接：源码里没有 fetch / WebSocket / 监听 / 写死的地址", () => {
    const dir = join(import.meta.dir, "../src/lib/floka-compat/relay");
    const files = readdirSync(dir).filter((f) => f.endsWith(".ts"));
    expect(files.length).toBeGreaterThan(0);
    for (const f of files) {
      const src = readFileSync(join(dir, f), "utf8");
      expect(src).not.toMatch(/\bfetch\(|WebSocket\(|Bun\.(serve|connect|listen)|node:(net|http|https|tls|dgram)|[a-z]+:\/\/[a-z0-9]/);
    }
  });
});
