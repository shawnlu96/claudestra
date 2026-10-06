/**
 * 终端页标题栏下的提示。ACP agent 的窗口里跑的是宿主（src/acp-host.ts），只显示会话、不收输入：在这按 Ctrl+C 会把宿主停掉，
 * launcher 约 1 分钟后才拉起，期间 agent 收不到消息。null = 不提示。tests/web-terminal-notice.test.ts
 */
export const ACP_HOST_NOTICE = "这里是 ACP 会话的只读视图；Ctrl+C 会停掉宿主";

export const terminalNotice = (agent: { transport?: string | null }): string | null => (agent.transport === "acp" ? ACP_HOST_NOTICE : null);
