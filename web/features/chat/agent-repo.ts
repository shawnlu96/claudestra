/**
 * 侧栏 agent 名字后面的「所在仓」短名（台账 i08 1.5）：多目录 project 里分不清谁在哪个仓时才有用。
 * 只在 project 有两个以上目录时给；名字里已经带着仓名（qingniao-backend 在 qingniao-backend 仓）就不重复。
 * 纯函数，tests/web-agent-repo.test.ts。
 */
const base = (p: string) => p.replace(/\/+$/, "").split("/").pop() || p;

export function agentRepoLabel(a: { name: string; displayName: string; label?: string | null; cwd: string }, dirs: string[] | undefined): string | null {
  if (!dirs || dirs.length < 2 || !a.cwd) return null;
  const cwd = a.cwd.replace(/\/+$/, "");
  // 最长命中的目录 = 最具体的仓；都不命中（显式 --project 指到别处）就用 cwd 自己的目录名
  const hit = dirs
    .map((d) => d.replace(/\/+$/, ""))
    .filter((d) => cwd === d || cwd.startsWith(d + "/"))
    .sort((x, y) => y.length - x.length)[0];
  const repo = base(hit ?? cwd);
  const names = [a.name, a.displayName, a.label ?? ""].map((n) => n.toLowerCase());
  return names.some((n) => n.includes(repo.toLowerCase())) ? null : repo;
}

/** 侧栏一行放得下名字 + 小标的字数上限（桌面侧栏约 300px）：超了就不标，免得名字和小标一起被截成省略号；工作目录在 agent 详情里看 */
export const REPO_TAG_FIT = 24;
export const repoTagFits = (name: string, repo: string) => name.length + repo.length <= REPO_TAG_FIT;
