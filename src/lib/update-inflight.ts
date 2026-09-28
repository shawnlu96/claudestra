/**
 * update 的「进行中」标记：state/update-inflight.json（tests/update-inflight.test.ts）。
 *
 * 为什么不借 update.lock 本身：update 在 reload 三个 daemon **之前**就得释锁——bootout launcher
 * 会连坐回收 launcher 派生的 update 进程（lib/cli-install.ts DAEMONS 的注释），殉锁会封死之后
 * 30 分钟的更新。标记要活过这一刻，reload 做完才删。再跑 update 或 doctor 看到它，按 HEAD 与
 * daemon 的启动时间判断补哪一截；launcher 自杀那种正常情况 bridge / cron 已 reload，只清标记。
 */
import { spawnSync } from "child_process";
import { existsSync, readFileSync, renameSync, rmSync } from "fs";
import { statePath } from "./paths.js";
import { writeJsonAtomic } from "./state-file.js";

export const UPDATE_INFLIGHT = statePath("update-inflight.json");
/** 补不了（HEAD 被人改到别处）的标记改名存这里：doctor 继续报，下一次完整 reload 成功后删 */
export const UPDATE_ABANDONED = statePath("update-inflight.abandoned.json");

/** checkout 之后按序推进；reloading = 已释锁、开始 reload daemon */
export type UpdateStep = "checkout" | "installed" | "built" | "migrated" | "reloading";

export interface UpdateMarker {
  pid: number;
  channel: "release" | "beta";
  /** 目标 commit 的完整 sha（tag 解引用后），与 HEAD 比 */
  target: string;
  /** 给人看：release tag 或 beta 的短 sha */
  targetLabel: string;
  fromHead: string;
  step: UpdateStep;
  startedAt: string;
  reloadAt?: string;
}

/** 持有者还活着且没超过 update.lock 的陈旧闸（30 分钟）= 另一次 update 在跑 */
const UPDATE_LIVE_MS = 30 * 60_000;

export function readUpdateMarker(path = UPDATE_INFLIGHT): UpdateMarker | null {
  if (!existsSync(path)) return null;
  try {
    const m = JSON.parse(readFileSync(path, "utf8"));
    return m && typeof m.target === "string" && typeof m.step === "string" ? (m as UpdateMarker) : null;
  } catch {
    return null; // 半截 / 坏文件：当没有标记，update 照常走（写入是原子的，正常不会出现）
  }
}

export async function writeUpdateMarker(m: UpdateMarker, path = UPDATE_INFLIGHT): Promise<void> {
  await writeJsonAtomic(path, m);
}

export function clearUpdateMarker(path = UPDATE_INFLIGHT): void {
  rmSync(path, { force: true });
}

/** 放弃补完：标记挪到 UPDATE_ABANDONED 留给 doctor（现场不能静默消失），不再挡住之后的 update */
export function abandonUpdateMarker(from = UPDATE_INFLIGHT, to = UPDATE_ABANDONED): void {
  renameSync(from, to);
}

export type UpdateVerdict =
  | { action: "live" }
  | { action: "clear"; why: string }
  | { action: "finish-reload"; stale: string[] }
  | { action: "finish-tail" }
  | { action: "report"; why: string };

/**
 * 标记 + 现状 → 该做什么。daemonStart 给出每个 daemon 当前进程的启动时刻（没在跑 = null）。
 * 已到 reloading 且三个 daemon 都在 reloadAt 之后起来过 = 做完了（launcher 连坐回收的常态），不管 HEAD 后来被谁动过。
 * 其余在 HEAD 等于目标、或在目标之后（headAhead：有人在目标上又提交了，尾段不依赖具体 HEAD）时补做；
 * HEAD 既不在目标线上也不是升级前 = 仓库被改到别处，不补（report）。
 */
export function updateVerdict(
  m: UpdateMarker,
  head: string,
  now: number,
  alive: (pid: number) => boolean,
  daemonStart: Record<string, number | null>,
  headAhead = false,
): UpdateVerdict {
  if (alive(m.pid) && now - Date.parse(m.startedAt) < UPDATE_LIVE_MS) return { action: "live" };
  const since = Date.parse(m.reloadAt ?? m.startedAt);
  // ps 的 lstart 只到秒：留 1 秒余量，免得 reload 同一秒内起来的 daemon 被判成没重启
  const stale = Object.entries(daemonStart).filter(([, t]) => t === null || t < since - 1000).map(([label]) => label);
  if (m.step === "reloading" && !stale.length) return { action: "clear", why: "三个 daemon 都已在 reload 之后重启过" };
  if (head !== m.target && !headAhead) {
    return head === m.fromHead
      ? { action: "clear", why: "上次没走到切换版本，仓库还在升级前" }
      : { action: "report", why: `HEAD ${head.slice(0, 7)} 既不是目标 ${m.targetLabel} 也不是升级前 ${m.fromHead.slice(0, 7)}（有人动过仓库）` };
  }
  return m.step === "reloading" ? { action: "finish-reload", stale } : { action: "finish-tail" };
}

/** launchd 托管进程的启动时刻（ms）；没 load / 没在跑 / 读不到 = null */
export function launchdStartedAt(label: string): number | null {
  const l = spawnSync("launchctl", ["list", label], { encoding: "utf8" });
  const pid = l.status === 0 ? /"PID"\s*=\s*(\d+)/.exec(l.stdout || "")?.[1] : undefined;
  if (!pid) return null;
  const ps = spawnSync("ps", ["-o", "lstart=", "-p", pid], { encoding: "utf8", env: { ...process.env, LC_ALL: "C" } });
  const t = Date.parse((ps.stdout || "").trim());
  return Number.isFinite(t) ? t : null;
}
