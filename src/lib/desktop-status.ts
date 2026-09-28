/**
 * 菜单栏小程序（desktop/）要的服务状态：读 `launchctl list` 一次，给每个 daemon 出一个结论。
 * 菜单栏每隔几秒刷一次，所以这里只做毫秒级的只读判断；完整体检仍是 doctor（一次十几秒）。
 * 判定是纯函数（tests/desktop-status.test.ts），退出码的口径与 doctor 共用 classifyDaemonExit。
 */

import { DAEMONS } from "./cli-install.js";
import { classifyDaemonExit, type CheckStatus } from "./doctor.js";

export interface DaemonState {
  label: string;
  /** 给人看的短名：bridge / cron / launcher */
  name: string;
  status: CheckStatus;
  running: boolean;
  pid: number | null;
  detail: string;
}

/** 换 label 只给开发实测用（假 LaunchAgent），生产不设；非法值直接报错而不是悄悄回落到真服务 */
export const LABELS_ENV = "CLAUDESTRA_DESKTOP_LABELS";
const LABEL_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

export function desktopLabels(env: Record<string, string | undefined> = process.env): string[] {
  const raw = (env[LABELS_ENV] || "").trim();
  if (!raw) return DAEMONS.map((d) => d.label);
  const labels = raw.split(",").map((s) => s.trim()).filter(Boolean);
  const bad = labels.filter((l) => !LABEL_RE.test(l));
  if (bad.length || !labels.length) throw new Error(`${LABELS_ENV} 里有不合法的 label：${bad.join(", ") || "(空)"}`);
  return labels;
}

/** `launchctl list` 输出：`<pid>\t<last exit status>\t<label>`；按 label 整列精确匹配，前缀相同的别的服务不算 */
export function launchctlEntry(listOut: string, label: string): { pid: string; exit: string } | null {
  for (const line of listOut.split("\n")) {
    const cols = line.split("\t");
    if (cols.length >= 3 && cols[2].trim() === label) return { pid: cols[0].trim(), exit: cols[1].trim() };
  }
  return null;
}

export function daemonState(listOut: string, label: string, plistExists: boolean): DaemonState {
  const name = label.split(".").pop() || label;
  const entry = launchctlEntry(listOut, label);
  if (!entry) {
    return plistExists
      ? { label, name, status: "fail", running: false, pid: null, detail: "plist 在，但没有加载" }
      : { label, name, status: "fail", running: false, pid: null, detail: "没装" };
  }
  const v = classifyDaemonExit(entry.pid, entry.exit);
  const pid = entry.pid === "-" ? null : Number(entry.pid) || null;
  return { label, name, status: v.status, running: pid !== null, pid, detail: v.detail };
}

/** 汇总成菜单栏一盏灯：有 fail 就红，有 warn 就黄，全 ok 才绿 */
export function overallStatus(states: { status: CheckStatus }[]): CheckStatus {
  if (states.some((s) => s.status === "fail")) return "fail";
  if (states.some((s) => s.status === "warn")) return "warn";
  return "ok";
}
