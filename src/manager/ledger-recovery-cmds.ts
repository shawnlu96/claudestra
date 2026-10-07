/**
 * `ledger scheduler-recovery <project> [on|observe|off|inherit] [--key <恢复键>] [--manual-stall-hours N|none] --reason`：派单恢复策略
 * （dispatch-recovery-CFG，独立文件 recovery-policy.json，不碰 scheduler.json）的唯一 CLI。都不带 = 只看各键的生效策略与最近观察记录；
 * 改模式（项目级或 --key 单键，inherit 撤掉单键覆盖）要该项目 PM（调度助理除外）/ master / owner，manualStallHours 只有 owner 能改。
 * `scheduler-recovery --machine [on|observe|off|inherit] --key <整机恢复键> --reason`：同一文件的整机段（machine.*，LCFG1W），
 * 不要项目、不借项目权限，只有 owner / master 能改；都不带 = 只看整机各键。逻辑在 lib/recovery-machine-policy.ts。
 * 逻辑都在 lib/recovery-policy.ts；path 参数只给测试指向临时文件。
 */
import { LedgerError } from "../lib/ledger-store.js";
import { MACHINE_RECOVERY_KEYS, machineRecoveryPolicies, setMachineRecovery, type MachineSet } from "../lib/recovery-machine-policy.js";
import {
  MANUAL_STALL_HOURS_MAX, observedRecent, RECOVERY_KEYS, RECOVERY_POLICY_PATH, recoveryPolicies, setRecovery, type RecoveryKey, type RecoverySet,
} from "../lib/recovery-policy.js";
import type { LedgerCli } from "./ledger-context.js";
import type { CommandSpec } from "./ledger-write-cmds.js";

const USAGE = "用法：scheduler-recovery <project> [on|observe|off|inherit] [--key <恢复键>] [--manual-stall-hours N|none] --reason <为什么>（都不带 = 只看）"
  + "；整机：scheduler-recovery --machine [on|observe|off|inherit] --key <整机恢复键> --reason <为什么>";

function hoursFlag(raw: string | undefined): number | null | undefined {
  if (raw === undefined) return undefined;
  if (raw === "none") return null;
  if (!/^\d{1,4}$/.test(raw)) throw new LedgerError("invalid", `--manual-stall-hours 要是 1..${MANUAL_STALL_HOURS_MAX} 的整数或 none，收到 ${raw}`);
  return Number(raw);
}

function show(c: LedgerCli, project: string, path: string) {
  const last = c.p.flags.last ?? "20";
  if (!/^\d{1,3}$/.test(last) || Number(last) < 1) throw new LedgerError("invalid", `--last 要是 1..999 的整数，收到 ${last}`);
  return { ok: true, project, keys: RECOVERY_KEYS, policies: recoveryPolicies(project, path), observed: observedRecent(c.db, project, Number(last)) };
}

/** --machine: no project, no project permission; show is open, a change is owner / master (setMachineRecovery). */
async function machine(c: LedgerCli, path: string) {
  const [, mode, ...extra] = c.p.pos, key = c.p.flags.key;
  if (extra.length || c.p.flags["manual-stall-hours"] !== undefined || c.p.flags.last !== undefined) throw new LedgerError("invalid", USAGE);
  if (mode === undefined) {
    if (key !== undefined) throw new LedgerError("invalid", "整机只看不改时不要带 --key（看的是全部整机键）");
    return { ok: true, scope: "machine", keys: MACHINE_RECOVERY_KEYS, policies: machineRecoveryPolicies(path) };
  }
  if (key === undefined) throw new LedgerError("invalid", `整机改模式要带 --key（${MACHINE_RECOVERY_KEYS.join(" / ")}）`);
  const r = await setMachineRecovery(c.db, c.ctx(), { set: { key, mode } as MachineSet, reason: c.need("reason") }, { path });
  return { ok: true, scope: "machine", key: r.key, from: r.from, to: r.to, changed: r.changed, path: r.path, event: r.event, ...(r.duplicate ? { duplicate: true } : {}),
    effective: "整机机制每次动作前现读，下一次判断即生效" };
}

export function recoveryCmds(path = RECOVERY_POLICY_PATH): Record<string, CommandSpec> {
  return {
    "scheduler-recovery": {
      valued: ["reason", "dedup", "manual-stall-hours", "last", "key"],
      bools: ["machine"],
      usage: "scheduler-recovery <project> [on|observe|off|inherit] [--key <恢复键>] [--manual-stall-hours N|none] --reason <为什么>"
        + "（缺省 observe；模式：PM / master / owner；阈值：仅 owner；都不带 = 看策略与最近观察）"
        + "；scheduler-recovery --machine [on|observe|off|inherit] --key <整机恢复键> --reason（整机段，仅 owner / master）",
      async run(c) {
        if (c.p.bools.has("machine")) return machine(c, path);
        const [, project, mode, ...extra] = c.p.pos;
        if (!project || extra.length) throw new LedgerError("invalid", USAGE);
        if (!c.deps.projectIds.includes(project)) throw new LedgerError("not_found", `projects.json 里没有项目 ${project}`);
        const key = c.p.flags.key, hours = hoursFlag(c.p.flags["manual-stall-hours"]);
        const set = { ...(mode !== undefined ? { mode } : {}), ...(key !== undefined ? { key } : {}),
          ...(hours !== undefined ? { manualStallHours: hours } : {}) } as RecoverySet & { key?: RecoveryKey };
        if (!Object.keys(set).length) return show(c, project, path);
        const r = await setRecovery(c.db, c.ctx(), { project, set, reason: c.need("reason") }, { path });
        return { ok: true, project, from: r.from, to: r.to, changed: r.changed, path: r.path, event: r.event, ...(r.duplicate ? { duplicate: true } : {}),
          effective: "恢复机制每次动作前现读，下一次判断即生效" };
      },
    },
  };
}

export const RECOVERY_CMDS = recoveryCmds();
