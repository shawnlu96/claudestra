/**
 * 版本比对的纯逻辑（tests/web-version-check.test.ts）——三件事分开判：
 *   bundleStale：托管方（bridge 或中继）发布的前端比本 bundle 新 → 「新版本已就绪 · 点击刷新」。
 *     有 webCommit（最后一个动过 web/ 的提交）就精确比它——拿 HEAD 比会让任何只改 src/ 的后端提交都亮黄字（2026-08-15 假警）；
 *     只有 commit 时退回比 HEAD。两边都取不到（裸包无 git）不算滞后。
 *   machineTooOld：机器的 apiVersion 低于本前端要求 → 「这台机器需要升级」（中继模式下别的机器可能是新的，按机器判）。
 *   clientTooOld：机器要求的 minClient 高于本 bundle 版本 → 必须刷新前端。
 */
export interface ClientBuild {
  commit: string;
  webCommit: string;
  version: string;
}
export interface RemoteVersion {
  commit?: string;
  webCommit?: string;
  apiVersion?: number;
  minClient?: string;
}

/** 本前端会说的 API 版本；bridge 报的比它小就是老机器 */
export const REQUIRED_API_VERSION = 1;

/** 返回「服务端那个不一样的 id」（给刷新做 cache-busting 参数），一致或判不了 → null */
export function bundleStale(remote: RemoteVersion | null, client: ClientBuild): string | null {
  if (!remote) return null;
  if (remote.webCommit && client.webCommit) return remote.webCommit !== client.webCommit ? remote.webCommit : null;
  if (remote.commit && client.commit) return remote.commit !== client.commit ? remote.commit : null;
  return null;
}

/** 老 bridge 没有 apiVersion 字段（/api/v1/version 本身就是新端点）——判不了就不吓人 */
export function machineTooOld(remote: RemoteVersion | null): boolean {
  return typeof remote?.apiVersion === "number" && remote.apiVersion < REQUIRED_API_VERSION;
}

/** semver 主.次.补丁比较；解析不了的按相等（不误判） */
export function semverLt(a: string, b: string): boolean {
  const pa = parse(a);
  const pb = parse(b);
  if (!pa || !pb) return false;
  for (let i = 0; i < 3; i++) if (pa[i] !== pb[i]) return pa[i] < pb[i];
  return false;
}
function parse(v: string): [number, number, number] | null {
  const m = /^v?(\d+)\.(\d+)\.(\d+)/.exec(v.trim());
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

export function clientTooOld(remote: RemoteVersion | null, clientVersion: string): boolean {
  return !!remote?.minClient && !!clientVersion && semverLt(clientVersion, remote.minClient);
}
