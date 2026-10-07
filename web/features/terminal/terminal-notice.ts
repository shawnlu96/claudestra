/**
 * 终端页标题栏下的提示。ACP agent 的窗口里跑的是宿主（src/acp-host.ts）：底部输入行发消息，回合中 Esc / Ctrl+C 是打断；
 * 空闲时 Ctrl+C 连按两次才停宿主（launcher 约 1 分钟后才拉起，期间 agent 收不到消息）。手机横幅 366px 一行放得下（12px 实测约 347px）。
 * null = 不提示。tests/web-terminal-notice.test.ts
 */
export const ACP_HOST_NOTICE = "底部可输入；Esc/Ctrl+C 打断回合；空闲时按两次 Ctrl+C 停宿主";

export const terminalNotice = (agent: { transport?: string | null }): string | null => (agent.transport === "acp" ? ACP_HOST_NOTICE : null);
