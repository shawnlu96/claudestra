/**
 * peer 整体加密在本机的那一半（docs/relay/e2e-design.md §5.1）：本机身份与 E2E 钥、按记录 / 地址找 required peer、
 * 明文入站要不要拒。bridge（收发两头）和 manager（peer-http-test、兑换）共用；纯判定函数不碰磁盘，单测在 tests/peer-e2e-gates.test.ts。
 */
import { machineE2eKey, signE2eKey, type MachineE2eKey, type SignedE2eKey } from "./e2e-machine-key.js";
import { instanceKeySync, keyFingerprint, type InstanceKey } from "./instance-key.js";
import type { E2ePeer } from "./peer-e2e-serve.js";
import { recordPeerFp } from "./peer-trust.js";
import { readPeers, writePeers, type HttpPeer } from "./peers.js";
import { STATE_DIR } from "./paths.js";

/**
 * 经中继打开的网页（托管前端）上管理 peer 邀请时给 owner 的话（docs/relay/e2e-design.md §5.1、§6.1 第 12 条）：
 * 那种页面的邀请原文明文经过中继，中继能换掉里面的公钥，所以只能生成不加密的邀请、不能加入加密邀请。两句话给同一个替代做法。
 */
export const RELAY_PAGE_INVITE_WARNING = "这条邀请不加密：经中继打开的页面，中继看得到邀请内容。想要加密，请在本机页面或命令行（peer-invite-new）生成";
export const RELAY_PAGE_JOIN_REFUSED =
  "这是加密邀请，经中继打开的页面不能加入：中继看得到邀请内容，还能换掉里面的公钥。请在本机页面或命令行（peer-join-auto）加入；也可以请对方用 --allow-legacy 生成不加密的邀请";

/** CLI --allow-legacy 生成的明文邀请给 owner 的警告；经中继的网页生成的另有一句（说清楚为什么、怎么才能加密） */
const LEGACY_INVITE_WARNING = "这张邀请不加密（--allow-legacy）：兑换和之后的协作经中继都是明文，中继看得到内容";
export const plainInviteWarning = (viaRelayPage: boolean): string => (viaRelayPage ? RELAY_PAGE_INVITE_WARNING : LEGACY_INVITE_WARNING);

/** P1 不做轮换命令，本机签名块的版本恒为 1（块里留着版本字段给以后换钥匙用） */
const E2E_KEY_VERSION = 1;

/** 用密钥建立、还没禁用、记得住指纹的 peer → 会话层要的形状；不是 required peer 返回 null */
export function e2ePeerOf(rec: HttpPeer | null | undefined): E2ePeer | null {
  const fp = rec && !rec.disabled && rec.e2e ? recordPeerFp(rec) : null;
  return rec?.e2e && fp ? { name: rec.name, fp, idk: rec.e2e.idk, ek: rec.e2e.ek } : null;
}

/**
 * peer token 的请求该不该拒（bridge/api-auth.ts peerGate 调）：
 *   经 E2E 会话来的（sessionFp 有值）→ token 的主人必须就是会话的发起方，否则 e2e_peer_mismatch；
 *   明文来的 → token 的主人是 required peer 就 e2e_required（中继把请求降级成明文也过不去）。
 */
export function peerE2eRefusal(peerName: string, sessionFp: string | undefined, peers: HttpPeer[]): "e2e_required" | "e2e_peer_mismatch" | null {
  const rec = peers.find((p) => p.name === peerName && !p.disabled);
  if (sessionFp !== undefined) return rec && recordPeerFp(rec) === sessionFp ? null : "e2e_peer_mismatch";
  return rec?.e2e ? "e2e_required" : null;
}

/** 出站地址属于哪个 peer：relay://<fp>/… 按指纹，http(s) 按 baseUrl 前缀；认不出返回 null */
export function peerForUrl(url: string, peers: HttpPeer[]): HttpPeer | null {
  const live = peers.filter((p) => !p.disabled);
  const m = /^relay:\/\/([^/]+)/i.exec(url);
  if (m) return live.find((p) => recordPeerFp(p) === m[1].toLowerCase()) ?? null;
  return live.find((p) => {
    const base = (p.baseUrl || "").replace(/\/+$/, "");
    return !!base && !base.startsWith("relay://") && (url === base || url.startsWith(`${base}/`));
  }) ?? null;
}

export interface LocalE2e {
  key: InstanceKey;
  fp: string;
  machine: MachineE2eKey;
  /** 本机当前的签名 E2E 公钥块（进邀请、兑换请求、hello） */
  signed: SignedE2eKey;
}

const localCache = new Map<string, LocalE2e>();

/** 本机身份钥 + E2E 钥 + 签名块；任何一样读不到返回 null（调用方拒绝走加密，绝不退回明文） */
export async function localE2e(dir: string = STATE_DIR): Promise<LocalE2e | null> {
  const hit = localCache.get(dir);
  if (hit) return hit;
  const key = instanceKeySync(dir);
  const machine = key ? await machineE2eKey(dir) : null;
  if (!key || !machine) return null;
  const local = { key, fp: keyFingerprint(key.publicKey), machine, signed: signE2eKey(key, machine.pair.pub, E2E_KEY_VERSION, machine.ts) };
  localCache.set(dir, local);
  return local;
}

/** 生成邀请时带的密钥（manager peer-invite-new / -list）：本机身份公钥 + 签名 E2E 公钥块；读不到返回 null，调用方拒绝生成加密邀请 */
export async function inviteKeys(): Promise<{ idk: string; ek: SignedE2eKey } | null> {
  const l = await localE2e();
  return l ? { idk: l.key.publicKey, ek: l.signed } : null;
}

/** 对方在 hello 里拿出了版本更高、验过签的块：换掉 peers.json 里钉住的那块 */
export async function pinPeerE2eKey(name: string, ek: SignedE2eKey): Promise<void> {
  const data = await readPeers();
  const rec = (data.httpPeers ?? []).find((p) => p.name === name);
  if (!rec?.e2e) return;
  rec.e2e = { ...rec.e2e, ek };
  await writePeers(data);
}

/** 现读 peers.json 的 httpPeers（两个进程都在写，每次现读） */
export const readHttpPeers = async (): Promise<HttpPeer[]> => (await readPeers()).httpPeers ?? [];
