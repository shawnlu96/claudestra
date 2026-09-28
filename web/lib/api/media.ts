/**
 * 图片与文件（bridge 媒体索引 GET /api/v1/media，src/bridge/local-api/media.ts）的客户端。
 * 缩略图 / 原图地址都是 API 路径，渲染走 <AuthImg>（带凭据取成 blob），token 不进 URL。
 */
import { apiAgentName } from "@/lib/chat/agents";
import { api } from "./client";

export interface MediaItem {
  id: string;
  /** registry 名（agent-xxx / master） */
  agent: string;
  sessionId: string;
  seq: number;
  ts: string | null;
  dir: "in" | "out";
  sender: string | null;
  /** 入站发送者 id（<channel user_id>）：前端拿本人 id 集合认「我发的」 */
  senderId: string | null;
  name: string;
  size: number | null;
  mime: string | null;
  kind: "image" | "file";
  cat: string;
  available: boolean;
  restricted?: boolean;
}

export interface MediaPage {
  items: MediaItem[];
  older: string | null;
  newer: string | null;
  total: number;
  newerCount: number;
  building?: boolean;
  anchor?: string;
}

export interface MediaQuery {
  agent?: string;
  kind?: "image" | "file";
  q?: string;
  dir?: "in" | "out";
  cat?: string;
  since?: number;
  until?: number;
}

export interface MediaCursor {
  before?: string | null;
  after?: string | null;
  around?: string;
  name?: string;
  session?: string;
  /** 气泡覆盖的记录区间 [seqFrom, seq]：服务端只在这个区间里找锚点，找不到回 404 */
  seqFrom?: number;
  seq?: number;
  limit?: number;
}

export function mediaQueryString(q: MediaQuery, c: MediaCursor = {}): string {
  const p = new URLSearchParams();
  const set = (k: string, v: string | number | null | undefined) => {
    if (v != null && v !== "") p.set(k, String(v));
  };
  set("agent", q.agent ? apiAgentName(q.agent) : undefined);
  set("kind", q.kind);
  set("q", q.q?.trim());
  set("dir", q.dir);
  set("cat", q.cat);
  set("since", q.since);
  set("until", q.until);
  set("before", c.before);
  set("after", c.after);
  set("around", c.around);
  set("name", c.name);
  set("session", c.session);
  set("seq_from", c.seqFrom);
  set("seq", c.seq);
  set("limit", c.limit);
  return p.toString();
}

export function listMedia(q: MediaQuery, c: MediaCursor = {}, signal?: AbortSignal): Promise<MediaPage> {
  return api<MediaPage>(`/media?${mediaQueryString(q, c)}`, { signal, timeoutMs: 20_000 });
}

export const mediaThumbUrl = (id: string) => `/api/v1/media/${id}/thumb`;
/** display = 服务端转成最长边 2560 的 JPEG（HEIC 也能看、走中继省流量）；保存 / 下载用原图 */
export const mediaRawUrl = (id: string, display = false) => `/api/v1/media/${id}/raw${display ? "?display=1" : ""}`;
