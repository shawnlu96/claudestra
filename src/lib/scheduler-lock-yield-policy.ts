/**
 * RLOCK2 的模式读取：owner 说「先只观察」，所以 lockYield 只认自己的键。通用规则 keys[mechanism] → 项目 mode → observe 会让
 * 升级前已把项目 mode 设成 on 的项目一上线就真删锁、跳过观察期；这里改成 keys.lockYield → （项目 mode 是 off 时 off）→ observe。
 * 要 on 只能显式 `ledger scheduler-recovery <project> on --key lockYield`（权限照旧 PM / master / owner）。文件坏 = off（停手）。
 * MRGSTALE1：同一个 port 也答 mergeStaleYield，走 recoveryPolicy 的通用继承（keys → 项目 mode → observe），不加特殊逻辑。
 */
import {
  readRecoveryFile, recoveryPolicy, RECOVERY_POLICY_PATH, type RecoveryKey, type RecoveryMode, type RecoveryPolicy, type RecoveryPolicyPort,
} from "./recovery-policy.js";
import { LOCK_YIELD_KEY, MERGE_STALE_KEY } from "./scheduler-lock-yield.js";

export function lockYieldPolicyAt(path: string): RecoveryPolicyPort {
  return (project: string, mechanism: RecoveryKey): RecoveryPolicy => {
    if (mechanism === MERGE_STALE_KEY) return recoveryPolicy(project, mechanism, path);
    if (mechanism !== LOCK_YIELD_KEY) return { mode: "off", manualAfterMs: null, source: "error", diagnostic: `lockYieldPolicy 只读 ${LOCK_YIELD_KEY}，收到 ${mechanism}` };
    const r = readRecoveryFile(path);
    if (r.status === "corrupt") return { mode: "off", manualAfterMs: null, source: "error", diagnostic: `${path} 读不了，让锁停手：${r.error}` };
    const cfg = r.status === "ok" && Object.hasOwn(r.data.projects, project) ? r.data.projects[project] : undefined;
    const mode = cfg?.keys?.[LOCK_YIELD_KEY] ?? (cfg?.mode === "off" ? "off" : "observe");
    return { mode, manualAfterMs: null, source: cfg ? "config" : "default" };
  };
}

/** 生产默认：调度 tick 与写侧子命令都用它（测试注入别的 port） */
export const lockYieldPolicy: RecoveryPolicyPort = (project, mechanism) => lockYieldPolicyAt(RECOVERY_POLICY_PATH)(project, mechanism);

/** 当次 mergeStaleYield 模式；策略读坏 = off（照旧按合并在途豁免，与改前一致） */
export function mergeStaleMode(policy: RecoveryPolicyPort, project: string): RecoveryMode {
  const p = policy(project, MERGE_STALE_KEY);
  return p.source === "error" ? "off" : p.mode;
}
