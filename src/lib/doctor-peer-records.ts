/**
 * doctor 的「peer 记录核对」：按现行验签规则推演每条 peer 记录，列出升级后会被拒、或记录自相矛盾的（lib/doctor-peers.ts 一并调）。
 * 只读 peers.json / principals.json / peer-keys.json，只输出 peer 名与问题类别，不输出 token、公钥、指纹。
 * 也能单独跑：bun src/lib/doctor-peer-records.ts（CLAUDESTRA_STATE_DIR 指向要核对的状态目录；不连 bridge）。
 * 判定是纯函数 peerRecordIssues（tests/doctor-peer-records.test.ts）。
 */
import type { Check } from "./doctor.js";
import type { PinnedPeerKey } from "./peer-keys.js";
import { readPeers, relayPeerFingerprint, type HttpPeer } from "./peers.js";
import { currentPin, readPeerPins, recordPeerFp } from "./peer-trust.js";
import { FP_RE } from "./relay-protocol.js";

export interface PeerRecordIssue {
  name: string;
  issue: string;
}

function urlPrefix(baseUrl: string): string | null {
  try {
    return new URL(baseUrl).pathname.replace(/\/+$/, "") || null;
  } catch {
    return "（不是合法地址）";
  }
}

/** 一条记录的问题（没有问题返回空数组） */
function recordIssues(r: HttpPeer, pinned: PinnedPeerKey | undefined): string[] {
  const out: string[] = [];
  const relayFp = r.baseUrl ? relayPeerFingerprint(r.baseUrl) : null;
  if (r.fp !== undefined && !(typeof r.fp === "string" && FP_RE.test(r.fp.toLowerCase()))) out.push("fp 格式不对（所有请求都会按换了钥匙拒绝）");
  if (r.fp && relayFp && r.fp.toLowerCase() !== relayFp) out.push("fp 和 relay:// 地址里的指纹不一致（以 fp 为准）");
  if (r.baseUrl && !relayFp && urlPrefix(r.baseUrl)) out.push(`对方地址带路径前缀 ${urlPrefix(r.baseUrl)}（反代剥掉前缀的话签名路径对不上，会报 bad）`);
  if (!Number.isFinite(Date.parse(String(r.addedAt)))) out.push("addedAt 缺失或不是时间（钉住的钥匙判不了新旧）");
  const pin = currentPin(pinned, r);
  if (pinned?.publicKey && !pin) out.push("钉住的钥匙早于这条记录建立（属于之前同名的对方），已作废");
  const fp = recordPeerFp(r);
  if (fp && pin?.fingerprint && pin.fingerprint.toLowerCase() !== fp) out.push("记录的指纹和钉住的钥匙不是同一把（对方还用钉住那把的话会被拒）");
  if (r.publicKey && fp && pin?.publicKey && pin.fingerprint?.toLowerCase() === fp && pin.publicKey !== r.publicKey) out.push("记录的公钥和钉住的公钥不同");
  const anchored = !!(fp || pin?.publicKey || r.publicKey);
  const last = pin?.lastCheck?.result;
  if (anchored && last && last !== "ok") out.push(`上一次验签结果是 ${last}${last === "unsigned" ? "（对方还是老版本，或用的是不签名的 peer-http-test）" : ""}，这类请求现在会被拒`);
  return out;
}

export function peerRecordIssues(recs: HttpPeer[], pins: Record<string, PinnedPeerKey>): PeerRecordIssue[] {
  const live = recs.filter((r) => !r.disabled);
  const out = live.flatMap((r) => recordIssues(r, pins[r.name]).map((issue) => ({ name: r.name, issue })));
  const byIid = new Map<string, string[]>();
  for (const r of live) if (r.instanceId) byIid.set(r.instanceId, [...(byIid.get(r.instanceId) ?? []), r.name]);
  for (const names of byIid.values()) {
    if (names.length > 1) out.push({ name: names.join("、"), issue: "同一个实例 id 有多条记录（对方再兑换只合进钥匙对得上的那条；整理不会合并指纹不同的）" });
  }
  return out;
}

export function peerRecordChecks(issues: PeerRecordIssue[]): Check[] {
  if (issues.length === 0) return [];
  return [{
    group: "Peer", name: "peer 记录核对", status: "warn",
    detail: `${issues.length} 处要看：${issues.map((i) => `${i.name}：${i.issue}`).join("；")}`,
    fix: "验签结果不是 ok 的按报错原因处理（README「peer 验签」一节）；指纹对不上、实例 id 重复的，确认是谁后删掉错的那条再重新邀请",
  }];
}

export async function checkPeerRecords(): Promise<Check[]> {
  const [peers, pins] = await Promise.all([readPeers(), readPeerPins()]);
  return peerRecordChecks(peerRecordIssues(peers.httpPeers ?? [], pins));
}

/** 每条记录一行：期望指纹从哪来、上一次验签结果（单独跑时打印） */
export function peerRecordSummary(r: HttpPeer, pinned: PinnedPeerKey | undefined): string {
  const pin = currentPin(pinned, r);
  const from = r.fp ? "记录的 fp" : r.baseUrl && relayPeerFingerprint(r.baseUrl) ? "relay:// 地址" : pin?.publicKey ? "钉住的钥匙" : "无（老 peer，截止日后拒）";
  return `${r.name}${r.disabled ? "（停用）" : ""} | 期望指纹：${from}${r.publicKey ? "，记了完整公钥" : ""} | 上一次验签：${pin?.lastCheck?.result ?? "没有记录"}`;
}

if (import.meta.main) {
  const [peers, pins] = await Promise.all([readPeers(), readPeerPins()]);
  const recs = peers.httpPeers ?? [];
  const issues = peerRecordIssues(recs, pins);
  console.log([...recs.map((r) => peerRecordSummary(r, pins[r.name])), "", ...(issues.length ? issues.map((i) => `! ${i.name}：${i.issue}`) : ["没有要看的问题"])].join("\n"));
}
