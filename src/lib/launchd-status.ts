/**
 * 读 `launchctl list` 判断一个 launchd 服务的状态。doctor 和菜单栏小程序（desktop-cli status）共用这一份，
 * 两边对同一台机器必须给出同一个结论。纯函数，tests/desktop-status.test.ts / tests/doctor.test.ts。
 * 结论是结构化的 reason，文案由出口用 daemonDetail 按自己的语言渲染（doctor 中文、菜单栏英文），这里不拼句子。
 */

import type { CheckStatus } from "./doctor.js";

export type DaemonReason =
  | { code: "running"; pid: string }
  | { code: "stopped"; exit: string }
  | { code: "sigkilled"; pid: string }
  | { code: "abnormal_exit"; pid: string; exit: string }
  | { code: "not_loaded" }
  | { code: "not_installed" };

/** 两种语言逐条对照；新增 code 时 TS 会逼着两边都写 */
export function daemonDetail(r: DaemonReason, lang: "zh" | "en"): string {
  const zh = lang === "zh";
  switch (r.code) {
    case "running": return `pid ${r.pid}`;
    case "stopped": return zh ? `没在跑（上次退出状态 ${r.exit}）` : `not running (last exit status ${r.exit})`;
    case "sigkilled": return zh ? `pid ${r.pid} 在跑，但上次是被 SIGKILL 强杀的（OOM？）` : `pid ${r.pid} running, but was last killed by SIGKILL (OOM?)`;
    case "abnormal_exit": return zh ? `pid ${r.pid} 在跑，但上次异常退出（code ${r.exit}）` : `pid ${r.pid} running, but last exited abnormally (code ${r.exit})`;
    case "not_loaded": return zh ? "plist 在，但没 load" : "plist present but not loaded";
    case "not_installed": return zh ? "没装" : "not installed";
  }
}

/**
 * `launchctl list` 一行里的 (pid, last exit status) → 结论。
 *
 * 关键在于**负数不等于崩溃**：负数是「被信号终止」，而 -15(SIGTERM) 正是
 * `launchctl kickstart -k` 和正常 stop 的结果。曾经把它一律报成「崩过」，
 * 于是每次重启 bridge 之后 doctor 都亮黄灯 —— 几次之后人就不看警告了，
 * 这比不报警更糟。只有进程自己 exit 非 0、或 -9(SIGKILL，多半 OOM 或被强杀)
 * 才值得提。
 */
export function classifyDaemonExit(pid: string, exit: string): { status: CheckStatus; reason: DaemonReason } {
  const code = parseInt(exit) || 0;
  if (pid === "-") return { status: "fail", reason: { code: "stopped", exit } };
  if (code === 0 || code === -15 || code === -2 || code === -1) return { status: "ok", reason: { code: "running", pid } };
  if (code === -9) return { status: "warn", reason: { code: "sigkilled", pid } };
  return { status: "warn", reason: { code: "abnormal_exit", pid, exit } };
}

export interface DaemonState {
  label: string;
  /** 给人看的短名，也是日志文件名的 stem：bridge / cron / launcher */
  name: string;
  status: CheckStatus;
  /** launchd 里有这个 label（没有 = 没装或 plist 没加载） */
  loaded: boolean;
  running: boolean;
  pid: number | null;
  reason: DaemonReason;
}

/** `launchctl list` 输出：`<pid>\t<last exit status>\t<label>`；按 label 整列精确匹配，前缀相同的别的服务不算 */
export function launchctlEntry(listOut: string, label: string): { pid: string; exit: string } | null {
  for (const line of listOut.split("\n")) {
    const cols = line.split("\t");
    if (cols.length >= 3 && cols[2].trim() === label) return { pid: cols[0].trim(), exit: cols[1].trim() };
  }
  return null;
}

/** 没装（连 plist 都没有）只算 warn：还没跑 install-cli 的机器不该亮红灯；plist 在却没加载才是 fail */
export function daemonState(listOut: string, label: string, plistExists: boolean): DaemonState {
  const name = label.split(".").pop() || label;
  const entry = launchctlEntry(listOut, label);
  if (!entry) {
    return plistExists
      ? { label, name, status: "fail", loaded: false, running: false, pid: null, reason: { code: "not_loaded" } }
      : { label, name, status: "warn", loaded: false, running: false, pid: null, reason: { code: "not_installed" } };
  }
  const v = classifyDaemonExit(entry.pid, entry.exit);
  const pid = entry.pid === "-" ? null : Number(entry.pid) || null;
  return { label, name, status: v.status, loaded: true, running: pid !== null, pid, reason: v.reason };
}
