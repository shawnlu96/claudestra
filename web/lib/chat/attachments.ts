/**
 * 用户消息文本里的附件标记解析——历史与直播（user-in 跨端同步）共用（2026-07-24 之前只有历史有：
 * 另一端消息带着 wire 注入块原样渲染成路径文字，还导致本端回声对账去重失配 → 消息双份）。
 *
 * 两种 wire 格式：
 *  - Bridge 注入（Discord 附件下载 / web 上传经 bridge multipart）：[attachment: /path] 每文件一行
 *  - 旧 BFF 注入（web 上传, 已删的 lib/uploads.ts）：[用户上传了 N 个文件（…）:\n- /path\n…\n]（历史里还有）
 *
 * 附件 url 是 bridge 的 API 路径（/api/v1/attachments/<name>），要带凭据取——渲染走 <AuthImg>（features/chat/components/auth-img.tsx）。
 */

/** 与 features/chat/type.ts 的 ChatAttachmentView 结构兼容（此处独立定义，避免 lib → features 的依赖方向问题）。 */
export interface AttachmentView {
  name: string;
  kind: "image" | "file";
  url?: string;
}

export const IMG_EXT = new Set(["png", "jpg", "jpeg", "gif", "webp", "heic", "heif", "bmp", "avif", "svg"]);

export const ATTACHMENT_API = "/api/v1/attachments/";

/** bridge 附件端点的路径（含 /api/v1 前缀；<AuthImg> 按它判「要带凭据取」） */
export function attachmentUrl(file: string, dateDir?: string): string {
  return `${ATTACHMENT_API}${encodeURIComponent(file)}${dateDir ? `?d=${dateDir}` : ""}`;
}

/** 这个 url 是不是要带凭据取的 API 资源（相对地，blob: / data: / 外链原样用） */
export function isApiUrl(url: string | undefined): url is string {
  return !!url && url.startsWith("/api/v1/");
}

export function isImageName(file: string): boolean {
  return IMG_EXT.has(file.split(".").pop()?.toLowerCase() || "");
}

/** 绝对路径 → 附件视图（图片内联显示，其它给文件 chip）。
 *  旧 web 上传落在 ~/.claude-orchestrator/web/uploads/<日期>/ 按天分目录，URL 带 ?d=<日期> 让服务端 O(1) 定位。 */
export function attachmentFromPath(p: string): AttachmentView | null {
  const file = p.trim().split("/").pop() || "";
  if (!file) return null;
  const dateDir = p.match(/\/web\/uploads\/(\d{4}-\d{2}-\d{2})\//);
  // 展示名去掉雪花 id（Discord 下载）/ api_时间戳（API 上传）前缀，二者都没有才去 uuid（旧 web 上传）前缀：
  // 剥过 id 再剥 uuid 会把 20260929-shot.png 这类名字剥成 shot.png，本端回声对不上、显示名也错
  const tagged = /^(?:api_)?\d+_(.+)$/.exec(file);
  return {
    name: tagged ? tagged[1] : file.replace(/^[0-9a-f]{8}-/, ""),
    kind: isImageName(file) ? "image" : "file",
    url: attachmentUrl(file, dateDir?.[1]),
  };
}

/** 文本 → { 剥掉附件标记的正文, 附件数组 }。无附件时不带 attachments 字段。 */
export function extractAttachments(text: string): { content: string; attachments?: AttachmentView[] } {
  const atts: AttachmentView[] = [];
  const push = (p: string) => {
    const a = attachmentFromPath(p);
    if (a) atts.push(a);
  };
  const content = text
    .replace(/\n?\s*\[attachment:\s*([^\]]+)\]/g, (_m, p: string) => {
      push(p);
      return "";
    })
    .replace(/\n?\s*\[用户上传了 \d+ 个文件[^\n\]]*:\s*\n((?:\s*- [^\n]+\n?)+)\s*\]/g, (_m, lines: string) => {
      for (const line of lines.split("\n")) {
        const m = line.match(/^\s*- (.+)$/);
        if (m) push(m[1]);
      }
      return "";
    })
    .trim();
  return atts.length ? { content, attachments: atts } : { content };
}
