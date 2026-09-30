/**
 * bridge 侧的 MCP 调用方身份（T85）：register 帧里的凭据只在这里看一眼、换成哈希记在连接上，明文不存不打日志；
 * 每次要身份都重新对照存储（lib/caller-cred.ts），所以 agent 一重启，旧连接当场降为 verified=false。
 * 判定是纯函数（lib/caller-identity.ts），这里只管 IO：凭据存储按 mtime 缓存、registry 同步读。
 * 两个出口：admitCaller（register 时拒掉「无凭据的来顶替有效凭据的」）与 callerIdentity / whoami（给工具用）。
 */
import type { ServerWebSocket } from "bun";
import { statSync } from "node:fs";
import { CALLER_CREDS_PATH, hashCred, readCredStore, type CredRecord } from "../lib/caller-cred.js";
import { rejectsTakeover, resolveCallerIdentity, type CallerIdentity } from "../lib/caller-identity.js";
import { readRegistryAgentsSync } from "../lib/registry.js";
import { connectionOf } from "./fleet/service.js";

/** 连接 → 它注册时出示的凭据的哈希（连接关了自动回收） */
const credHashOf = new WeakMap<object, string>();
let cache: { mtimeMs: number; creds: Record<string, CredRecord> } | null = null;

function currentCreds(): Record<string, CredRecord> {
  let mtimeMs = -1;
  try {
    mtimeMs = statSync(CALLER_CREDS_PATH).mtimeMs;
  } catch {
    return {}; // 还没签过任何凭据（升级后第一次启动前）：所有连接都是 verified=false，正是兼容期该有的样子
  }
  if (cache?.mtimeMs !== mtimeMs) cache = { mtimeMs, creds: readCredStore() };
  return cache.creds;
}

function identityOf(ws: object, channelId: string | undefined, controlChannelId: string | undefined, downgraded = false): CallerIdentity {
  return resolveCallerIdentity(
    { credHash: credHashOf.get(ws), channelId, downgraded },
    { creds: currentCreds(), agents: readRegistryAgentsSync(), controlChannelId },
  );
}

/**
 * register 时调：记下凭据哈希；频道正被一个仍有效的已验证连接持有、而新来的没有有效凭据 → 拒绝并返回 false。
 * 拒绝用 4002（普通关闭）：对方走指数退避重连，不会当成「被顶替」回来抢，也不会退出（channel-server 没有守护者）。
 */
export function admitCaller(ws: ServerWebSocket<unknown>, msg: Record<string, unknown>, holder: ServerWebSocket<unknown> | undefined, controlChannelId?: string): boolean {
  const token = msg.callerCred;
  if (typeof token === "string" && /^[0-9a-f]{64}$/.test(token)) credHashOf.set(ws, hashCred(token));
  else credHashOf.delete(ws);
  if (!holder || holder === ws) return true;
  const channelId = typeof msg.channelId === "string" ? msg.channelId : undefined;
  const incoming = identityOf(ws, channelId, controlChannelId);
  if (!rejectsTakeover(identityOf(holder, channelId, controlChannelId), incoming)) return true;
  const reason = "频道由已验证身份的会话持有，没有有效凭据的注册不能顶替它（多半是 agent 的 Bash 里误起了 channel-server）";
  console.error(`⛔ 拒绝注册 ${channelId}（pid ${String(msg.pid ?? "?")}）：${reason}`);
  try {
    ws.send(JSON.stringify({ type: "rejected", reason }));
    ws.close(4002, "verified holder");
  } catch (e) {
    console.error(`⚠ 拒绝注册时回帧失败（对方已断开？）：${(e as Error).message}`);
  }
  return false;
}

/** 这条连接（及这一帧）的调用方身份：连接没注册或挂着多个频道 → agent=null、verified=false。M2 / M3 的工具从这里取 */
function callerIdentity(ws: object, frame?: Record<string, unknown>): CallerIdentity {
  const { channels, controlChannelId } = connectionOf(ws);
  return identityOf(ws, channels.length === 1 ? channels[0] : undefined, controlChannelId, frame?.callerDowngraded === true);
}

/** 只读探针工具 whoami 的回包 */
export function answerWhoami(ws: ServerWebSocket<unknown>, msg: Record<string, unknown>): void {
  ws.send(JSON.stringify({ type: "response", requestId: msg.requestId, result: callerIdentity(ws, msg) }));
}
