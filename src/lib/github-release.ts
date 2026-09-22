/**
 * GitHub Release 工具 — 查询最新 release、版本比较
 */

const REPO_ROOT = `${import.meta.dir}/../..`;

/** 从 git remote 解析 GitHub owner/repo */
export async function getGitHubRepo(): Promise<string | null> {
  const proc = Bun.spawn(["git", "remote", "get-url", "origin"], {
    cwd: REPO_ROOT,
    stdout: "pipe",
    stderr: "pipe",
  });
  const url = (await new Response(proc.stdout).text()).trim();
  await proc.exited;
  // 支持的 url 形式：
  //   git@github.com:owner/repo.git                       (SSH 短)
  //   https://github.com/owner/repo.git                   (HTTPS)
  //   ssh://git@github.com/owner/repo.git                 (SSH 长)
  //   ssh://git@ssh.github.com:443/owner/repo.git         (SSH over 443，gh CLI 默认配)
  // 注意：`(?::\d+)?` 必须放在 host 跟分隔符之间，否则 [:/] 会先匹配 ':' 把 port
  // 当成 owner（v2.4.6 之前 autoUpdate 在 SSH-443 环境永远失效就栽在这）。
  const match = url.match(/github\.com(?::\d+)?[:/]([^/]+\/[^/.]+)/);
  return match ? match[1] : null;
}

export interface ReleaseInfo {
  tag: string;
  version: string;
  name: string;
  body: string;
}

/** 从 GitHub API 获取最新 release */
export async function getLatestRelease(): Promise<ReleaseInfo | null> {
  const repo = await getGitHubRepo();
  if (!repo) return null;
  try {
    const res = await fetch(
      `https://api.github.com/repos/${repo}/releases/latest`,
      { signal: AbortSignal.timeout(10000) }
    );
    if (!res.ok) return null;
    const data = (await res.json()) as any;
    return {
      tag: data.tag_name,
      version: data.tag_name.replace(/^v/, ""),
      name: data.name || data.tag_name,
      body: data.body || "",
    };
  } catch {
    return null;
  }
}

/** 读本地 package.json 版本 */
export async function getLocalVersion(): Promise<string> {
  const pkg = JSON.parse(
    await Bun.file(`${REPO_ROOT}/package.json`).text()
  );
  return pkg.version || "0.0.0";
}

/** semver 比较：remote 是否比 local 新 */
export function isNewer(remote: string, local: string): boolean {
  const r = remote.split(".").map(Number);
  const l = local.split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    if ((r[i] || 0) > (l[i] || 0)) return true;
    if ((r[i] || 0) < (l[i] || 0)) return false;
  }
  return false;
}
