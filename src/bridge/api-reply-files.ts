/**
 * reply 发往 api:<tokenId> 的附件（bridge.ts deliverToApi 调）。先核文件都在：有一个不在就整条 reply 报错，对方的请求不出队，agent 改了再发。
 * 再逐个拷进 inbox，按副本登记 /api/v1/files/:id 并带上大小与 sha256。登记指向副本而不是 agent 给的原路径：原文件常在临时目录、
 * 回复完就被删，副本也正是 /media 索引认领的那一份（media 字段就是按副本名找它的路径）。
 * 对方是 peer 时附件只以引用送到（对方 http-peer.ts 推回给它的 agent）；带不过去的情形写进 warning，reply 结果原样带给 agent。
 * 单测 tests/peer-reply-files.test.ts。
 */
import { stat } from "node:fs/promises";
import { basename, join } from "node:path";
import { E2E_RESPONSE_MAX } from "../lib/peer-e2e-wire.js";
import type { ReplyFileRef } from "../lib/peer-reply-files.js";
import { findByTokenId, readPrincipals, type Principal } from "../lib/principals.js";
import { livePeerAnchor, type ApiFileEntry, type PeerAnchor } from "./api-files.js";
import { attachmentDirs } from "./local-api/attachments.js";
import { copyOutboundToInbox } from "./local-api/media-refresh.js";

type FileTable = Map<string, ApiFileEntry>;
type PeerInfo = Pick<Principal, "peer" | "messagesOnly"> | null;

export interface StageOpts {
  agent: string;
  tokenId: string;
  /** api-routes 的 apiFiles（GET /api/v1/files/:id 按它取件、核属主，见 bridge/api-files.ts） */
  table: FileTable;
  /** 发请求的一方声明看得懂回复里的 files（新版 peer 的 acceptsReplyFiles） */
  acceptsFiles?: boolean;
  /** 单测注入；缺省读 principals.json / peers.json */
  lookup?: (tokenId: string) => Promise<PeerInfo>;
  anchor?: PeerAnchor;
}

export interface Staged {
  files: (ReplyFileRef & { url: string })[];
  /** 拷进 inbox 的副本（SSE 事件与「待你处理」卡片的附件，形状同 copyOutboundToInbox） */
  sent: { name: string; attachment: string }[];
  warning?: string;
}

/** 不是普通文件（不存在、没权限、是目录）的附件；全都在返回 null */
export async function missingReplyFiles(paths: string[]): Promise<string | null> {
  const bad: string[] = [];
  for (const p of paths) {
    const s = await stat(p).catch(() => null); // 不存在与没权限对 agent 是同一个处理：换路径再发，原因不用分
    if (!s?.isFile()) bad.push(p);
  }
  return bad.length ? `附件不存在或不是文件，这条回复没有发出：${bad.join("、")}` : null;
}

async function sha256Of(path: string): Promise<string> {
  const h = new Bun.CryptoHasher("sha256");
  for await (const chunk of Bun.file(path).stream()) h.update(chunk);
  return h.digest("hex");
}

const defaultLookup = async (tokenId: string): Promise<PeerInfo> => findByTokenId(await readPrincipals(), tokenId);

export async function stageApiReplyFiles(paths: string[], o: StageOpts): Promise<Staged> {
  const out: Staged = { files: [], sent: [] };
  const failed: string[] = [];
  const who = paths.length ? await (o.lookup ?? defaultLookup)(o.tokenId) : null;
  const owner = await fileOwner(who, o.anchor ?? livePeerAnchor);
  for (const p of paths) {
    const [copy] = await copyOutboundToInbox([p], o.agent); // 一个一个拷：它拷失败只记日志跳过，这里要知道是哪个
    if (!copy) {
      failed.push(basename(p));
      continue;
    }
    const abs = join(attachmentDirs().inboxDirs[0]!, copy.attachment);
    const id = `f_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
    const name = basename(p) || "file";
    o.table.set(id, { path: abs, tokenId: o.tokenId, name, agent: o.agent, ...owner });
    out.sent.push(copy);
    const media = `/api/v1/media?agent=${encodeURIComponent(o.agent)}&dir=out&name=${encodeURIComponent(copy.attachment)}`;
    out.files.push({ name, url: `/api/v1/files/${id}`, media, size: Bun.file(abs).size, sha256: await sha256Of(abs) });
  }
  const why = failed.length ? [`${failed.join("、")} 拷贝失败，没有登记，对方收不到`] : [];
  if (out.files.length) why.push(...peerReasons(who, out.files, o.acceptsFiles));
  if (why.length) out.warning = `附件可能没送达：${why.join("；")}`;
  return out;
}

/** 对方是 peer：登记带上它的名字与此刻的钥匙指纹，它日后换了 token 也认得出是同一台机器（bridge/api-files.ts apiFileAllowed） */
async function fileOwner(p: PeerInfo, anchor: PeerAnchor): Promise<Pick<ApiFileEntry, "peer" | "peerFp">> {
  const peerFp = p?.peer ? await anchor(p.peer) : null;
  return peerFp ? { peer: p!.peer, peerFp } : {};
}

/** 对方是 peer 时附件取不到的原因；网页 / 脚本直接拿 files 与 SSE 事件，不在这里 */
function peerReasons(p: PeerInfo, files: ReplyFileRef[], acceptsFiles?: boolean): string[] {
  if (!p?.peer) return [];
  if (p.messagesOnly) return [`对方 peer「${p.peer}」的 token 只能投递消息，取不了附件`];
  const why = acceptsFiles ? [] : [`对方 peer「${p.peer}」的版本可能看不到附件（请求里没声明能接收附件引用），文字照常送达`];
  const big = files.filter((f) => (f.size ?? 0) > E2E_RESPONSE_MAX).map((f) => f.name);
  if (big.length) why.push(`${big.join("、")} 超过 ${E2E_RESPONSE_MAX / 1048576} MiB，对方经端到端加密或中继取件会失败`);
  return why;
}
