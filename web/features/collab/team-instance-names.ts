/**
 * 执行实例 id → 给人看的机器名（team-project-UXWHO1，UXCARD1 也用）：本机实例 →「本机」，本机 shared-projects 快照里
 * 记了实例 id 的 peer → peer 名，对不上的 →「其他成员的机器」。实例 id 只进 title 提示，可见文字里不出现长十六进制
 * （中心投影里的成员代号 / 实例 id 原样是 24 位十六进制，体检报告第 3 条）。纯函数；读快照的 hook 在 work/use-work-board.ts useInstanceNames。
 */
import type { ProjectSnapshot } from "@/lib/shared-projects-model";

export type InstanceNames = ReadonlyMap<string, string>;
export const LOCAL_MACHINE = "本机";
export const OTHER_MACHINE = "其他成员的机器";
export const NO_NAMES: InstanceNames = new Map();

/** 16 位以上连续十六进制：原始 id 的样子，可见文字里不放 */
const HEX_RUN = /[0-9a-f]{16,}/i;
export const hexFree = (s: string | null | undefined): string | null => (s && s.trim() && !HEX_RUN.test(s) ? s.trim() : null);

/** 快照 peers → 实例 id 表；peer 名本身像 id 的不收（宁可写「其他成员的机器」） */
export function peerInstanceNames(peers: readonly ProjectSnapshot["peers"][number][]): Map<string, string> {
  const out = new Map<string, string>();
  for (const p of peers) {
    const name = hexFree(p.name);
    if (p.instanceId && name && !out.has(p.instanceId)) out.set(p.instanceId, name);
  }
  return out;
}

/** 没有执行实例为 null；本机实例（团队键里的 homeInstanceId）写「本机」 */
export function instanceName(id: string | null, names: InstanceNames, localInstance: string | null): string | null {
  if (id === null) return null;
  if (localInstance && id === localInstance) return LOCAL_MACHINE;
  return hexFree(names.get(id)) ?? OTHER_MACHINE;
}
