/**
 * inter-agent 看门狗的来源收窄（恢复键 iaWatchdogScope）。旧过滤（非自发、非 oneShot、发送方在册）之上再问一句：
 * 这条是不是「注册 agent 直接发出的请求」。只有它才值得在接收方 Stop 时催；本机形状的回程、reply 转发、通知催了只是打扰。
 * 判据只看 bridge 自己填的路由字段（from.kind / triggerKind / intent），不看正文、agent 名、文字前缀。
 * 档位按接收方频道在 registry 里的 projectId 现读：off = 旧过滤；observe（缺省）= 旧行为，另记一条「on 本不会挂」；
 * on = 只挂直接请求。接收方没有项目（master）或查不出：旧过滤，留一行诊断。tests/ia-watchdog-scope.test.ts。
 */
import { createHash } from "node:crypto";
import { openLedger } from "./ledger-store.js";
import { recordObserved, recoveryPolicy, type ObservedAction, type RecoveryKey, type RecoveryPolicyPort } from "./recovery-policy.js";
import { normalizeRegistryAgents, REGISTRY_PATH } from "./registry.js";
import { readJsonStateSync } from "./state-file.js";

const IA_WATCHDOG_KEY: RecoveryKey = "iaWatchdogScope";

/** 判据要看的路由字段（bridge/router.ts Envelope 的子集；lib 不能反向依赖 bridge） */
export interface IaWatchdogEnvelope {
  from: { kind: string };
  intent: string;
  meta: { messageId: string; triggerKind: string; skipInterAgentWatchdog?: boolean };
}

/** send_to_agent 的那一种形状：本机 agent 亲手发、等着回应。回程 / reply 转发是 response 或 notification，合成的不是 agent_tool。 */
export function isDirectAgentRequest(env: IaWatchdogEnvelope): boolean {
  return env.from.kind === "local" && env.meta.triggerKind === "agent_tool" && env.intent === "request";
}

export interface IaWatchdogPort {
  /** 接收方频道 → registry 的 projectId；没有项目返回 undefined，读不了就抛 */
  projectOf: (channelId: string) => string | undefined;
  policy: RecoveryPolicyPort;
  /** observe 档记一条观察；抛错只是少一条观察，不影响挂不挂 */
  observe: (a: ObservedAction) => void;
  log: (line: string) => void;
}

/**
 * 接收方频道 → 项目，按 registry 文件此刻的内容。不走 readRegistryAgentsSync：它在文件损坏时沿用上次成功值，
 * 这里要的是「现在读不了」这件事本身——读不了就抛，由 scopeIaWatchdog 退回旧过滤，不拿旧快照里的项目去收窄。
 */
export function registryProjectOf(channelId: string, registryPath = REGISTRY_PATH): string | undefined {
  const r = readJsonStateSync(registryPath);
  if (r.status === "corrupt") throw new Error(`registry 损坏：${r.error}`);
  if (r.status === "missing") return undefined;
  // 同一频道对上两个项目就是查不出：不替它挑一个
  const ids = new Set(normalizeRegistryAgents(r.data).filter((a) => a.channelId === channelId).map((a) => a.projectId ?? ""));
  const [only] = ids;
  return ids.size === 1 && only ? only : undefined;
}

const PRODUCTION: IaWatchdogPort = {
  projectOf: (channelId) => registryProjectOf(channelId),
  policy: recoveryPolicy,
  observe: (a) => { recordObserved(openLedger(), a, Date.now()); },
  log: (line) => console.log(line),
};
let port = PRODUCTION;
/** 仅测试：换掉读 registry / 恢复键 / 台账的端口（不传 = 换回生产的） */
export function useIaWatchdogPort(p?: IaWatchdogPort): void { port = p ?? PRODUCTION; seen.clear(); diagnosed.clear(); }

const REMEMBER = 2000;
/** 进程内已记过观察的 project + messageId：押后重投同一条不必再碰台账（台账自己的 dedupKey 兜跨进程） */
const seen = new Set<string>();
/** 已打过的诊断（频道 + 原因）：master 每条通知都会走到这里，一种原因一行就够 */
const diagnosed = new Set<string>();
function once(set: Set<string>, key: string): boolean {
  if (set.has(key)) return false;
  if (set.size >= REMEMBER) set.delete(set.values().next().value as string);
  set.add(key);
  return true;
}
const diagnose = (channelId: string, why: string): void => {
  if (once(diagnosed, `${channelId}\n${why}`)) port.log(`[ia-watchdog-scope] ${channelId} 按旧过滤挂看门狗：${why}`);
};

const KEY_SAFE = /^[\w.:@/-]{1,100}$/;
/** recordObserved 的 actionKey 只收 [\w.:@/-]；别的形状的 messageId 取摘要，仍是一条消息一个键 */
const actionKeyOf = (messageId: string): string =>
  `ia:${KEY_SAFE.test(messageId) ? messageId : createHash("sha256").update(messageId).digest("hex").slice(0, 32)}`;

/**
 * legacy = 旧过滤的结论。返回这条消息最终挂不挂看门狗。
 * 旧过滤不挂、或它本来就是直接请求：三档结论相同，不读 registry / 恢复键。只有「旧会挂、on 不会挂」的那一类才现读档位。
 */
export function scopeIaWatchdog(legacy: boolean, env: IaWatchdogEnvelope, receiverChannelId: string): boolean {
  if (!legacy || isDirectAgentRequest(env)) return legacy;
  let project: string | undefined;
  try {
    project = port.projectOf(receiverChannelId);
  } catch (e) {
    diagnose(receiverChannelId, `读不了接收方的项目（${(e as Error).message}）`);
    return true;
  }
  if (!project) {
    diagnose(receiverChannelId, "接收方在 registry 里没有项目（master 或未注册）");
    return true;
  }
  const policy = port.policy(project, IA_WATCHDOG_KEY);
  if (policy.diagnostic) diagnose(receiverChannelId, policy.diagnostic);
  if (policy.mode === "on") return false;
  if (policy.mode === "observe" && once(seen, `${project}\n${env.meta.messageId}`)) {
    const shape = { fromKind: env.from.kind, intent: env.intent, triggerKind: env.meta.triggerKind, skipInterAgentWatchdog: env.meta.skipInterAgentWatchdog === true };
    try {
      port.observe({ project, mechanism: IA_WATCHDOG_KEY, target: "", actionKey: actionKeyOf(env.meta.messageId),
        action: `不给 ${receiverChannelId} 挂 inter-agent 看门狗（from.kind=${shape.fromKind} intent=${shape.intent} triggerKind=${shape.triggerKind}）`,
        data: { ...shape, messageId: env.meta.messageId, receiverChannelId } });
    } catch (e) {
      seen.delete(`${project}\n${env.meta.messageId}`); // 没记上：这条重投时再试
      port.log(`[ia-watchdog-scope] 记 ${env.meta.messageId} 的观察失败（看门狗照旧挂）：${(e as Error).message}`);
    }
  }
  return true;
}
