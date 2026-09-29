/**
 * 聊天附件取回的查找（bridge/local-api/attachments.ts 的纯逻辑部分；tests/local-api-attachments.test.ts 用临时目录直测）。
 * 三个来源按序：旧 web 上传目录（按天分目录，?d=<日期> 直取，否则倒序扫）→ bridge inbox（Discord 附件 / API 上传）→
 * 历史记录里只有原始 basename 的出站附件：inbox 落盘时加了 `<时间戳>_` 前缀，按清洗后的后缀匹配、取名字最大（最新）的一个。
 * 安全：只认 basename，目录白名单固定，拼出的路径再钉一次在目录内。
 */
import { lstatSync, readdirSync, realpathSync, statSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { sanitizeAttachmentBase } from "./attachment-name.js";

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

const MIME: Record<string, string> = {
  png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp", heic: "image/heic", heif: "image/heif",
  bmp: "image/bmp", avif: "image/avif", svg: "image/svg+xml", pdf: "application/pdf",
  txt: "text/plain; charset=utf-8", log: "text/plain; charset=utf-8", json: "application/json; charset=utf-8",
  md: "text/markdown; charset=utf-8", markdown: "text/markdown; charset=utf-8", csv: "text/csv; charset=utf-8",
  // html 故意不在表里（octet-stream + nosniff）：同源直出会执行脚本；网页端按扩展名把它当源码文本显示（web/lib/chat/attachment-open.ts）
};

export function attachmentMime(filename: string): string {
  const ext = filename.split(".").pop()?.toLowerCase() || "";
  return MIME[ext] || "application/octet-stream";
}

/** 路径段 → 安全的 basename；非法编码、带分隔符 / 控制字符、以 . 开头 → null */
export function safeAttachmentName(segment: string): string | null {
  let decoded: string;
  try {
    decoded = decodeURIComponent(segment);
  } catch {
    return null; // 非法 %-编码：调用方回 400
  }
  const base = basename(decoded);
  if (!base || base !== decoded || base.startsWith(".") || /[\\\x00-\x1f\x7f]/.test(base)) return null;
  return base;
}

export interface AttachmentDirs {
  /** 旧 web BFF 的上传根目录（下面按 YYYY-MM-DD 分目录） */
  uploadDir: string;
  /** bridge 的 inbox；第一个是当前位置，后面是历史位置 */
  inboxDirs: string[];
}

export interface AttachmentHit {
  path: string;
  filename: string;
}

/** dir/name 存在且是普通文件、且真的在 dir 里面 → 绝对路径 */
function fileUnder(dir: string, name: string): string | null {
  const root = resolve(dir);
  const abs = resolve(root, name);
  if (!abs.startsWith(`${root}/`)) return null;
  try {
    return statSync(abs).isFile() ? abs : null;
  } catch {
    return null; // 不存在 / 无权限：试下一个目录
  }
}

function listDir(dir: string): string[] {
  try {
    return readdirSync(dir);
  } catch {
    return []; // 目录还没建（从没上传过 / 从没收过附件）就是空
  }
}

/**
 * 旧上传目录下的日期目录：必须是 uploads 根（realpath）下的真目录，软链一律拒——
 * 按「日期目录自己的 realpath」核对会被软链带到根外（T22 对抗审查 adv1 P2-3）。媒体索引（media-store）共用。
 */
export function uploadDayDir(uploadDir: string, day: string): string | null {
  if (!DATE_RE.test(day)) return null;
  try {
    const dir = join(realpathSync(uploadDir), day);
    return lstatSync(dir).isDirectory() ? dir : null;
  } catch {
    return null; // uploads 根或这一天的目录不存在：这一天没有文件
  }
}

function uploadDays(dirs: AttachmentDirs, day: string | null): string[] {
  const days = day ? [day] : listDir(dirs.uploadDir).filter((n) => DATE_RE.test(n)).sort().reverse();
  return days.map((d) => uploadDayDir(dirs.uploadDir, d)).filter((d): d is string => d !== null);
}

export function findAttachment(name: string, day: string | null, dirs: AttachmentDirs): AttachmentHit | null {
  for (const dir of [...uploadDays(dirs, day), ...dirs.inboxDirs]) {
    const path = fileUnder(dir, name);
    if (path) return { path, filename: name };
  }
  // 写侧（bridge 落 inbox）清洗过原名，读侧必须用同一套清洗再匹配，否则中文 / 空格名两边对不上
  const wanted = `_${sanitizeAttachmentBase(name)}`;
  const inbox = dirs.inboxDirs[0];
  const suffixed = inbox ? listDir(inbox).filter((f) => /^\d+_/.test(f) && f.endsWith(wanted)).sort().pop() : undefined;
  const path = suffixed ? fileUnder(inbox, suffixed) : null;
  return path && suffixed ? { path, filename: suffixed } : null;
}
