/**
 * 菜单栏小程序（desktop/）要的判定：盯哪几个 launchd 服务、汇总成一盏灯、现在能不能重启。
 * 单个服务的状态口径在 launchd-status.ts（和 doctor 共用）。纯函数，tests/desktop-status.test.ts。
 */

import { DAEMONS } from "./cli-install.js";
import type { CheckStatus } from "./doctor.js";

/**
 * 换 label 只给开发实测用（假 LaunchAgent），生产不设。设了就必须是合法的非空列表：
 * 设成空白悄悄回落到真服务，等于一次「测试」就 kickstart 了线上。com.apple.* 一律拒绝。
 */
export const LABELS_ENV = "CLAUDESTRA_DESKTOP_LABELS";
const LABEL_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

export function desktopLabels(env: Record<string, string | undefined> = process.env): string[] {
  const raw = env[LABELS_ENV];
  if (raw === undefined) return DAEMONS.map((d) => d.label);
  const labels = raw.split(",").map((s) => s.trim()).filter(Boolean);
  if (!labels.length) throw new Error(`${LABELS_ENV} is set but empty; unset it unless you mean to override`);
  const bad = labels.filter((l) => !LABEL_RE.test(l) || /^com\.apple\./i.test(l));
  if (bad.length) throw new Error(`${LABELS_ENV} has invalid labels: ${bad.join(", ")}`);
  return labels;
}

/** Bun 启动时自动加载的 env 文件（.env、.env.local、.env.$NODE_ENV）：覆盖写进任何一个都会长期生效 */
export const BUN_AUTO_ENV_FILES = [".env", ".env.local", ".env.development", ".env.production", ".env.test"];

/** 哪些自动加载的 env 文件里写了 label 覆盖（read 读不到文件返回 null） */
export function labelsOverrideFiles(read: (file: string) => Record<string, string> | null): string[] {
  return BUN_AUTO_ENV_FILES.filter((f) => {
    const vars = read(f);
    return vars !== null && LABELS_ENV in vars;
  });
}

/** 汇总成菜单栏一盏灯：有 fail 就红，有 warn 就黄，全 ok 才绿 */
export function overallStatus(states: { status: CheckStatus }[]): CheckStatus {
  if (states.some((s) => s.status === "fail")) return "fail";
  if (states.some((s) => s.status === "warn")) return "warn";
  return "ok";
}

/** 与 manager 的 update 互斥同一口径：锁里的 pid 还活着、锁未满 30 分钟 = 更新正在进行 */
const UPDATE_LOCK_FRESH_MS = 30 * 60_000;

/**
 * update.lock → 正在更新的持有 pid，没有在更新则 null。
 * 更新期间重启会砍掉它：update 子进程常由 launcher 派生，kickstart launcher 会把它连坐回收。
 */
export function updateHolder(
  lock: { text: string; mtimeMs: number } | null,
  now: number,
  alive: (pid: number) => boolean,
): number | null {
  if (!lock) return null;
  const pid = parseInt(lock.text.trim(), 10);
  if (!(pid > 0) || now - lock.mtimeMs >= UPDATE_LOCK_FRESH_MS) return null;
  return alive(pid) ? pid : null;
}
