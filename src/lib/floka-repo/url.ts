/**
 * rename.repo 的 GitHub remote 地址:两种口径分开。
 * - releaseSlugOf:自动更新器(github-release.ts)与 install.sh 认仓库用的宽松口径,任何带 github.com 的地址都认,只取 owner/repo。
 *   两边必须逐字同义:install.sh 里的 sed 是它的 shell 写法,tests/floka-repo.test.ts 拿同一组地址对着跑。
 * - parseOfficialShape:迁移 origin 用的严格口径,只认四种官方地址形状(HTTPS、SSH 短、ssh://、ssh over 443),可选 .git;
 *   带凭据、带尾斜杠、别的主机、大小写不同都不算,一律当自定义地址不动。
 */

/** owner/repo 宽松解析:`github.com(:port)?[:/]owner/repo`,repo 截到第一个 `.` 或 `/` 为止(与 v2.4.6 起的更新器同义) */
export function releaseSlugOf(url: string): string | null {
  const m = url.trim().match(/github\.com(?::\d+)?[:/]([^/]+\/[^/.]+)/);
  return m ? m[1] : null;
}

/** 更新器与 install.sh 查最新 release 的同一个地址 */
export const releaseApiUrl = (slug: string): string => `https://api.github.com/repos/${slug}/releases/latest`;

const OWNER = "[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})";
const NAME = "[A-Za-z0-9._-]{1,100}?";
const SHAPES = [
  { transport: "https", re: new RegExp(`^(https://github\\.com/)(${OWNER}/${NAME})(\\.git)?$`) },
  { transport: "ssh-scp", re: new RegExp(`^(git@github\\.com:)(${OWNER}/${NAME})(\\.git)?$`) },
  { transport: "ssh-url", re: new RegExp(`^(ssh://git@github\\.com/)(${OWNER}/${NAME})(\\.git)?$`) },
  { transport: "ssh-443", re: new RegExp(`^(ssh://git@ssh\\.github\\.com:443/)(${OWNER}/${NAME})(\\.git)?$`) },
] as const;

type Transport = (typeof SHAPES)[number]["transport"];

export interface OfficialShape {
  transport: Transport;
  /** 仓库名前面的原文(协议 + 用户 + 主机 + 端口 + 分隔符) */
  prefix: string;
  slug: string;
  /** 原值带不带 .git,改写时原样保留 */
  suffix: "" | ".git";
}

/** 四种官方形状之一 → 拆开;其余(含首尾空白)一律 null */
export function parseOfficialShape(url: string): OfficialShape | null {
  for (const s of SHAPES) {
    const m = s.re.exec(url);
    if (m && !m[2].endsWith(".git")) return { transport: s.transport, prefix: m[1], slug: m[2], suffix: m[3] ? ".git" : "" };
  }
  return null;
}

/** 这个地址是不是 slug 仓库的官方地址(精确形状、owner/repo 逐字相等) */
export const isOfficialUrl = (url: string, slug: string): boolean => parseOfficialShape(url)?.slug === slug;

/** 只换 owner/repo:SSH 还是 SSH、HTTPS 还是 HTTPS,端口与 .git 后缀原样 */
export function rewriteOfficialUrl(url: string, from: string, to: string): string | null {
  const p = parseOfficialShape(url);
  return p && p.slug === from ? `${p.prefix}${to}${p.suffix}` : null;
}

/** 合法的 GitHub owner/repo(目标仓库校验用) */
export const isSlug = (s: string): boolean => new RegExp(`^${OWNER}/[A-Za-z0-9._-]{1,100}$`).test(s) && !s.endsWith(".git");
