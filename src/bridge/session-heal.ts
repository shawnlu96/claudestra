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
 *
 * 上面这套 mtime 是老 hook（不带 session_id）的兜底：/clear 后第一回合很短时旧文件刚被 clear 写过，
 * 快路径判它「还活着」就不认领（CLR1）。新 hook 报上来的 sid 才是确定性依据，见函数里第一段。
 */
import { statSync } from "fs";
import { resolveSessionIdsForWindows } from "../lib/cc-sessions.js";
import { recordMetric } from "../lib/metrics.js";
import { readRegistryAgents, type RegistryAgent } from "../lib/registry.js";
import { managedFor } from "../lib/runtimes/index.js";
import { isValidSessionId } from "../lib/session-history.js";
import { sessionJsonlPath } from "../lib/session-source.js";
import { claimRotatedSession, type ClearRotationDeps } from "./clear-rotation.js";
import { listSessionIdsForCwd } from "./session-ids.js";

export interface SessionHealDeps extends Pick<ClearRotationDeps, "runManager" | "rewatch"> {
  // 以下只给测试注入；缺省读真 registry / tmux / 会话目录
  readAgents?: () => Promise<RegistryAgent[]>;
  /** 这个 tmux 窗口里顶层 CC 进程当前的 sessionId（CC 自己的 ~/.claude/sessions 登记，嵌套的 claude -p 已剔除） */
  windowSession?: (windowName: string, cwd: string) => Promise<string | null>;
  listSessionIds?: (cwd: string, runtime?: string) => string[];
  /** 文件 mtime（ms），文件不在就抛 */
  mtimeOf?: (path: string) => number;
}

async function ccWindowSession(windowName: string, cwd: string): Promise<string | null> {
  return (await resolveSessionIdsForWindows([{ key: windowName, tmuxName: windowName, cwd }])).get(windowName) ?? null;
}

const ROTATION_FRESH_MS = 3 * 60_000;
const rotationHealInflight = new Set<string>();

export async function maybeHealRotatedSession(channelId: string, rawHookSid: string | undefined, deps: SessionHealDeps) {
  const readAgents = deps.readAgents ?? readRegistryAgents;
  const listSessionIds = deps.listSessionIds ?? listSessionIdsForCwd;
  const mtimeOf = deps.mtimeOf ?? ((p: string) => statSync(p).mtimeMs);
  const hookSid = rawHookSid && isValidSessionId(rawHookSid) ? rawHookSid : undefined;
  // 带 sid 与不带 sid 的分开去重：新旧两版 hook 同时挂着（沙箱里全局 hook 是主树那份）会并发打到，
  // 共用一把锁时带 sid 的那次可能被 mtime 那次挡掉，确定性依据就丢了
  const inflightKey = hookSid ? `${channelId}:sid` : channelId;
  if (rotationHealInflight.has(inflightKey)) return;
  rotationHealInflight.add(inflightKey);
  try {
    const agents = await readAgents();
    const me = agents.find((a) => a.channelId === channelId && a.status === "active");
    if (!me?.cwd || !me.sessionId) return;
    const cwd = me.cwd.replace(/^~/, process.env.HOME || "~");
    const at = { name: me.name, cwd, channelId, runtime: me.runtime };
    // 确定性判定：Stop hook 带着本回合所在的 session_id（CC hook 契约）。等于 registry = 没轮转，不再按 mtime 猜；
    // 不等 = 窗口里换了会话（/clear 从哪进来都一样）。但 agent 在 Bash 里跑的 claude -p 等子进程继承同一个
    // DISCORD_CHANNEL_ID，它们的 Stop 也带着自己的 sid 打进来——只信 hook 会把 registry 劫持到子会话上，所以再按
    // tmux 窗口问 CC 自己的登记确认一次；确认不了（非 CC / 登记还没更新 / tmux 不可达）落回下面的老判定
    // （tests/session-heal.test.ts）。
    if (hookSid && hookSid === me.sessionId) return;
    if (hookSid && (me.runtime ?? "claude-code") === "claude-code" && !agents.some((a) => a.name !== me.name && a.sessionId === hookSid)) {
      const live = await (deps.windowSession ?? ccWindowSession)(me.name, cwd).catch(() => null); // 查不到 = 确认不了，落回下面的老判定
      if (live === hookSid) {
        const r = await claimRotatedSession(deps, at, me.sessionId, hookSid);
        if (r.ok) {
          recordMetric("session_selfheal", { channelId, agent: me.name, meta: { from: me.sessionId, to: hookSid, reason: "stop_hook_sid" } });
          console.log(`🩹 session 轮转自愈(Stop hook) agent=${me.name} ${me.sessionId.slice(0, 8)}->${hookSid.slice(0, 8)}`);
        } else {
          console.error(`🩹 session 轮转自愈(Stop hook) set-session 失败 agent=${me.name}:`, r.error);
        }
        return;
      }
    }
    // v2.23.2+ fork 源 id 共用:registry 记的 session 同时是另一个活 agent 的(resume --fork
    // 探测失败时暂记的源 id)。源文件一直"新鲜"(是别人在写),下面的快路径永远放行,两个频道
    // 渲染同一份 transcript(master 2026-09-18 实报)。改按 Claude Code 自己的登记
    // (~/.claude/sessions/<pid>.json,带 tmux pane id)找这个窗口的真身,不看文件新鲜度。
    const sharedWith = agents.find((a) => a.name !== me.name && a.status === "active" && a.sessionId === me.sessionId);
    const discover = managedFor(me.runtime)?.discoverSessionId;
    if (sharedWith && discover) {
      const viaCc = await discover({ windowName: me.name, cwd, exclude: me.sessionId, timeoutMs: 1_500 }).catch(() => null);
      if (viaCc && !agents.some((a) => a.name !== me.name && a.sessionId === viaCc.sessionId)) {
        const r = await claimRotatedSession(deps, at, me.sessionId, viaCc.sessionId);
        if (r.ok) {
          recordMetric("session_selfheal", { channelId, agent: me.name, meta: { from: me.sessionId, to: viaCc.sessionId, reason: "shared_fork_source" } });
          console.log(`🩹 session 自愈(fork 源 id 共用) agent=${me.name} ${me.sessionId.slice(0, 8)}->${viaCc.sessionId.slice(0, 8)}（与 ${sharedWith.name} 共用源 id，按 CC sessions 登记纠正）`);
        } else {
          console.error(`🩹 session 自愈(fork 源 id 共用) set-session 失败 agent=${me.name}:`, r.error);
        }
      }
      return;
    }
    // 快路径（绝大多数回合）：registry session 本回合有写入 → 一切正常
    const mePath = sessionJsonlPath(me.runtime, cwd, me.sessionId);
    try {
      if (mePath && Date.now() - mtimeOf(mePath) < ROTATION_FRESH_MS) return;
    } catch { /* registry session 文件已消失 → 继续找真身 */ }
    const newest = listSessionIds(cwd, me.runtime).find((s) => s !== me.sessionId); // mtime 降序
    if (!newest) return;
    const newestPath = sessionJsonlPath(me.runtime, cwd, newest);
    let newestMtime = 0;
    try {
      if (!newestPath) return;
      newestMtime = mtimeOf(newestPath);
    } catch { return; }
    if (Date.now() - newestMtime > ROTATION_FRESH_MS) return; // 没有本回合在写的新文件
    if (agents.some((a) => a.name !== me.name && a.sessionId === newest)) return; // ownedByOther
    const r = await claimRotatedSession(deps, at, me.sessionId, newest);
    if (r.ok) {
      recordMetric("session_selfheal", { channelId, agent: me.name, meta: { from: me.sessionId, to: newest } });
      console.log(`🩹 session 轮转自愈 agent=${me.name} ${me.sessionId.slice(0, 8)}->${newest.slice(0, 8)}（原生 /clear 类轮转，registry 未跟上）`);
    } else {
      console.error(`🩹 session 轮转自愈 set-session 失败 agent=${me.name}:`, r.error);
    }
  } catch { /* 自愈失败不影响 Stop 主流程 */ } finally {
    rotationHealInflight.delete(inflightKey);
  }
}
