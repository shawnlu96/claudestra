/**
 * 停 / 恢复写者。launchd 用可恢复的 disable + bootout(只 kill PID 会被 KeepAlive 拉起),恢复用 enable + bootstrap;
 * 只恢复窗口前在跑的服务。会话(master、全部 Claude/Pi/Codex、channel-server 及其后代)由 tmux 收掉,
 * 原样记下窗口与 pid,launcher 恢复后由它的开机恢复波按 registry 拉回;不愿退出就拒绝,不补刀强杀。
 * 顺序:先关自动拉起与新任务入口(launcher、scheduler、cron),再停会话,最后停 bridge。tests/state-maintenance-services.test.ts。
 */

import type { Run } from "./probe.js";

export const SERVICE_LABELS = ["com.claudestra.launcher", "com.claudestra.scheduler", "com.claudestra.cron", "com.claudestra.bridge"] as const;
/** 新任务入口与自动拉起先停;bridge 最后停(停之前维护页已就绪,停了之后执行器与维护页照常) */
const BEFORE_SESSIONS = SERVICE_LABELS.slice(0, 3);
const AFTER_SESSIONS = SERVICE_LABELS.slice(3);

export interface ServiceState {
  label: string;
  /** 窗口前是否已在 launchd 里 */
  loaded: boolean;
  /** 相对 home 的 plist(恢复时 bootstrap 它) */
  plist: string;
}

export interface SessionSnapshot { windows: string[]; pids: number[] }

export interface SessionOps {
  /** 窗口前的会话窗口与全部 pane 进程及后代;读不到返回 error(拒绝,不能当成没有会话) */
  snapshot(): Promise<SessionSnapshot | { error: string }>;
  /** 收掉会话(tmux 关服务器,pane 收到 SIGHUP 自行退出);不强杀 */
  stop(): Promise<void>;
  /** 此刻的会话窗口名 */
  windows(): Promise<string[]>;
}

export interface ServiceDeps {
  run: Run;
  uid: number;
  home: string;
  sessions: SessionOps;
  pidAlive: (pid: number) => boolean;
  sleep: (ms: number) => Promise<void>;
  /** 每个服务 / 会话排空的等待上限 */
  drainMs: number;
}

const domain = (d: ServiceDeps) => `gui/${d.uid}`;
const plistOf = (label: string) => `Library/LaunchAgents/${label}.plist`;

export async function recordServices(d: ServiceDeps): Promise<ServiceState[] | { error: string }> {
  const out: ServiceState[] = [];
  for (const label of SERVICE_LABELS) {
    const r = await d.run(["launchctl", "print", `${domain(d)}/${label}`], 15_000);
    if (r.spawnError) return { error: `launchctl 无法运行(${r.spawnError})` };
    if (r.code !== 0 && r.code !== 113) return { error: `launchctl print ${label} 退出码 ${r.code ?? "超时"}` };
    out.push({ label, loaded: r.code === 0, plist: plistOf(label) });
  }
  return out;
}

async function waitGone(d: ServiceDeps, label: string): Promise<boolean> {
  const deadline = Date.now() + d.drainMs;
  for (;;) {
    const r = await d.run(["launchctl", "print", `${domain(d)}/${label}`], 15_000);
    if (r.code === 113) return true;
    if (Date.now() >= deadline) return false;
    await d.sleep(500);
  }
}

async function stopService(d: ServiceDeps, s: ServiceState, done: string[]): Promise<string | null> {
  if (!s.loaded) return null;
  const off = await d.run(["launchctl", "disable", `${domain(d)}/${s.label}`], 15_000);
  if (off.code !== 0) return `停用 ${s.label} 失败(${off.spawnError ?? off.code})`;
  done.push(s.label);
  const out = await d.run(["launchctl", "bootout", `${domain(d)}/${s.label}`], d.drainMs + 15_000);
  if (out.code !== 0 && out.code !== 113 && out.code !== 3) return `卸载 ${s.label} 失败(${out.spawnError ?? out.code})`;
  return (await waitGone(d, s.label)) ? null : `${s.label} 在 ${d.drainMs}ms 内没有退出,拒绝(不强杀)`;
}

async function waitPids(d: ServiceDeps, pids: number[]): Promise<number[]> {
  const deadline = Date.now() + d.drainMs;
  for (;;) {
    const alive = pids.filter(d.pidAlive);
    if (!alive.length || Date.now() >= deadline) return alive;
    await d.sleep(500);
  }
}

/**
 * 按顺序停;任何一步失败立刻返回错误(已停的记在 stopped 里,调用方据此恢复)。
 * 会话快照读不到同样拒绝:不知道停了谁,就没法证明停完、也没法按原样恢复。
 */
export async function stopAll(d: ServiceDeps, services: ServiceState[], sessions: SessionSnapshot, stopped: string[]): Promise<string | null> {
  for (const label of BEFORE_SESSIONS) {
    const err = await stopService(d, services.find((s) => s.label === label)!, stopped);
    if (err) return err;
  }
  if (sessions.windows.length || sessions.pids.length) {
    await d.sessions.stop();
    stopped.push("sessions");
    const alive = await waitPids(d, sessions.pids);
    if (alive.length) return `会话进程 ${alive.join("、")} 在 ${d.drainMs}ms 内没有退出,拒绝(不强杀)`;
  }
  for (const label of AFTER_SESSIONS) {
    const err = await stopService(d, services.find((s) => s.label === label)!, stopped);
    if (err) return err;
  }
  return null;
}

export interface RestoreResult { ok: boolean; problems: string[]; missingWindows: string[] }

/** 只恢复窗口前在跑、这次停过的服务;会话由 launcher 恢复后拉回,这里只核窗口有没有回来 */
export async function restoreAll(d: ServiceDeps, services: ServiceState[], sessions: SessionSnapshot, stopped: string[], waitSessionsMs: number): Promise<RestoreResult> {
  const problems: string[] = [];
  for (const s of [...services].reverse()) {
    if (!s.loaded || !stopped.includes(s.label)) continue;
    const on = await d.run(["launchctl", "enable", `${domain(d)}/${s.label}`], 15_000);
    if (on.code !== 0) problems.push(`启用 ${s.label} 失败(${on.spawnError ?? on.code})`);
    const boot = await d.run(["launchctl", "bootstrap", domain(d), `${d.home}/${s.plist}`], 30_000);
    if (boot.code !== 0) problems.push(`拉起 ${s.label} 失败(${boot.spawnError ?? boot.code})`);
  }
  let missing: string[] = [];
  if (stopped.includes("sessions")) {
    const deadline = Date.now() + waitSessionsMs;
    for (;;) {
      const now = new Set(await d.sessions.windows().catch(() => [] as string[])); // 读不到窗口按「还没回来」算,到点后如实报缺
      missing = sessions.windows.filter((w) => !now.has(w));
      if (!missing.length || Date.now() >= deadline) break;
      await d.sleep(2_000);
    }
    if (missing.length) problems.push(`会话还没回来:${missing.join("、")}`);
  }
  return { ok: !problems.length, problems, missingWindows: missing };
}
