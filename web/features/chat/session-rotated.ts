/**
 * bridge 的 session_rotated：registry 换到了新会话（/clear 端点的轮转、原生 /clear 的 Stop 自愈都发这一种）。
 * 顺序有讲究：ctx 先置空（旧会话的 729k 不能留在顶栏）→ 重拉历史（bridge 的 watcher 从新文件末尾起读，新会话
 * 首回合没直播过，只能从历史拿；旧会话进了归档，向上翻还接得上）→ 历史落地后再插提示（先插会被全量重载的整体
 * 替换吞掉）→ 拉 agent 列表拿新会话的 ctx（还没 usage 就是空）。tests/web-session-rotated.test.ts
 */
import type { ChatMessage } from "./type";

interface RotationState {
  activeAgent: string;
  agents: { name: string; contextTokens?: number | null }[];
  messages: ChatMessage[];
}

export interface RotationHost {
  state: () => RotationState;
  produce: (fn: (s: RotationState) => void) => void;
  /** 全量重拉当前 agent 的历史（loadMessages latest；失败自己兜，不抛） */
  reload: () => Promise<void>;
  refreshAgents: () => Promise<void>;
  nextId: () => string;
  lang: () => string;
}

export function rotationNotice(to: string, lang: string): string {
  return lang === "zh" ? `🧹 已清空上下文，新会话 ${to.slice(0, 8)}` : `🧹 Context cleared — new session ${to.slice(0, 8)}`;
}

export async function settleRotation(host: RotationHost, to: string): Promise<void> {
  const agent = host.state().activeAgent;
  host.produce((s) => {
    const a = s.agents.find((x) => x.name === agent);
    if (a) a.contextTokens = null;
  });
  await host.reload();
  if (host.state().activeAgent === agent) {
    host.produce((s) => void s.messages.push({ id: host.nextId(), role: "system", content: rotationNotice(to, host.lang()), ts: new Date().toISOString() }));
  }
  await host.refreshAgents();
}
