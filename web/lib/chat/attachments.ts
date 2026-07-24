/**
 * 用户消息文本里的附件标记解析——history 路由与 stream 路由(user-in 跨端同步)
 * 共用（2026-07-24 之前只有 history 有:实时链路的另一端消息带着 wire 注入块
 * 原样渲染成路径文字,还导致本端回声对账去重失配 → 消息双份）。
 *
 * 两种 wire 格式：
 *  - Bridge 注入（Discord 附件下载）：[attachment: /path] 每文件一行
 *  - BFF 注入（web 上传, lib/uploads.ts attachmentBlock）：
 *    [用户上传了 N 个文件（…）:\n- /path\n…\n]
 */

/** 与 features/chat/type.ts 的 ChatAttachmentView 结构兼容（此处独立定义,
 *  避免 lib → features 的依赖方向问题）。 */
export interface AttachmentView {
  name: string;
  kind: "image" | "file";
  url?: string;
}

const IMG_EXT = new Set(["png", "jpg", "jpeg", "gif", "webp", "heic", "heif", "bmp", "avif", "svg"]);

/** 绝对路径 → 附件视图（图片走 /api/chat/attachment/<name> 内联显示,其它给文件 chip）。
 *  web 上传落在 ~/.claude-orchestrator/web/uploads/<日期>/ 按天分目录,URL 带 ?d=<日期>
 *  让服务端 O(1) 定位（无 d 时服务端兜底扫描日期目录）。 */
export function attachmentFromPath(p: string): AttachmentView | null {
  const file = p.trim().split("/").pop() || "";
  if (!file) return null;
  const ext = file.split(".").pop()?.toLowerCase() || "";
  const dateDir = p.match(/\/web\/uploads\/(\d{4}-\d{2}-\d{2})\//);
  return {
    // 展示名去掉雪花 id（Discord 下载）/ uuid（web 上传）前缀
    name: file.replace(/^\d+_/, "").replace(/^[0-9a-f]{8}-/, ""),
    kind: IMG_EXT.has(ext) ? "image" : "file",
    url: `/api/chat/attachment/${encodeURIComponent(file)}${dateDir ? `?d=${dateDir[1]}` : ""}`,
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
