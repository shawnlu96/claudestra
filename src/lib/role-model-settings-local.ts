/**
 * 本机建卡读模型档位表的端口（TIER1）：card-role-definitions.ts applyCardRole 调。生效与否只看 RecoveryPolicyPort 的 roleModel 键：
 * - off：什么都不做，照角色定义文件的模型起，不记。
 * - observe（缺省）：启动参数一字不变，只在卡上记一条「本会用」（recordObserved，同卡同角色同值只一条）。
 * - on：没显式指定时用表值——Claude 加 --model <表里的模型>，Codex 加 --effort <表里的档>（表里是 null 就不加，照 Codex 自己的配置）。
 * 优先级：调用方显式给的 --model / --effort > on 下的表值 > 角色定义文件的模型；显式给了就不记 would-use（on 也不会动它）。
 * 表读不了 / 内容坏 = on 下也不换、照定义起并给诊断，不猜值。Codex 永远不带 --model（不把 Claude 模型名传给 Codex）。
 * tests/role-model-settings-local.test.ts。
 */
import { openLedger } from "./ledger-store.js";
import { decideRecovery, recordObserved, recoveryPolicy, type ObservedAction, type RecoveryPolicyPort } from "./recovery-policy.js";
import { readRoleModels, roleModelOf, type CardRole, type RoleModelFamily, type RoleModelRead } from "./role-model-settings.js";

export interface RoleModelPort {
  policy: RecoveryPolicyPort;
  read: () => RoleModelRead;
  /** observe 下记一条 would-use；记不上不挡建卡（只是少一条观察） */
  observe: (a: ObservedAction) => void;
}

const PRODUCTION: RoleModelPort = {
  policy: recoveryPolicy,
  read: () => readRoleModels(),
  observe: (a) => {
    try { recordObserved(openLedger(), a, Date.now()); } catch (e) { console.error(`[role-model] 记 ${a.target} 的 would-use 失败（建卡照旧）：${(e as Error).message}`); }
  },
};
let port = PRODUCTION;
/** Tests only: swap the production port (undefined = back to the file / ledger backed one). */
export function useRoleModelPort(p?: RoleModelPort): void { port = p ?? PRODUCTION; }
/** 出借协议那一半（role-model-settings-lend.ts）读同一个开关和同一张表；would-use 它在自己的事务里记，不用这里的 observe */
export const roleModelPort = (): RoleModelPort => port;

export interface RoleModelAsk {
  role: CardRole;
  family: RoleModelFamily;
  /** create 的 --project / --card；没有卡号就无处可记，observe 不记 */
  project?: string;
  card?: string;
  /** 调用方已显式带了这一家族要的参数（Claude 的 --model / Codex 的 --effort） */
  explicit: boolean;
}

/** inject = 要追加的值（只有 on 才可能非 null）；observed = 这次记没记 would-use；diagnostic = 表坏 / 读不了时的原因 */
export interface RoleModelPick { inject: string | null; mode: "on" | "observe" | "off"; observed: boolean; diagnostic?: string }

export function pickRoleModel(ask: RoleModelAsk, p: RoleModelPort = port): RoleModelPick {
  if (ask.explicit) return { inject: null, mode: "off", observed: false };
  const policy = ask.project ? p.policy(ask.project, "roleModel") : { mode: "observe" as const, manualAfterMs: null, source: "default" as const };
  const d = decideRecovery(policy);
  if (d.kind === "skip") return { inject: null, mode: "off", observed: false, ...(policy.diagnostic ? { diagnostic: policy.diagnostic } : {}) };
  const read = p.read();
  const cell = roleModelOf(read, ask.role, ask.family);
  const diagnostic = read.status === "invalid" || read.status === "unreadable" ? `模型档位表${read.status === "invalid" ? "内容不合法" : "读不了"}，照角色定义起：${read.error}` : undefined;
  if (d.kind === "act") return { inject: diagnostic ? null : cell.value, mode: "on", observed: false, ...(diagnostic ? { diagnostic } : {}) };
  if (!ask.card || !ask.project) return { inject: null, mode: "observe", observed: false, ...(diagnostic ? { diagnostic } : {}) };
  const value = cell.value ?? "codex-config";
  p.observe({ project: ask.project, mechanism: "roleModel", target: ask.card, actionKey: `role-model:${ask.role}:${ask.family}:${value}`,
    action: `按模型档位表给 ${ask.role}（${ask.family}）用 ${cell.value ?? "Codex 自己的配置"}（来源 ${cell.source}）`,
    data: { role: ask.role, family: ask.family, wouldUse: cell.value, source: cell.source, ...(diagnostic ? { diagnostic } : {}) } });
  return { inject: null, mode: "observe", observed: true, ...(diagnostic ? { diagnostic } : {}) };
}
