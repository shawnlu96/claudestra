/**
 * cwd → agent 名的推导（v2.24+ 装机时批量收编已有会话用）。纯逻辑，单测覆盖。
 *
 * agent 名会直接拼进 tmux window 名、Discord 频道名和文件路径，manager.ts 对它有
 * 校验（拒绝空白 / shell 元字符 / 控制字符 / 路径分隔符，长度上限 48；CJK 与其它
 * Unicode 字母允许）。装机那一步是**批量**生成的——一条不合法就是一次失败的收编，
 * 而用户刚装完、最不该看见红字，所以这里只产出必然合法的名字。
 */

/** 上限 48，留出 `-NN` 去重后缀的余量 */
const MAX_BASE = 40;

export function agentNameFromDir(dir: string, taken: Set<string>): string {
  const base =
    (dir.split("/").filter(Boolean).pop() || "session")
      .replace(/[^\p{L}\p{N}_-]+/gu, "-")
      .replace(/^-+|-+$/g, "")
      .toLowerCase()
      .slice(0, MAX_BASE) || "session";
  if (!taken.has(base)) return base;
  for (let i = 2; i < 100; i++) {
    const n = `${base}-${i}`;
    if (!taken.has(n)) return n;
  }
  return `${base}-${Date.now().toString(36)}`;
}
