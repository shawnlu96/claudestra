/**
 * 对方项目 PM 的目录（T48，docs/team/collab-model.md 运作规矩 1「PM 对 PM」、落地约束「目录项要记并发」）：
 * 台账 meta 里按项目记 {peer 名: {agent: 对方在这个项目上的 PM, concurrency: 同时能接几步}}。
 * 派给 <x>@<peer> 的步骤单只发给这里登记的 PM，不直接找对方的执行者；没登记就拒派。
 * 不放 peers.json：那是凭据文件，审查员都不许读。写入走 `ledger team-set --peer-pm`（manager/ledger-step-dispatch.ts）。
 */
export interface PeerPm {
  agent: string;
  /** 对方入口同时能接几步（单个 agent 的入口 = 1）；派多了会排队 */
  concurrency: number;
}

const NAME_RE = /^[\p{L}\p{N}_.:-]{1,64}$/u;
const MAX_CONCURRENCY = 16;

const validPeerName = (s: string): boolean => NAME_RE.test(s) && !["__proto__", "constructor", "prototype"].includes(s);

/** 库里存的 JSON → 目录；坏项跳过（只由 team-set 写，坏了也不该挡住派单之外的读） */
export function toPeerPms(v: unknown): Record<string, PeerPm> {
  const out: Record<string, PeerPm> = {};
  if (!v || typeof v !== "object" || Array.isArray(v)) return out;
  for (const [peer, e] of Object.entries(v as Record<string, unknown>)) {
    const o = e as { agent?: unknown; concurrency?: unknown } | null;
    if (!validPeerName(peer) || typeof o?.agent !== "string" || !validPeerName(o.agent)) continue;
    const c = typeof o.concurrency === "number" && Number.isInteger(o.concurrency) ? o.concurrency : 1;
    out[peer] = { agent: o.agent, concurrency: Math.min(MAX_CONCURRENCY, Math.max(1, c)) };
  }
  return out;
}

/** `--peer-pm <peer>=<agent>`（agent 留空 = 删掉这一项）+ 可选并发；返回新的整张目录，不合法抛出原因 */
export function applyPeerPm(cur: Record<string, PeerPm>, flag: string, concurrency: number | undefined): Record<string, PeerPm> {
  const m = flag.match(/^([^=]+)=(.*)$/);
  if (!m) throw new Error("--peer-pm 写成 <peer>=<对方项目 PM 的 agent 名>（留空 = 删除）");
  const peer = m[1]!.trim();
  const agent = m[2]!.trim();
  if (!validPeerName(peer)) throw new Error(`peer 名不合法：${peer}`);
  const next = { ...cur };
  if (!agent) {
    delete next[peer];
    return next;
  }
  if (!validPeerName(agent)) throw new Error(`agent 名不合法：${agent}`);
  if (concurrency !== undefined && (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > MAX_CONCURRENCY)) {
    throw new Error(`--concurrency 要是 1–${MAX_CONCURRENCY} 的整数`);
  }
  next[peer] = { agent, concurrency: concurrency ?? cur[peer]?.concurrency ?? 1 };
  return next;
}

