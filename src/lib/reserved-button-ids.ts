/**
 * bridge 保留的按钮 id 表（纯数据，没有 import）：规则与用途见 lib/reserved-buttons.ts。
 * 与 web/lib/chat/reserved-button-ids.ts 是 twin（scripts/guard/config.ts TWINS）：网页据此认出 bridge 自己的管理 / 面板按钮，
 * 两份去注释后必须逐行一致——新增保留 id 两边一起改，否则 guard 失败。
 */
/** 整个 id 相等才算 */
const EXACT = new Set([
  "list_agents", "show_sessions_panel", "refresh_status", "show_kill_menu", "show_peek_menu", "restart_all", "show_cron_menu",
  "cron_history", "browse_sessions", "kill_agent", "cron_toggle", "cron_remove", "peek_agent", "stats_refresh", "stats_savecompact",
]);

/** 前缀（后面是参数） */
const PREFIXES = [
  "team_ok:", "team_no:", "swmodel_yes:", "swmodel_no:", "sess_detail:", "sess_cleanup:", "sess_adopt:", "savecompact:", "modal:",
  "escalate:", "wedge_esc:", "wedge_restart:", "focus:", "screenshot:", "interrupt:", "auq:",
  "perm_allow:", "perm_allow_session:", "perm_deny:", "session_summary:", "session_full:", "session_noask:",
  "auto_allow:", "auto_revert:", "acp_perm_", "acp_quota_",
];

export function isReservedButtonId(id: string): boolean {
  return EXACT.has(id) || PREFIXES.some((p) => id.startsWith(p));
}

/** 单测用：表里登记了哪些 */
export const RESERVED_BUTTONS = { exact: [...EXACT], prefixes: [...PREFIXES] } as const;
