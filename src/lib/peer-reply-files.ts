/**
 * peer 回复里的附件（对方 bridge/api-reply-files.ts 写进回复的 files）→ 推回给本机 agent 的那段说明。文件本身留在对方机器上，
 * 这里只带引用，取件用发请求的同一个 peer 凭据（/api/v1/files/:id 只认那个 token，/media 按 agent scope）。
 * 字段全部来自对方，进 agent 上下文前逐个清洗：名字过 sanitizeAttachmentBase、路径只认两种形状、sha256 只认 64 位 hex，
 * 否则对方能借文件名往本机 agent 的上下文里塞话。单测 tests/peer-reply-files.test.ts。
 */
import { sanitizeAttachmentBase } from "./attachment-name.js";

/** 回复里一个附件的元信息：老版本的对方只给 name + url；media 是备用取件路径（对方 bridge 重启后 url 就失效了） */
export interface ReplyFileRef {
  name: string;
  url?: string;
  media?: string;
  size?: number;
  sha256?: string;
}

const FILE_URL = /^\/api\/v1\/files\/[\w-]{1,80}$/;
const MEDIA_URL = /^\/api\/v1\/media\?[\w=&%.~-]{1,600}$/;
/** reply 工具本身最多 10 个附件 */
const MAX_FILES = 10;

const pick = (v: unknown, re: RegExp): string | undefined => (typeof v === "string" && re.test(v) ? v : undefined);

export function replyFileRefs(body: unknown): ReplyFileRef[] {
  const raw = (body as { files?: unknown } | null)?.files ?? (body as { result?: { files?: unknown } } | null)?.result?.files;
  if (!Array.isArray(raw)) return [];
  return raw.slice(0, MAX_FILES).flatMap((f): ReplyFileRef[] => {
    if (!f || typeof f !== "object" || typeof f.name !== "string") return [];
    const size = Number.isSafeInteger(f.size) && f.size >= 0 ? (f.size as number) : undefined;
    return [{ name: sanitizeAttachmentBase(f.name) || "file", url: pick(f.url, FILE_URL), media: pick(f.media, MEDIA_URL), size, sha256: pick(f.sha256, /^[0-9a-f]{64}$/) }];
  });
}

function fileLine(f: ReplyFileRef): string {
  const parts = [f.name, f.size !== undefined ? `${f.size} 字节` : "", f.sha256 ? `sha256 ${f.sha256}` : "", f.url ? `GET ${f.url}` : "", f.media ? `备用 GET ${f.media}` : ""];
  return `- ${parts.filter(Boolean).join(" · ")}${f.url || f.media ? "" : "（对方没给取件路径）"}`;
}

/** 回复正文后接上附件说明；没有附件原样返回（null 也照旧 null，调用方按空回复处理）。只有附件没有正文的回复也不能当空回复丢掉 */
export function withReplyFiles(text: string | null, body: unknown, peer: string): string | null {
  const files = replyFileRefs(body);
  if (!files.length) return text;
  const note = [
    `[📎 peer「${peer}」随回复附了 ${files.length} 个文件，文件留在对方机器上，没有随消息传过来：`,
    ...files.map(fileLine),
    `要文件就用发这条请求的同一个 peer 凭据（实例签名 / 端到端加密，与 send_to_agent 同一条通道）GET 上面的路径，拿到后核对 sha256；` +
      `备用路径返回一页媒体列表，取其中的 anchor 再 GET /api/v1/media/<anchor>/raw。]`,
  ].join("\n");
  return text ? `${text}\n\n${note}` : note;
}
