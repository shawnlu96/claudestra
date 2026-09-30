/**
 * update 的「进行中」标记：state/update-inflight.json（tests/update-inflight.test.ts）。
 *
 * 为什么不借 update.lock 本身：update 在 reload 四个 daemon **之前**就得释锁——bootout launcher
 * 会连坐回收 launcher 派生的 update 进程（lib/cli-install.ts DAEMONS 的注释），殉锁会封死之后
 * 30 分钟的更新。标记要活过这一刻，reload 做完才删。再跑 update 或 doctor 看到它，按 HEAD 与
 * daemon 的启动时间判断补哪一截；launcher 自杀那种正常情况 bridge / cron 已 reload，只清标记。
 */
import { spawnSync } from "child_process";
import { existsSync, readFileSync, rmSync } from "fs";
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
  /** 已经补过一次 reload：再判出「要补 reload」就放弃（移去 abandoned），别让一个起不来的 daemon 永远挡住新版本 */
  reloadRetried?: boolean;
  /** 移去 abandoned 时写下的原因（HEAD 被改到别处 / 补过 reload 仍有 daemon 没起来，含是哪几个） */
  abandonReason?: string;
}

/** daemon 现状：数字 = 在跑，自该时刻起；null = 已 load 但没在跑（崩溃循环 / 退出了，reload 修不好）；unloaded = 没 load（reload 能修） */
export type DaemonState = number | null | "unloaded";

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

/** 放弃补完：标记连同原因挪到 UPDATE_ABANDONED 留给 doctor（现场不能静默消失），不再挡住之后的 update */
export async function abandonUpdateMarker(reason: string, from = UPDATE_INFLIGHT, to = UPDATE_ABANDONED): Promise<void> {
  const m = readUpdateMarker(from);
  if (m) await writeJsonAtomic(to, { ...m, abandonReason: reason });
  rmSync(from, { force: true });
}

export type UpdateVerdict =
  | { action: "live" }
  | { action: "clear"; why: string }
  | { action: "finish-reload"; stale: string[] }
  | { action: "finish-tail" }
  | { action: "report"; why: string };

/**
 * 标记 + 现状 → 该做什么。daemonStart 见 DaemonState：只有「在跑但早于 reloadAt」和「没 load」算 reload 没做完；
 * 已 load 却起不来的交给 doctor 的 daemon 检查，不拿来挡更新。
 * 已到 reloading 且四个 daemon 都在 reloadAt 之后起来过 = 做完了（launcher 连坐回收的常态），不管 HEAD 后来被谁动过。
 * 其余在 HEAD 等于目标、或在目标之后（headAhead：有人在目标上又提交了，尾段不依赖具体 HEAD）时补做；
 * HEAD 既不在目标线上也不是升级前 = 仓库被改到别处，不补（report）。
 */
export function updateVerdict(
  m: UpdateMarker,
  head: string,
  now: number,
  alive: (pid: number) => boolean,
  daemonStart: Record<string, DaemonState>,
  headAhead = false,
): UpdateVerdict {
  if (alive(m.pid) && now - Date.parse(m.startedAt) < UPDATE_LIVE_MS) return { action: "live" };
  const since = Date.parse(m.reloadAt ?? m.startedAt);
  // ps 的 lstart 只到秒：留 1 秒余量，免得 reload 同一秒内起来的 daemon 被判成没重启
  const stale = Object.entries(daemonStart).filter(([, t]) => t === "unloaded" || (typeof t === "number" && t < since - 1000)).map(([label]) => label);
  if (m.step === "reloading" && !stale.length) return { action: "clear", why: "daemon 都已在 reload 之后重启过（起不来的归 doctor 的 daemon 检查）" };
  if (head !== m.target && !headAhead) {
    return head === m.fromHead
      ? { action: "clear", why: "上次没走到切换版本，仓库还在升级前" }
      : { action: "report", why: `HEAD ${head.slice(0, 7)} 既不是目标 ${m.targetLabel} 也不是升级前 ${m.fromHead.slice(0, 7)}（有人动过仓库）` };
  }
  if (m.step !== "reloading") return { action: "finish-tail" };
  return m.reloadRetried
    ? { action: "report", why: `已经补过一次 reload，${stale.join(", ")} 仍没重启` }
    : { action: "finish-reload", stale };
}

/** launchd 托管进程的现状（DaemonState）；读不到启动时间按「没在跑」算 */
export function launchdStartedAt(label: string): DaemonState {
  const l = spawnSync("launchctl", ["list", label], { encoding: "utf8" });
  if (l.status !== 0) return "unloaded";
  const pid = /"PID"\s*=\s*(\d+)/.exec(l.stdout || "")?.[1];
  if (!pid) return null;
  const ps = spawnSync("ps", ["-o", "lstart=", "-p", pid], { encoding: "utf8", env: { ...process.env, LC_ALL: "C" } });
  const t = Date.parse((ps.stdout || "").trim());
  return Number.isFinite(t) ? t : null;
}
