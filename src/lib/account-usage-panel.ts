/**
 * Claude Code `/status` Usage 面板的纯文本判据（从 bridge/stats-dashboard.ts 原样搬出）：解析、敲入后复核、面板残留。
 * 只服务手动探测（bridge/account-usage-probe.ts）——后台路径一律不抓 TUI，见 lib/account-usage-view.ts。
 * 单测 tests/stats-resets.test.ts、tests/account-usage-probe.test.ts。
 */
import { isRewindDialog } from "./tmux-helper.js";

/** 一次账号用量读数。source/stale/reason 由读取侧标注：网页与看板据此写「未知 / 陈旧 / 来自哪」，不把未知画成 0。 */
export interface AccountUsage {
  sessionPct: number | null;
  sessionResets: string;
  weekPct: number | null;
  weekResets: string;
  totalCost: string | null;
  apiDuration: string | null;
  /** 去掉进度条字符后的 Usage 面板原文；只留在内存里返回，不落盘（禁止持久记录完整 pane） */
  raw: string;
  /** 读数的真实观测时刻；没有读数时为 0 */
  scrapedAt: number;
  source?: "statusline" | "manual" | "none";
  stale?: boolean;
  /** 未知 / 陈旧的原因：missing / corrupt / expired / never */
  reason?: string | null;
}

export function parseUsagePanel(raw: string, nowMs = Date.now()): AccountUsage {
  const lines = raw.split("\n");
  let sessionPct: number | null = null;
  let sessionResets = "";
  let weekPct: number | null = null;
  let weekResets = "";
  for (let i = 0; i < lines.length; i++) {
    const anchor = /Current session/.test(lines[i]) ? "session" : /Current week/.test(lines[i]) ? "week" : null;
    if (!anchor) continue;
    // 搜索窗放宽到 +7:窄窗口下锚行/进度条折行,"% used" 会掉到 +4 之外
    for (let j = i + 1; j < Math.min(i + 7, lines.length); j++) {
      const pm = lines[j].match(/(\d+)%\s*used/);
      const rm = lines[j].match(/Resets\s+(.+?)\s*$/);
      if (anchor === "session") {
        if (pm && sessionPct === null) sessionPct = Number(pm[1]);
        if (rm && !sessionResets) sessionResets = rm[1].trim();
      } else {
        if (pm && weekPct === null) weekPct = Number(pm[1]);
        if (rm && !weekResets) weekResets = rm[1].trim();
      }
    }
  }
  const cost = raw.match(/Total cost:\s*\$([\d.,]+)/);
  const durApi = raw.match(/Total duration \(API\):\s*([^\n]+)/);
  // raw 只留 Usage 面板本身;取「最后一个」tab 行起——万一仍有残留,后者才是当前面板
  let startIdx = lines.findLastIndex((l) => /Settings\s+Status\s+Config\s+Usage/.test(l));
  if (startIdx < 0) startIdx = lines.findIndex((l) => /^\s*Session\s*$/.test(l));
  if (startIdx < 0) startIdx = 0;
  const cleaned = lines
    .slice(startIdx)
    .filter((l) => l.trim() && !/^[\s█▉▊▋▌▍▎▏░▓]+$/.test(l))
    .map((l) => l.replace(/[█▉▊▋▌▍▎▏░▓]+/g, "").replace(/\s+$/, ""))
    .join("\n");
  return {
    sessionPct, sessionResets, weekPct, weekResets,
    totalCost: cost ? cost[1] : null,
    apiDuration: durApi ? durApi[1].trim() : null,
    raw: cleaned.slice(0, 3500),
    scrapedAt: nowMs,
  };
}

/** Usage tab 两条量都在屏（只认可视屏：scrollback 会带出上一次面板的旧文本） */
export function usagePanelVisible(pane: string): boolean {
  return /Current session/.test(pane) && /Current week/.test(pane) && /%\s*used/.test(pane);
}

/**
 * 敲入 /status 之后、按 Enter 之前的反向复核：回合已开（esc to interrupt）或输入行不是纯我方敲入就撤退。
 * 补全菜单在场是敲入的预期结果，不是危险信号（正向 idle 判据会被它自我否决）。
 */
export function typedRecheckOk(pane: string, typed: string): boolean {
  if (/esc to interrupt/i.test(pane)) return false;
  const promptLines = pane.split("\n").filter((l) => l.includes("❯"));
  if (!promptLines.length) return false; // 输入行都找不到,保守撤退
  const last = promptLines[promptLines.length - 1]!;
  const content = last.slice(last.indexOf("❯") + 1).replace(/[▎█]/g, "").trim();
  return content === typed;
}

/**
 * pane 上是否有**开着的** TUI 面板。只认「面板开着」的独有特征：`Settings dialog dismissed` 是收尾回执、
 * transcript 里引用的「Current session … % used」也不算；Rewind 对话框的「Esc to cancel」不是我们开的面板。
 */
export function panelResidue(pane: string): boolean {
  if (isRewindDialog(pane)) return false;
  return /Esc to cancel|Settings\s+Status\s+Config\s+Usage|Settings dialog(?!\s*dismissed)/.test(pane);
}

/** session 窗口 ≤5h：重置时刻按「下一次出现」换算后在 5.2h 之外 = 进程启动时的缓存帧，丢弃 */
export function implausibleSessionReset(sessionResets: string, nowMs: number): boolean {
  const tm = sessionResets.match(/(\d{1,2}):(\d{2})\s*(am|pm)?/i);
  if (!tm) return false;
  let h = Number(tm[1]) % 12;
  if ((tm[3] || "").toLowerCase() === "pm") h += 12;
  const cand = new Date(nowMs);
  cand.setHours(h, Number(tm[2]), 0, 0);
  if (cand.getTime() <= nowMs) cand.setDate(cand.getDate() + 1);
  return cand.getTime() - nowMs > 5.2 * 3600_000;
}
