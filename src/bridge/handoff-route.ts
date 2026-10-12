/**
 * ws 请求 `save_handoff` 的入口（codex-compact N3，docs/runtimes/codex-save-compact-plan.md §2.2 / §3 N3）。
 * 身份只认连接：`callerOf(ws, msg)`（bridge/caller-identity.ts，由 bridge.ts 传进来，单测注入桩）必须 verified、且这帧没被
 * 回环代理标 callerDowngraded；写的永远是这条连接自己那个 agent 的交接（lib/agent-handoff.ts）。
 * 帧里自带的 agent / name / path 之类一概不当数：与连接不符或带路径直接拒并记日志，不会借它拿到别人的写权。
 * handleSaveHandoff 返回 bridgeRequest 认的形状 { result } | { error }，answerSaveHandoff 按原 requestId 回包，错误不吞。tests/compact-tool-proxy.test.ts。
 */
import type { CallerIdentity } from "../lib/caller-identity.js";
import { IDENTITY_UNVERIFIED } from "../lib/caller-identity.js";
import { saveAgentHandoff } from "../lib/agent-handoff.js";
import { readRegistryAgentsSync } from "../lib/registry.js";

export type CallerOf = (ws: object, frame?: Record<string, unknown>) => { identity: CallerIdentity; channelId: string | undefined };

export interface HandoffRouteDeps {
  /** registry 名单；缺省读 registry.json */
  registered?: () => readonly string[];
  /** 缺省 STATE_DIR */
  stateDir?: string;
}

/** 调用方可能伪造的身份 / 落点字段：工具从不发这些 */
const NAME_KEYS = ["agent", "agentName", "name", "fromName"] as const;
const PATH_KEYS = ["path", "file", "dir", "cwd"] as const;

function forgedField(msg: Record<string, unknown>, agent: string): string | null {
  for (const k of PATH_KEYS) if (msg[k] !== undefined) return `帧里带了 ${k}，交接落点只由 bridge 决定`;
  for (const k of NAME_KEYS) if (msg[k] !== undefined && msg[k] !== agent) return `帧里的 ${k}=${JSON.stringify(String(msg[k]).slice(0, 60))} 和连接认出的 ${agent} 不符`;
  return null;
}

async function handleSaveHandoff(msg: Record<string, unknown>, ws: object, callerOf: CallerOf, deps: HandoffRouteDeps = {}): Promise<{ result?: unknown; error?: string }> {
  const { identity, channelId } = callerOf(ws, msg);
  const where = channelId ?? "未注册连接";
  if (!identity.verified || msg.callerDowngraded === true || !identity.agent) {
    console.warn(`🗂 [handoff] 拒绝 save_handoff（${where}）：调用方身份未验证或被降级`);
    return { error: `${IDENTITY_UNVERIFIED}：只有 agent 自己的 MCP 连接能存交接` };
  }
  const forged = forgedField(msg, identity.agent);
  if (forged) {
    console.warn(`🗂 [handoff] 拒绝 ${identity.agent} 的 save_handoff：${forged}`);
    return { error: forged };
  }
  try {
    const registered = deps.registered?.() ?? readRegistryAgentsSync().map((a) => a.name);
    const saved = await saveAgentHandoff({ agent: identity.agent, registered, opId: msg.opId, text: msg.text, stateDir: deps.stateDir });
    console.log(`🗂 [handoff] ${identity.agent} 存了交接（op ${saved.opId}，${saved.bytes} 字节）`);
    return { result: saved };
  } catch (e) {
    console.warn(`🗂 [handoff] ${identity.agent} 的交接没存：${(e as Error).message}`);
    return { error: (e as Error).message };
  }
}

/** bridge.ts 的 case "save_handoff"：原 requestId 回 response，result / error 二选一 */
export async function answerSaveHandoff(ws: { send(data: string): unknown }, msg: Record<string, unknown>, callerOf: CallerOf, deps?: HandoffRouteDeps): Promise<void> {
  const reply = { type: "response", requestId: msg.requestId, ...(await handleSaveHandoff(msg, ws, callerOf, deps)) };
  try {
    ws.send(JSON.stringify(reply));
  } catch (e) {
    console.warn(`🗂 [handoff] 回包失败（连接已断？）${(e as Error).message}`);
  }
}
