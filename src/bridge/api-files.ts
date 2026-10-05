/**
 * GET /api/v1/files/:id：reply 发往 api:<tokenId> 的附件登记（bridge/api-reply-files.ts 按 inbox 副本登记）与取件。
 * 登记落盘（state 目录 api-files.json）：bridge 自动更新一天重启几十次，只在内存里的登记一重启就没了，peer 隔一阵来取一律 404。
 * 谁能取：登记时的那张 token；或同一个 peer 现在的另一张 token（重新邀请 / 兑换会禁用旧 token 另签一张）——peer 名相同、
 * peers.json 里这个名字现在的钥匙指纹与登记时相同（删掉后同名加回的另一台机器不算）、发件 agent 在这张 token 的 scope 里。
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
    super(path, "附件取件登记", isEntry, []);
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

export const livePeerAnchor: PeerAnchor = async (peer) => {
  const rec = await findHttpPeer(peer);
  return rec ? (await peerAnchorOf())(rec) : null;
};

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
