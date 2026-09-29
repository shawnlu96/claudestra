/**
 * bridge 这边哪些频道当前由 ACP 宿主登记（register 帧带 transport:"acp"，src/acp-host.ts）。和 registry 的 transport 字段
 * 同义，但这里是「此刻连着的那一端」：watcher 要不要尾读 rollout、打断走不走 abort 帧、Codex 的打字投递限制要不要套，
 * 都看这个——registry 切了 transport 而宿主还没重启时，以真实连着的那一端为准。纯状态，bridge 各模块都能引。
 */
const acpChannels = new Set<string>();

/** register 时记：transport 不是 acp 就清掉（同一频道从 acp 切回 tmux，channel-server 重新登记） */
export function noteAcpChannel(channelId: string, transport: unknown): void {
  if (transport === "acp") acpChannels.add(channelId);
  else acpChannels.delete(channelId);
}

export const isAcpChannel = (channelId: string): boolean => acpChannels.has(channelId);
