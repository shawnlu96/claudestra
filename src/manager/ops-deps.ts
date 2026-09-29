/**
 * create / kill / rename / repair 共用的副作用接口。步骤函数只经它碰 tmux / bridge / registry，
 * 单测换成内存假件后能在任一步之后「砍掉」再重跑（tests/resumable-ops.test.ts）。
 */
import { listWindowIdsByName, tmuxRaw, windowHasChildProcess, windowTarget } from "../lib/tmux-helper.js";
import { agentWindowsOrNull } from "../lib/agent-windows.js";
import { bridgeRequest } from "../lib/bridge-client.js";
import { archiveSession } from "../lib/session-archive.js";
import { isForbiddenChannelError, isLocalChannel, isUnknownChannelError, pidAlive } from "../lib/pending-ops.js";
import { isRestartInProgress } from "./restart-lock.js";
import { loadRegistry, saveRegistry, type Registry } from "./core.js";

/** forbidden = Discord 拒绝（没权限 / 看不到），重试没用 */
type ChannelResult = "ok" | "gone" | { error: string; forbidden?: boolean };

/** 删频道失败的人话：分清「bridge 不在，稍后重试」和「Discord 不让删，要人去处理」，两种都能 --force 放弃这一步 */
export function channelFailureText(channelId: string, r: { error: string; forbidden?: boolean }): string {
  return r.forbidden
    ? `Discord 拒绝删除频道 ${channelId}（bot 没权限或看不到它：${r.error}）——去 Discord 手动删，或加 --force 放弃这一步`
    : `删频道 ${channelId} 失败（${r.error}）——bridge 恢复后再跑，或加 --force 放弃这一步`;
}

export interface OpsDeps {
  loadRegistry(): Promise<Registry>;
  saveRegistry(reg: Registry): Promise<void>;
  /** 列不出来时抛错：调用方据此中止，不能把「不知道」当成「窗口不在」去删频道 */
  listWindows(): Promise<string[]>;
  /** 同名窗口的 tmux id（`@N`），同样列不出来就抛 */
  windowIds(name: string): Promise<string[]>;
  killWindow(name: string): Promise<void>;
  killWindowId(id: string): Promise<void>;
  renameWindow(from: string, to: string): Promise<void>;
  /** 该 agent 正有 restart 在跑（窗口暂时不在是 restart 在重建，不是被 kill 到一半） */
  restartInProgress(name: string): boolean;
  /** 窗口（名字或 `@id`）只剩裸 shell（确无子进程）；探测失败按「有进程」算，宁可不关 */
  windowIsBareShell(target: string): Promise<boolean>;
  deleteChannel(channelId: string): Promise<ChannelResult>;
  renameChannel(channelId: string, name: string): Promise<ChannelResult>;
  /** bridge 上还存在的频道 id；null = bridge 不在 */
  listChannels(): Promise<Set<string> | null>;
  agentCleanup(channelId: string, agent: string): Promise<boolean>;
  archive(agent: string, cwd: string | undefined, sessionId: string): Promise<void>;
  rescan(action: "add" | "remove" | "full", agent?: string, cwd?: string): Promise<void>;
  renameLedger(from: string, to: string): Promise<void>;
  now(): number;
  alive(pid: number): boolean;
}

async function channelOp(msg: Record<string, unknown>): Promise<ChannelResult> {
  if (isLocalChannel(String(msg.channelId || ""))) return "ok"; // Web-only 合成地址没有平台面
  try {
    await bridgeRequest(msg);
    return "ok";
  } catch (e) {
    const m = (e as Error).message;
    return isUnknownChannelError(m) ? "gone" : { error: m, ...(isForbiddenChannelError(m) ? { forbidden: true } : {}) };
  }
}

/** 通知 bridge 刷 skill registry；bridge 没跑就算了（下次启动全量扫描） */
export async function triggerSkillsRescan(action: "add" | "remove" | "full", agent?: string, cwd?: string): Promise<void> {
  const { bridgeHttpBase } = await import("../lib/bridge-port.js");
  try {
    await fetch(`${bridgeHttpBase()}/skills/rescan`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action, agent, cwd }),
      signal: AbortSignal.timeout(3000),
    });
  } catch { /* bridge 可能未运行，启动时会全量扫描 */ }
}

/** 让 bridge 丢掉该频道的 inter-agent / cross-peer pending 与事件缓冲（forgetAgent）；返回 bridge 是否应答 */
async function notifyAgentCleanup(channelId: string, agent: string): Promise<boolean> {
  const { bridgeHttpBase } = await import("../lib/bridge-port.js");
  try {
    const r = await fetch(`${bridgeHttpBase()}/agent/cleanup`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ channelId, agent }),
      signal: AbortSignal.timeout(3000),
    });
    return r.ok;
  } catch {
    return false; // bridge 未运行：它重启时本来就没有这些内存态
  }
}

async function knownWindows() {
  const w = await agentWindowsOrNull();
  if (!w) throw new Error("列不出 tmux 窗口（tmux 出错），为免误删先停手；tmux 正常后再跑");
  return w;
}

export const realOpsDeps: OpsDeps = {
  loadRegistry,
  saveRegistry,
  listWindows: async () => (await knownWindows()).map((w) => w.name),
  windowIds: async (name) => (await knownWindows()).filter((w) => w.name === name).map((w) => w.id),
  async killWindow(name) {
    // by id：同名多份时 `master:name` 会 ambiguous，错误被吞就杀错 / 漏杀
    for (const id of await listWindowIdsByName(name)) await tmuxRaw(["kill-window", "-t", id]);
  },
  async killWindowId(id) {
    await tmuxRaw(["kill-window", "-t", id]);
  },
  async renameWindow(from, to) {
    const [id] = await listWindowIdsByName(from);
    if (id) await tmuxRaw(["rename-window", "-t", id, to]);
  },
  restartInProgress: isRestartInProgress,
  windowIsBareShell: async (target) => (await windowHasChildProcess(target.startsWith("@") ? target : windowTarget(target)).catch(() => null)) === false,
  deleteChannel: (channelId) => channelOp({ type: "delete_channel", channelId }),
  renameChannel: (channelId, name) => channelOp({ type: "rename_channel", channelId, name }),
  async listChannels() {
    try {
      const r = await bridgeRequest({ type: "list_channels" });
      return new Set(((r?.channels ?? []) as Array<{ id: string }>).map((c) => c.id));
    } catch {
      return null; // bridge 不在：孤儿频道这一项跳过，调用方会说明
    }
  },
  agentCleanup: notifyAgentCleanup,
  async archive(agent, cwd, sessionId) {
    await archiveSession(agent, cwd, sessionId).catch((e) => console.error(`[archive] ${agent} 归档失败（继续）: ${(e as Error).message}`));
  },
  rescan: triggerSkillsRescan,
  async renameLedger(from, to) {
    await (await import("./ledger.js")).renameLedgerAgent(from, to);
  },
  now: () => Date.now(),
  alive: pidAlive,
};
