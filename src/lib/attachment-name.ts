/**
 * 出站附件落 inbox 时的文件名清洗（reply() 的 files → ~/.claude-orchestrator/inbox/）。
 *
 * bug（peer 2026-08-25）:原实现 `replace(/[^\w.\-]+/g, "_")` 的 `\w` 无 `u` 标志
 * = `[A-Za-z0-9_]`,**中文/emoji 全打成 `_`** —— `朱耷-新.png` 与 `八大山人-新.png`
 * 双双变 `_-_.png`,再只靠 Date.now() 前缀兜底,同毫秒/取回时必撞。而历史链路
 * (session-history → attachment 路由)用的是**未清洗的原始 basename**,两边名字
 * 永远对不上 → 取回 404 → 前端把 404 的 JSON 错误体存成 .json。
 *
 * 两处修正:
 *  - 保 Unicode 字母/数字(`\p{L}\p{N}`),中文名不再被抹平、彼此可区分;
 *  - **写侧(bridge 落盘)与读侧(web attachment 路由匹配)必须用同一函数**,否则
 *    改了正则两边又会漂移。web 那份在 web/lib/chat/attachment-name.ts,内容一致,
 *    互相注释指向(src/web 分属两套构建,不能直接共享模块)。
 */
export function sanitizeAttachmentBase(pathOrName: string): string {
  const base = pathOrName.split("/").pop() || "file";
  return base.replace(/[^\p{L}\p{N}._-]+/gu, "_").slice(0, 80);
}
