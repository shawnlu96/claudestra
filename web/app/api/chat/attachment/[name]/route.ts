export const runtime = "nodejs";

import { NextResponse } from "next/server";
import { sanitizeAttachmentBase } from "@/lib/chat/attachment-name";
import { readFile, readdir } from "fs/promises";
import { basename, join } from "path";
import { isAuthed } from "@/lib/api-auth";
import { UPLOAD_DIR } from "@/lib/uploads";

/**
 * 聊天附件取回（2026-07-13 owner：图片要在聊天框里显示/预览/保存,且永久保留）。
 *
 * 三个来源，BFF 同机直读：
 *  - Bridge 落盘（Discord 附件下载）：~/.claude-orchestrator/inbox（2026-07-14 起
 *    的持久位置;旧 /tmp 目录兜底,历史文件已一次性迁移）
 *  - web 上传（lib/uploads.ts saveUploads）：~/.claude-orchestrator/web/uploads/
 *    <YYYY-MM-DD>/ 按天分目录——?d=<日期> O(1) 定位,无 d 时倒序扫描日期目录兜底
 * 安全：只接受 basename（防穿越），目录白名单固定；d 参数正则校验后才拼路径。
 */

const INBOX_DIRS = [
  `${process.env.HOME}/.claude-orchestrator/inbox`,
  "/tmp/claude-orchestrator/inbox",
];

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

const MIME: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  heic: "image/heic",
  heif: "image/heif",
  bmp: "image/bmp",
  avif: "image/avif",
  svg: "image/svg+xml",
  pdf: "application/pdf",
  txt: "text/plain; charset=utf-8",
  log: "text/plain; charset=utf-8",
  json: "application/json",
};

export async function GET(
  request: Request,
  ctx: { params: Promise<{ name: string }> }
) {
  if (!(await isAuthed(request))) {
    return NextResponse.json({ error: "未登录" }, { status: 401 });
  }
  const { name } = await ctx.params;
  const safe = basename(decodeURIComponent(name));
  if (!safe || safe.startsWith(".")) {
    return NextResponse.json({ error: "bad name" }, { status: 400 });
  }
  const d = new URL(request.url).searchParams.get("d");
  const dirs = [...INBOX_DIRS];
  if (d && DATE_RE.test(d)) {
    dirs.unshift(join(UPLOAD_DIR, d)); // 明确的 web 上传 → 优先直取
  } else {
    // 无 d（旧历史 / 手动 URL）→ 倒序扫日期目录兜底（uuid 前缀名不会撞）
    try {
      const days = (await readdir(UPLOAD_DIR)).filter((n) => DATE_RE.test(n)).sort().reverse();
      dirs.push(...days.map((day) => join(UPLOAD_DIR, day)));
    } catch {
      /* uploads 目录尚不存在 */
    }
  }
  const serve = (buf: Buffer, filename: string) => {
    const ext = filename.split(".").pop()?.toLowerCase() || "";
    return new NextResponse(new Uint8Array(buf), {
      headers: {
        "Content-Type": MIME[ext] || "application/octet-stream",
        // 文件名带雪花/时间戳前缀,内容不可变 → 放心长缓存
        "Cache-Control": "private, max-age=604800, immutable",
        "Content-Disposition": `inline; filename*=UTF-8''${encodeURIComponent(filename)}`,
      },
    });
  };
  for (const dir of dirs) {
    try {
      return serve(await readFile(join(dir, safe)), safe);
    } catch {
      /* 试下一个目录 */
    }
  }
  // 历史里的 agent 出站附件只有 basename（jsonl 记录 reply 的原路径），bridge
  // 落到 inbox 时加了 `<时间戳>_` 前缀——精确名全落空后按后缀匹配 inbox,
  // 取名字最大（=时间戳最新）的一个。
  try {
    // 写侧(bridge)落 inbox 时把原名清洗过(保 Unicode),读侧必须用**同一套清洗**
    // 再匹配,否则中文/空格名两边对不上(peer 2026-08-25)。
    const wanted = sanitizeAttachmentBase(safe);
    const suffixed = (await readdir(INBOX_DIRS[0]))
      .filter((f) => /^\d+_/.test(f) && f.endsWith(`_${wanted}`))
      .sort()
      .pop();
    if (suffixed) return serve(await readFile(join(INBOX_DIRS[0], suffixed)), suffixed);
  } catch {
    /* inbox 不存在 / 读失败 */
  }
  return NextResponse.json({ error: "attachment not found" }, { status: 404 });
}
