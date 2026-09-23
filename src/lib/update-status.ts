/**
 * 「当前通道下能升到哪个版本」——网页「版本与更新」一节用（GET /api/v1/update/check）。
 *
 * 与 `manager update` / launcher 的判据一致：release 通道比 GitHub 最新正式版的版本号
 * （本地已在更新的提交上时不算可升，开发机常见）；beta 通道比 origin/main 的提交。
 * 查不到远端时 upToDate=null 并带原因，不猜「已是最新」。
 */
import { REPO_ROOT } from "./repo-root.js";
import { getLatestRelease, getLocalVersion, isNewer, type ReleaseInfo } from "./github-release.js";
import type { UpdateChannel } from "./config-store.js";

export interface UpdateStatus {
  channel: UpdateChannel;
  current: { version: string; head: string };
  /** 能升到的目标：release 为 tag（v2.24.1），beta 为 main 的短 sha */
  latest: string | null;
  /** beta：本地落后 main 的提交数 */
  behind?: number;
  upToDate: boolean | null;
  error?: string;
}

export interface StatusInput {
  channel: UpdateChannel;
  version: string;
  head: string;
  release?: ReleaseInfo | null;
  remoteHead?: string;
  behind?: number;
}

/** 纯判定（tests/update-status.test.ts） */
export function summarizeUpdate(i: StatusInput): UpdateStatus {
  const current = { version: i.version, head: i.head.slice(0, 7) };
  if (i.channel === "beta") {
    if (!i.remoteHead) return { channel: "beta", current, latest: null, upToDate: null, error: "拿不到 origin/main（网络或 git 远端问题）" };
    const upToDate = i.remoteHead === i.head || i.behind === 0;
    return { channel: "beta", current, latest: i.remoteHead.slice(0, 7), behind: i.behind, upToDate };
  }
  if (!i.release) return { channel: "release", current, latest: null, upToDate: null, error: "查不到 GitHub 最新正式版（网络问题或仓库无 release）" };
  return { channel: "release", current, latest: i.release.tag, upToDate: !isNewer(i.release.version, i.version) };
}

async function git(...args: string[]): Promise<string> {
  const p = Bun.spawn(["git", "-C", REPO_ROOT, ...args], { stdout: "pipe", stderr: "ignore" });
  const out = (await new Response(p.stdout).text()).trim();
  return (await p.exited) === 0 ? out : "";
}

export async function checkUpdateStatus(channel: UpdateChannel): Promise<UpdateStatus> {
  const [version, head] = await Promise.all([getLocalVersion(), git("rev-parse", "HEAD")]);
  if (channel === "release") return summarizeUpdate({ channel, version, head, release: await getLatestRelease() });
  // 与 launcher 的 beta 巡检同一动作：只更新 origin/main 这个远端引用，不动工作树
  await git("fetch", "--quiet", "origin", "main");
  const remoteHead = await git("rev-parse", "origin/main");
  const behind = Number(await git("rev-list", "--count", "HEAD..origin/main"));
  return summarizeUpdate({ channel, version, head, remoteHead: remoteHead || undefined, behind: Number.isFinite(behind) ? behind : undefined });
}
