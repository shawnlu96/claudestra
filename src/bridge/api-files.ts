/**
 * GET /api/v1/files/:id：reply 发往 api:<tokenId> 的附件登记（bridge/api-reply-files.ts 按 inbox 副本登记）与取件。
 * 登记落盘（state 目录 api-files.json）：bridge 自动更新一天重启几十次，只在内存里的登记一重启就没了，peer 隔一阵来取一律 404。
 * 谁能取：登记时的那张 token；或同一个 peer 现在的另一张 token（重新邀请 / 兑换会禁用旧 token 另签一张）——peer 名相同、
 * peers.json 里这个名字现在的钥匙指纹与登记时相同（删掉后同名加回的另一台机器不算）、发件 agent 在这张 token 的 scope 里。
 * 那个指纹在对方发请求、验签通过时就钉住（peerFileOwner），不在回复登记时按名字读：回复可能晚到，那时同名可能已换成另一台机器。
 * 其余（别的 peer、guest、脚本 / 网页 token）与「没有这个 id」回同一个 404，不让人按 id 探测。单测 tests/api-files-route.test.ts。
 */
import { findHttpPeer } from "../lib/peers.js";
import { peerAnchorOf } from "../lib/peer-trust.js";
import { statePath } from "../lib/paths.js";
import { agentInScope, tokenIdOf, type Principal } from "../lib/principals.js";
import { apiJson } from "./api-respond.js";
import { PersistedMap } from "./persisted-map.js";

export interface ApiFileEntry {
  path: string;
  tokenId: string;
  name: string;
  /** 发件 agent；对方是 peer 时它的名字与登记那一刻的钥匙指纹。老登记没有这三项，只认原 token */
  agent?: string;
  peer?: string;
  peerFp?: string;
}

const isEntry = (v: unknown): boolean => {
  const e = v as ApiFileEntry | null;
  return !!e && typeof e.path === "string" && typeof e.tokenId === "string" && typeof e.name === "string";
};

export class ApiFileTable extends PersistedMap<ApiFileEntry> {
  constructor(path: string | null = statePath("api-files.json")) {
    super(path, "附件取件登记", isEntry, [], 0o600); // 记着谁能取哪个文件，别让本机其他用户读到
  }

  /** 只按容量截断，先登记的先走（文件是 inbox 副本，不在这里删） */
  trim(max = 200): void {
    if (this.size <= max) return;
    for (const k of [...this.keys()].slice(0, this.size - max)) this.deleteQuiet(k);
    this.persist();
  }
}

/** peer 名 → peers.json 里这个名字现在的钥匙指纹（记录自带的优先，其次钉住的）；没有记录或没有指纹 → null */
export type PeerAnchor = (peer: string) => Promise<string | null>;

const livePeerAnchor: PeerAnchor = async (peer) => {
  const rec = await findHttpPeer(peer);
  return rec ? (await peerAnchorOf())(rec) : null;
};

export type FileOwner = Pick<ApiFileEntry, "peer" | "peerFp">;

/**
 * 请求进来、验签刚过时调：此刻名下的指纹就是签这条请求的机器（旧 token 有效期间同名不会换机器——重建会禁用旧 token），
 * 记在 pending 上，回复登记附件时用它。上限：验签到这里读指纹之间几毫秒内恰好同名重建会钉错，要关只能让鉴权把验过的指纹带出来；
 * 没有 pending 的回复（bridge 重启后、超时后晚到）不带它，只认原 token。
 */
export async function peerFileOwner(p: Principal, anchor: PeerAnchor = livePeerAnchor): Promise<FileOwner> {
  const peerFp = p.peer ? await anchor(p.peer) : null;
  return peerFp ? { peer: p.peer!, peerFp } : {};
}

export async function apiFileAllowed(e: ApiFileEntry, p: Principal, anchor: PeerAnchor = livePeerAnchor): Promise<boolean> {
  if (e.tokenId === tokenIdOf(p)) return true;
  if (!p.peer || p.peer !== e.peer || !e.peerFp || !e.agent || !agentInScope(p, e.agent)) return false;
  return (await anchor(p.peer)) === e.peerFp;
}

export async function serveApiFile(table: Map<string, ApiFileEntry>, id: string, p: Principal): Promise<Response> {
  const e = table.get(id);
  if (!e || !(await apiFileAllowed(e, p))) return apiJson(404, { ok: false, error: "file not found" });
  const f = Bun.file(e.path);
  if (!(await f.exists())) return apiJson(410, { ok: false, error: "file no longer on disk" });
  return new Response(f, { headers: { "Content-Disposition": `attachment; filename="${encodeURIComponent(e.name)}"` } });
}
