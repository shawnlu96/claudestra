/**
 * 旧 peer 记录整理（纯函数；manager/peers-tidy.ts 执行，bridge 的 GET /api/v1/peers 展示）。
 * 有实例 id 之前，同一个对方会散成好几条（他兑换我的邀请 → 只有入站；我加入他的邀请撞名 → 只有出站的 -2；
 * 他重新加入 → -3）。按去掉 -数字 后缀的名字分组合成一条：出站多条只在 host 相同时合并（host 不同可能是
 * 两个人，整组不动）；入站 token 留最新签的、更早的吊销；两个方向都没有的记录删掉；停用的记录不动。
 * 期望指纹（anchorOf，lib/peer-trust.ts peerAnchorOf）不同、或有的有有的没有的整组不动：带后缀的记录可能是
 * 冒用同名 / 同实例 id 被故意拆开的另一个人，合回去会吊销真人的 token。合并后的记录带上那个指纹（只是钉住的也写成 fp）。
 * 加密配置（e2e，lib/peers.ts：有它就是 required）跟着记录走，整理不撤销加密：合并后的记录以保留的出站记录为底拷全部字段；
 * 组里的 e2e 对不上（两条不同，或有的有有的没有而保留的出站记录自己不带）整组不动。
 */
import type { HttpPeer } from "./peers.js";
import { tokenIdOf, type Principal } from "./principals.js";

/** 有效的 peer 入站 token（已兑换的；invite:* 占位是还没兑换的邀请，不归这里管） */
export interface PeerTokenRef {
  tokenId: string;
  peer: string;
  createdAt: string;
}

export interface PeerTidyGroup {
  /** 合并后的名字：去掉 -N 后缀的基名（被组外的停用记录占着时退回组里第一条的名字） */
  finalName: string;
  /** 这组的全部记录——整理时全删，再写一条合并后的（两个方向都没有就不写） */
  records: string[];
  /** 保留哪条记录的我→他（baseUrl + outToken） */
  outboundFrom?: string;
  baseUrl?: string;
  /** 保留的他→我 token */
  keepToken?: string;
  revokeTokens: string[];
  /** 合并后记录的 addedAt：组里最早的 */
  addedAt: string;
  instanceId?: string;
  /** 组里共同的期望指纹与完整公钥：合并后的记录带上，验签不退回「老 peer」 */
  fp?: string;
  publicKey?: string;
  /** 有值 = 这组不动（原因已写进 desc） */
  skip?: string;
  /** 给人看的一句话 */
  desc: string;
}

export function activePeerTokens(principals: Principal[]): PeerTokenRef[] {
  return principals
    .filter((p) => p.id.startsWith("token:") && !!p.peer && !p.disabled && !p.peer.startsWith("invite:"))
    .map((p) => ({ tokenId: tokenIdOf(p), peer: p.peer!, createdAt: p.createdAt }));
}

const baseOf = (name: string) => name.replace(/-\d+$/, "") || name;
const suffixOf = (name: string) => Number(/-(\d+)$/.exec(name)?.[1] ?? 0);
const hasOut = (p: HttpPeer) => !!(p.baseUrl && p.outToken);
const newestFirst = (a: string, b: string) => Date.parse(b) - Date.parse(a);

function hostOf(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return url; // 存进来的地址不是合法 URL：拿原串比，不同就当不同机器（宁可不合并）
  }
}

/** 「HedeMacBook-Pro、-2、-3」 */
function listNames(base: string, names: string[]): string {
  return names.map((n, i) => (i > 0 && n.startsWith(`${base}-`) ? n.slice(base.length) : n)).join("、");
}

export function planPeerTidy(peers: HttpPeer[], tokens: PeerTokenRef[], anchorOf: (p: HttpPeer) => string | null): PeerTidyGroup[] {
  const groups = new Map<string, HttpPeer[]>();
  for (const p of peers) {
    if (p.disabled) continue;
    const k = baseOf(p.name);
    groups.set(k, [...(groups.get(k) ?? []), p]);
  }
  const out: PeerTidyGroup[] = [];
  for (const [base, recs] of groups) {
    recs.sort((a, b) => suffixOf(a.name) - suffixOf(b.name) || a.name.localeCompare(b.name));
    const g = planGroup(base, recs, peers, tokens, anchorOf);
    if (g) out.push(g);
  }
  return out;
}

function planGroup(base: string, recs: HttpPeer[], all: HttpPeer[], tokens: PeerTokenRef[], anchorOf: (p: HttpPeer) => string | null): PeerTidyGroup | null {
  const names = recs.map((r) => r.name);
  const finalName = all.some((p) => p.name === base && !names.includes(p.name)) ? names[0] : base;
  const toks = tokens.filter((t) => names.includes(t.peer) || t.peer === finalName).sort((a, b) => newestFirst(a.createdAt, b.createdAt));
  const dead = recs.filter((r) => !hasOut(r) && !toks.some((t) => t.peer === r.name));
  if (recs.length === 1 && dead.length === 0) return null;
  const list = listNames(base, names);
  const base0 = {
    finalName, records: names, revokeTokens: [] as string[],
    addedAt: recs.map((r) => r.addedAt).sort((a, b) => Date.parse(a) - Date.parse(b))[0],
  };
  const hosts = [...new Set(recs.filter(hasOut).map((r) => hostOf(r.baseUrl!)))];
  if (hosts.length > 1) {
    const skip = `${list} 连的不是同一台机器（${hosts.join(" / ")}），可能是两个人，没动——确认是同一个人就手动移除旧的`;
    return { ...base0, skip, desc: skip };
  }
  const iids = [...new Set(recs.flatMap((r) => (r.instanceId ? [r.instanceId] : [])))];
  if (iids.length > 1) {
    const skip = `${list} 来自不同的 Claudestra 实例，是不同的人，没动`;
    return { ...base0, skip, desc: skip };
  }
  const identity = sameIdentity(recs, anchorOf);
  if ("skip" in identity) {
    const skip = `${list} ${identity.skip}，没动——确认是同一个人就手动移除旧的`;
    return { ...base0, skip, desc: skip };
  }
  const outs = recs.filter(hasOut).sort((a, b) => newestFirst(a.addedAt, b.addedAt));
  const keep = toks[0];
  const outFrom = outs[0];
  const e2eSkip = e2eMismatch(recs, outFrom);
  if (e2eSkip) {
    const skip = `${list} 加密配置不一致（${e2eSkip}），没动——合并会改掉其中一条的加密要求，确认后手动移除不要的那条`;
    return { ...base0, skip, desc: skip };
  }
  const g: PeerTidyGroup = {
    ...base0,
    ...(outFrom ? { outboundFrom: outFrom.name, baseUrl: outFrom.baseUrl } : {}),
    ...(keep ? { keepToken: keep.tokenId } : {}),
    revokeTokens: toks.slice(1).map((t) => t.tokenId),
    ...(iids[0] ? { instanceId: iids[0] } : {}),
    ...identity,
    desc: "",
  };
  g.desc = describe(g, list, outs);
  return g;
}

/** 组里的记录是不是同一把钥匙：都没有期望指纹（老记录）或都是同一个才算；公钥记了不止一把也不算 */
function sameIdentity(recs: HttpPeer[], anchorOf: (p: HttpPeer) => string | null): { fp?: string; publicKey?: string } | { skip: string } {
  const anchors = recs.map(anchorOf);
  const fps = [...new Set(anchors.filter((a): a is string => !!a))];
  if (fps.length > 1) return { skip: "签名钥匙不是同一把（指纹不同），是不同的人" };
  if (fps.length === 1 && anchors.includes(null)) return { skip: "有的记录确认过签名钥匙、有的没有，没法确认是同一个人" };
  const keys = [...new Set(recs.flatMap((r) => (r.publicKey ? [r.publicKey] : [])))];
  if (keys.length > 1) return { skip: "记下的公钥不是同一把，是不同的人" };
  return { ...(fps[0] ? { fp: fps[0] } : {}), ...(keys[0] ? { publicKey: keys[0] } : {}) };
}

const e2eKeyOf = (p: HttpPeer): string | null =>
  p.e2e ? JSON.stringify([p.e2e.idk, p.e2e.ek?.v, p.e2e.ek?.ts, p.e2e.ek?.pub, p.e2e.ek?.sig]) : null;

/**
 * 组里的加密配置能不能合到一条上；能 → null，不能 → 原因。都没有、都相同：能。有的有有的没有：只有保留的出站记录
 * （合并的底）自己带着才能——合并后整条 required，只会更严；底不带（或没有出站）时合并要么丢掉加密、要么给没约定过加密的出站加上，都不替 owner 决定。
 */
function e2eMismatch(recs: HttpPeer[], outFrom: HttpPeer | undefined): string | null {
  const keys = recs.map(e2eKeyOf);
  const distinct = new Set(keys.filter((k) => k !== null));
  if (distinct.size > 1) return "钉住的加密钥匙不是同一份";
  if (distinct.size === 1 && keys.includes(null) && !outFrom?.e2e) return "有的记录要求加密、有的没有";
  return null;
}

function describe(g: PeerTidyGroup, list: string, outs: HttpPeer[]): string {
  if (!g.keepToken && !g.outboundFrom) {
    return `${g.records.length > 1 ? `${list} ` : `「${list}」`}两个方向都不通（他连不上你，你也连不上他），删掉`;
  }
  const keep = [
    ...(g.keepToken ? [`他连你的 token ${g.keepToken}`] : []),
    ...(g.baseUrl ? [`你连他的 ${g.baseUrl}`] : []),
  ].join("、");
  // 走到这里组里一定不止一条：单条且活着的记录不进计划
  const parts = [`${list} 合成一张「${g.finalName}」：保留${keep}`];
  if (g.revokeTokens.length) {
    parts.push(`旧 token ${g.revokeTokens.join("、")} 吊销（他之后又重新加入过，旧的已被新的取代）`);
  }
  const oldUrls = [...new Set(outs.slice(1).map((r) => r.baseUrl!).filter((u) => u !== g.baseUrl))];
  if (oldUrls.length) parts.push(`旧地址 ${oldUrls.join("、")} 不再用`);
  if (g.outboundFrom && g.outboundFrom !== g.finalName) parts.push(`以后给他发消息写 <agent>@${g.finalName}`);
  return parts.join("；");
}

/**
 * 合并后的那条记录：以保留的出站记录为底拷全部字段（e2e 与以后 HttpPeer 新加的字段都跟着走，不靠白名单），
 * 再盖上整理要改的 name / addedAt / inTokenId 与组里共同的身份。outToken 从原记录取——计划本身不带凭据，它要发给 web 展示。
 */
export function mergedPeerRecord(g: PeerTidyGroup, peers: HttpPeer[]): HttpPeer | null {
  if (g.skip || (!g.keepToken && !g.outboundFrom)) return null;
  const out = peers.find((p) => p.name === g.outboundFrom);
  // 底里的 inTokenId 是那条记录自己的旧入站 token：保留哪个只听计划的，计划没留就不带
  const { inTokenId: _old, ...base }: Partial<HttpPeer> = out && hasOut(out) ? out : {};
  // 没有出站可作底时 e2e 取组里的（计划保证这时全组相同）
  const e2e = base.e2e ?? peers.find((p) => g.records.includes(p.name) && !p.disabled && p.e2e)?.e2e;
  return {
    ...base,
    name: g.finalName,
    addedAt: g.addedAt,
    ...(g.keepToken ? { inTokenId: g.keepToken } : {}),
    ...(g.instanceId ? { instanceId: g.instanceId } : {}),
    ...(g.fp ? { fp: g.fp } : {}),
    ...(g.publicKey ? { publicKey: g.publicKey } : {}),
    ...(e2e ? { e2e } : {}),
  };
}

/**
 * 按计划改：principals 就地改（吊销、把保留的 token 改挂到合并后的名字），返回新的 httpPeers。
 * 调用方负责落盘（先 principals 后 peers：中途失败时重跑一次整理会收拢到同一个结果）。
 */
export function applyPeerTidy(
  peers: HttpPeer[],
  principals: Principal[],
  plan: PeerTidyGroup[],
): { httpPeers: HttpPeer[]; revoked: string[] } {
  const todo = plan.filter((g) => !g.skip);
  const revoke = new Set(todo.flatMap((g) => g.revokeTokens));
  const rename = new Map(todo.flatMap((g) => (g.keepToken ? [[g.keepToken, g.finalName] as const] : [])));
  const revoked: string[] = [];
  for (const p of principals) {
    const id = tokenIdOf(p);
    if (revoke.has(id) && !p.disabled) {
      p.disabled = true;
      revoked.push(id);
    }
    const to = rename.get(id);
    if (to) {
      p.peer = to;
      p.name = `peer-${to}`;
    }
  }
  const drop = new Set(todo.flatMap((g) => g.records));
  const merged = todo.flatMap((g) => mergedPeerRecord(g, peers) ?? []);
  return { httpPeers: [...peers.filter((p) => !drop.has(p.name)), ...merged], revoked };
}
