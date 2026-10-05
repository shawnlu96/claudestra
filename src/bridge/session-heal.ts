/**
 * Stop 时的 session 轮转自愈（2026-07-23 用户报：temp 历史停在 7-15）。
 *
 * 原生 /clear 不经 clear 端点也会轮转 session——远程终端里直敲、Discord slash
 * 直通、TUI 里手动打——registry 全程不知情，jsonl-watcher/history 从此盯死文件：
 * 工具流断、历史冻结，而 reply/推送照常（不走 jsonl），故障极隐蔽（temp 断了
 * 整整 7 天才被发现）。回合结束是天然核对点：registry 指向的 jsonl 若整个回合
 * 毫无写入（mtime 陈旧），而同 slug 刚有别的 jsonl 在写 → 真实会话已迁移，按
 * clear 轮转同款流程认领（set-session 归档+registry 切换，watcher 重绑）。
 *
 * 防串台：同 cwd 多 agent 时，候选 sid 是其他 agent 的官方 session 则不认领
 * （scheduleClearRotation 的 ownedByOther 同款）；且候选 mtime 必须落在刚结束
 * 的回合窗口内（<3min），排除认领陈年老文件。
 */
import type { Client } from "discord.js";
import { statSync } from "fs";
import { recordMetric } from "../lib/metrics.js";
import { readRegistryAgents } from "../lib/registry.js";
import { managedFor } from "../lib/runtimes/index.js";
import { sessionJsonlPath } from "../lib/session-source.js";
import { startWatching, stopWatchingByChannel } from "./jsonl-watcher.js";
import { listSessionIdsForCwd } from "./session-ids.js";

export interface SessionHealDeps {
  runManager: (...args: string[]) => Promise<{ ok?: boolean; error?: string }>;
  discord: Client;
}

const ROTATION_FRESH_MS = 3 * 60_000;
const rotationHealInflight = new Set<string>();
export async function maybeHealRotatedSession(channelId: string, { runManager, discord }: SessionHealDeps) {
  if (rotationHealInflight.has(channelId)) return;
  rotationHealInflight.add(channelId);
  try {
    const agents = await readRegistryAgents();
    const me = agents.find((a) => a.channelId === channelId && a.status === "active");
    if (!me?.cwd || !me.sessionId) return;
    const cwd = me.cwd.replace(/^~/, process.env.HOME || "~");
    // v2.23.2+ fork 源 id 共用:registry 记的 session 同时是另一个活 agent 的(resume --fork
    // 探测失败时暂记的源 id)。源文件一直"新鲜"(是别人在写),下面的快路径永远放行,两个频道
    // 渲染同一份 transcript(master 2026-09-18 实报)。改按 Claude Code 自己的登记
    // (~/.claude/sessions/<pid>.json,带 tmux pane id)找这个窗口的真身,不看文件新鲜度。
    const sharedWith = agents.find((a) => a.name !== me.name && a.status === "active" && a.sessionId === me.sessionId);
    const discover = managedFor(me.runtime)?.discoverSessionId;
    if (sharedWith && discover) {
      const viaCc = await discover({ windowName: me.name, cwd, exclude: me.sessionId, timeoutMs: 1_500 }).catch(() => null);
      if (viaCc && !agents.some((a) => a.name !== me.name && a.sessionId === viaCc.sessionId)) {
        const r = await runManager("set-session", me.name, viaCc.sessionId);
        if (r?.ok) {
          stopWatchingByChannel(channelId);
          startWatching(me.name, cwd, viaCc.sessionId, channelId, discord);
          recordMetric("session_selfheal", { channelId, agent: me.name, meta: { from: me.sessionId, to: viaCc.sessionId, reason: "shared_fork_source" } });
          console.log(`🩹 session 自愈(fork 源 id 共用) agent=${me.name} ${me.sessionId.slice(0, 8)}->${viaCc.sessionId.slice(0, 8)}（与 ${sharedWith.name} 共用源 id，按 CC sessions 登记纠正）`);
        } else {
          console.error(`🩹 session 自愈(fork 源 id 共用) set-session 失败 agent=${me.name}:`, r?.error);
        }
      }
      return;
    }
    // 快路径（绝大多数回合）：registry session 本回合有写入 → 一切正常
    const mePath = sessionJsonlPath(me.runtime, cwd, me.sessionId);
    try {
      if (mePath && Date.now() - statSync(mePath).mtimeMs < ROTATION_FRESH_MS) return;
    } catch { /* registry session 文件已消失 → 继续找真身 */ }
    const newest = listSessionIdsForCwd(cwd, me.runtime).find((s) => s !== me.sessionId); // mtime 降序
    if (!newest) return;
    const newestPath = sessionJsonlPath(me.runtime, cwd, newest);
    let newestMtime = 0;
    try {
      if (!newestPath) return;
      newestMtime = statSync(newestPath).mtimeMs;
    } catch { return; }
    if (Date.now() - newestMtime > ROTATION_FRESH_MS) return; // 没有本回合在写的新文件
    if (agents.some((a) => a.name !== me.name && a.sessionId === newest)) return; // ownedByOther
    const r = await runManager("set-session", me.name, newest);
    if (r?.ok) {
      stopWatchingByChannel(channelId);
      startWatching(me.name, cwd, newest, channelId, discord);
      recordMetric("session_selfheal", { channelId, agent: me.name, meta: { from: me.sessionId, to: newest } });
      console.log(`🩹 session 轮转自愈 agent=${me.name} ${me.sessionId.slice(0, 8)}->${newest.slice(0, 8)}（原生 /clear 类轮转，registry 未跟上）`);
    } else {
      console.error(`🩹 session 轮转自愈 set-session 失败 agent=${me.name}:`, r?.error);
    }
  } catch { /* 自愈失败不影响 Stop 主流程 */ } finally {
    rotationHealInflight.delete(channelId);
  }
}
