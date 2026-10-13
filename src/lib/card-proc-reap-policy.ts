/**
 * 卡 worktree 残留进程回收（card-proc-reap.ts）的档位（REAPALIVE1）：按项目读恢复键 cardProcReap（recovery-policy.json，
 * `ledger scheduler-recovery <项目> on|observe|off --key cardProcReap --reason <为什么>`），缺省 observe。每次调用现读文件，
 * 不在进程启动时缓存，所以切档不用重启服务、不用改 launchd。
 * 环境变量 CLAUDESTRA_CARD_PROC_REAP 只剩一个用途：= off 是整机紧急关闭，压过任何项目的恢复键；别的值（含 on）一律不看，
 * 以恢复键为准。恢复策略文件读不了 / 不认识的档位 = 保守 off（带原因）。tests/card-proc-reap-policy.test.ts。
 */
import { recoveryPolicy, type RecoveryKey, type RecoveryPolicyPort } from "./recovery-policy.js";

export type CardReapMode = "off" | "observe" | "on";
export const CARD_REAP_ENV = "CLAUDESTRA_CARD_PROC_REAP";
export const CARD_REAP_KEY: RecoveryKey = "cardProcReap";
const MODES: readonly string[] = ["off", "observe", "on"];

export interface CardReapPolicy { mode: CardReapMode; /** 为什么被保守停成 off（坏策略）；正常档位没有 */ diagnostic?: string }
/** 测试换掉环境变量与恢复策略的读法；生产两个都不给 */
export interface CardReapPolicyOptions { env?: Record<string, string | undefined>; policy?: RecoveryPolicyPort }

/** 这个项目此刻的档位。不抛：读策略出任何岔子都答 off。 */
export function cardReapPolicy(project: string, o: CardReapPolicyOptions = {}): CardReapPolicy {
  if ((o.env ?? process.env)[CARD_REAP_ENV]?.trim() === "off") return { mode: "off" };
  try {
    const p = (o.policy ?? recoveryPolicy)(project, CARD_REAP_KEY);
    if (p.source === "error") return { mode: "off", diagnostic: p.diagnostic ?? "恢复策略读不了" };
    if (!MODES.includes(p.mode)) return { mode: "off", diagnostic: `不认识的档位 ${String(p.mode)}` };
    return { mode: p.mode };
  } catch (e) {
    return { mode: "off", diagnostic: e instanceof Error ? e.message : String(e) };
  }
}

/**
 * 给 card-proc-reap 的档位读法：每次调用都现读。坏策略停成 off 时记一行原因，同一项目同一原因只记一次（修好再坏会再记）。
 */
export function cardReapModeReader(log: (m: string) => void, o: CardReapPolicyOptions = {}): (project: string) => CardReapMode {
  const told = new Map<string, string>();
  return (project) => {
    const p = cardReapPolicy(project, o);
    if (p.diagnostic && told.get(project) !== p.diagnostic) log(`卡残留进程回收按 off 停手（项目 ${project}）：${p.diagnostic}`);
    if (p.diagnostic) told.set(project, p.diagnostic); else told.delete(project);
    return p.mode;
  };
}
