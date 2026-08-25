/**
 * 附件文件名清洗 —— **必须与 src/lib/attachment-name.ts 逐字一致**（写侧 bridge
 * 落 inbox、读侧本路由匹配同一套规则,否则两边名字漂移,取回落空）。
 * 见 src 那份的注释（peer 2026-08-25 中文名附件 bug）。
 * src/web 分属两套构建,不能直接共享模块,只能双份 + 互相注释。
 */
export function sanitizeAttachmentBase(pathOrName: string): string {
  const base = pathOrName.split("/").pop() || "file";
  return base.replace(/[^\p{L}\p{N}._-]+/gu, "_").slice(0, 80);
}
