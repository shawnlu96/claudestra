/**
 * doctor 里「状态留痕」类检查（从 doctor.ts 拆出，doctor.ts 只留调用）：
 *   - notify 投递失败的 undelivered-alerts.log
 *   - tmux 全局环境与 .env 的安装级变量漂移
 * 判定都是纯函数，tests/doctor.test.ts。
 */

import { readFile } from "fs/promises";
import type { Check } from "./doctor.js";
import { parseTmuxEnvLine } from "./bridge-port.js";
import { TMUX_SOCK, UNDELIVERED_ALERTS_LOG } from "./paths.js";

/**
 * notify 投递失败会追加到 undelivered-alerts.log（lib/notify）。以前没人读它——告警没送达
 * 这件事本身也没送达。有条目就 warn；文件不存在 / 为空不出这一行（健康实例输出不变）。
 * 纯函数，tests/doctor.test.ts。
 */
export function undeliveredAlertsVerdict(text: string | null, path: string, now = Date.now()): Check | null {
  if (!text) return null;
  const lines = text.split("\n").filter((l) => l.trim());
  if (lines.length === 0) return null;
  let last: { ts?: string; source?: string; reason?: string } = {};
  try { last = JSON.parse(lines[lines.length - 1]!); } catch { /* 坏行：只报条数 */ }
  const WEEK = 7 * 24 * 3600 * 1000;
  const recent = lines.filter((l) => {
    try {
      const t = Date.parse(JSON.parse(l).ts);
      return Number.isFinite(t) && now - t < WEEK;
    } catch { return false; }
  }).length;
  const lastDesc = last.ts ? `；最近一条 ${last.ts}${last.source ? ` [${last.source}]` : ""}${last.reason ? `：${last.reason}` : ""}` : "";
  return {
    group: "告警投递", name: "未送达告警", status: "warn",
    detail: `${lines.length} 条（近 7 天 ${recent} 条）${lastDesc}`,
    fix: `看 ${path} 里没送到的告警内容；处理完后清空该文件（: > ${path}）`,
  };
}


export async function checkUndeliveredAlerts(): Promise<Check[]> {
  // 读不到 = 文件不存在 = 从没有投递失败过，这一行本就不该出现
  const text = await readFile(UNDELIVERED_ALERTS_LOG, "utf-8").catch(() => null); // 不存在即没有未送达告警
  const v = undeliveredAlertsVerdict(text, UNDELIVERED_ALERTS_LOG);
  return v ? [v] : [];
}

/**
 * 安装级变量（BRIDGE_PORT / BRIDGE_URL 由上面的「会话连接地址」单独判）在 tmux 全局环境里
 * 的值与 .env 不一致的键名（D7-3）。tmux server 的 env 停在它被创建那一刻，之后改 .env
 * 不会传进去。只报「两边都有且值不同」；tmux 里缺的不报（manager 已改为回读 .env）。
 * 返回键名，不返回值——DISCORD_BOT_TOKEN 也在里面。纯函数，tests/doctor.test.ts。
 */
export const INSTALL_ENV_KEYS = [
  "DISCORD_BOT_TOKEN", "DISCORD_GUILD_ID", "ALLOWED_USER_IDS", "CONTROL_CHANNEL_ID",
  "MASTER_DIR", "USER_NAME", "BRIDGE_BIND", "MCP_NAME", "CODEX_BIN",
];
export function staleInstallEnvKeys(
  tmuxEnvOut: string,
  dotenv: Record<string, string>,
  parseLine: (out: string, name: string) => string | undefined,
): string[] {
  return INSTALL_ENV_KEYS.filter((k) => {
    const t = parseLine(tmuxEnvOut, k);
    const e = dotenv[k];
    return t !== undefined && e !== undefined && e !== "" && t !== e;
  });
}

/** staleInstallEnvKeys → doctor 行（没有漂移返回空数组） */
export function staleInstallEnvCheck(tmuxEnvOut: string, dotenv: Record<string, string>, group: string): Check[] {
  const stale = staleInstallEnvKeys(tmuxEnvOut, dotenv, parseTmuxEnvLine);
  if (!stale.length) return [];
  return [{
    group, name: "tmux 全局环境", status: "warn",
    detail: `${stale.join(", ")} 与 .env 不一致 —— 新开的 agent / 大总管调起的 manager 拿到的是旧值`,
    fix: `逐个 tmux -S ${TMUX_SOCK} set-environment -g <KEY> <.env 里的值>（值不打印，里面可能有 token），再 bun src/manager.ts restart 让会话重读`,
  }];
}
