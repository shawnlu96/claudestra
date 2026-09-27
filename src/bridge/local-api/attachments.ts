/**
 * GET /api/v1/attachments/:name[?d=YYYY-MM-DD]：聊天附件取回（原 web BFF 的 chat/attachment/[name]），查找规则在 lib/attachment-lookup.ts。
 * 来源目录固定：旧 web 上传目录 → bridge inbox（现址 + /tmp 旧址）→ inbox 后缀匹配；只认 basename。manage grant 专用：
 * inbox 里是 owner 与 agent 之间的全部附件，不按 agent 分目录，给不了按 scope 的裁剪。
 */
import { join } from "node:path";
import { attachmentMime, findAttachment, safeAttachmentName, type AttachmentDirs } from "../../lib/attachment-lookup.js";
import { canManage } from "../../lib/devices.js";
import { INBOX_DIR, RUNTIME_DIR, statePath } from "../../lib/paths.js";
import type { Principal } from "../../lib/principals.js";
import { apiJson, forbidden } from "../api-respond.js";

const DEFAULT_DIRS: AttachmentDirs = { uploadDir: statePath("web", "uploads"), inboxDirs: [INBOX_DIR, join(RUNTIME_DIR, "inbox")] };
let dirs = DEFAULT_DIRS;
/** 单测指到临时目录；生产不调 */
export function setAttachmentDirsForTest(d: AttachmentDirs | undefined): void {
  dirs = d ?? DEFAULT_DIRS;
}

/** SVG 直出会执行内嵌脚本：同源下等于 XSS，禁脚本只留样式 */
const SVG_CSP = "default-src 'none'; style-src 'unsafe-inline'";

export function handleAttachments(req: Request, path: string, principal: Principal, url: URL): Response | null {
  const m = path.match(/^\/attachments\/([^/]+)$/);
  if (!m || req.method !== "GET") return null;
  if (!canManage(principal)) return forbidden("attachments require a credential with manage grant");
  const name = safeAttachmentName(m[1]);
  if (!name) return apiJson(400, { ok: false, error: "bad attachment name" });
  const hit = findAttachment(name, url.searchParams.get("d"), dirs);
  if (!hit) return apiJson(404, { ok: false, error: "attachment not found" });
  const mime = attachmentMime(hit.filename);
  const headers: Record<string, string> = {
    "Content-Type": mime,
    // 文件名带时间戳 / uuid 前缀，内容不可变 → 放心长缓存
    "Cache-Control": "private, max-age=604800, immutable",
    "Content-Disposition": `inline; filename*=UTF-8''${encodeURIComponent(hit.filename)}`,
    "X-Content-Type-Options": "nosniff",
    ...(mime === "image/svg+xml" ? { "Content-Security-Policy": SVG_CSP } : {}),
  };
  return new Response(Bun.file(hit.path), { headers });
}
