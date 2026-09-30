/**
 * clear 后的会话轮转收尾（后台异步）。三个入口共用：Web clear 端点、Web 斜杠直通、Discord slash。
 *
 * TUI 里 /clear 会轮转 sessionId，但新会话文件往往等**首条消息**才落盘，所以入口先返回，
 * 这里每 1.5s poll 一次，最多 2 分钟（超时 = 该版本 /clear 不轮转，watcher 维持原样）。
 * 同 cwd 可能有多个 agent 共用会话目录：只认领 clear 前快照里没有、且非 oldSid 的**新** sid，
 * 再叠 ownedByOther（新 sid 恰是别的 agent 的官方 session 则跳过）。命中后 manager set-session
 * （归档 + registry 切换，manager 仍是唯一写者），再重绑 jsonl-watcher，否则它盯死旧文件。
 *
 * 运行时在这里按频道推导，入口不传：漏了就去 CC 的目录找，Pi 的新会话永远找不到，
 * 120s 后静默超时（tests/clear-rotation.test.ts）。
 */
import { runtimeOfWindow } from "../lib/codex-key-guard.js";
import { listSessionIdsForCwd } from "./session-ids.js";

type ManagerResult = { ok?: boolean; error?: string; agents?: { name: string; sessionId?: string }[] };

export interface ClearRotationDeps {
  /** 已注册连接自报的运行时（Pi 扩展 / Codex channel-server 会报，CC 不报） */
  clientRuntime: (channelId: string) => string | undefined;
  runManager: (...args: string[]) => Promise<ManagerResult>;
  /** 停掉该频道的 watcher 并按新 sid 重挂 */
  rewatch: (agentName: string, cwd: string, sid: string, channelId: string, runtime: string | undefined) => void;
  listSessionIds?: (cwd: string, runtime?: string) => string[];
}

const DEADLINE_MS = 120_000;
const FIRST_TICK_MS = 1200;
const TICK_MS = 1500;

export function createClearRotation(deps: ClearRotationDeps) {
  const list = deps.listSessionIds ?? listSessionIdsForCwd;
  return function scheduleClearRotation(agentName: string, channelId: string, cwd: string, oldSid?: string): void {
    // 连接断着（扩展重连中）时退回 registry，两边都没有 = 老 agent = CC
    const runtime = deps.clientRuntime(channelId) ?? runtimeOfWindow(agentName);
    const deadline = Date.now() + DEADLINE_MS;
    const beforeSids = new Set(list(cwd, runtime)); // clear 前的会话快照
    const tick = async () => {
      try {
        // 列表 mtime 降序，第一个快照外的新 sid 就是最新出现的新会话
        const sid = list(cwd, runtime).find((s) => !beforeSids.has(s) && s !== oldSid);
        if (sid) {
          const listResult = await deps.runManager("list");
          const ownedByOther = (listResult.agents || []).some((a) => a.name !== agentName && a.sessionId === sid);
          if (!ownedByOther) {
            const r = await deps.runManager("set-session", agentName, sid);
            if (r?.ok) {
              deps.rewatch(agentName, cwd, sid, channelId, runtime);
              console.log(`🧹 clear 轮转完成 agent=${agentName} ${oldSid?.slice(0, 8) ?? "?"}->${sid.slice(0, 8)}`);
            } else {
              console.error(`🧹 clear 轮转 set-session 失败 agent=${agentName}:`, r?.error);
            }
            return;
          }
        }
      } catch (e) {
        console.warn(`🧹 clear 轮转本轮出错 agent=${agentName}，下一轮重试:`, e);
      }
      if (Date.now() < deadline) setTimeout(tick, TICK_MS);
      else console.warn(`🧹 clear 轮转超时 agent=${agentName}（runtime=${runtime ?? "claude-code"} 未见新会话文件，watcher 维持原 session）`);
    };
    setTimeout(tick, FIRST_TICK_MS);
  };
}
