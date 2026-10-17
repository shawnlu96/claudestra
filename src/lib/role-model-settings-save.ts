// 模型档位表的唯一写入口（网页设置 PUT 用）。和读端分文件：调度器经 card-role-definitions 只 import 读端，写端不进调度可达图。
import { copyFileSync, existsSync } from "node:fs";
import { acquireLock } from "./file-lock.js";
import { ROLE_MODEL_SETTINGS_PATH, readRoleModels, roleModelsProblem, type RoleModelPatch, type RoleModelTable } from "./role-model-settings.js";
import { writeJsonAtomicSync } from "./state-file.js";
import { mergeTierPatch } from "./task-tier-model-settings.js";

export type RoleModelSave =
  | { ok: true; table: RoleModelTable; replacedInvalid: string | null }
  | { ok: false; code: "busy" | "conflict" | "unreadable" | "invalid" | "io"; error: string; current?: RoleModelTable };
const LOCK_WAIT_MS = 5_000;
/** 测试缝：beforeCommit 在 rename 前、核锁前同步调用（模拟写者恰在提交前被暂停） */
export interface SaveHooks { beforeCommit?: () => void }

/**
 * 唯一写入口。rev 不是现在这一版 = conflict（带回现值，网页按它刷新再改），不覆盖别人刚存的；读不了 = 不写。
 * 写失败一律 ok:false，调用方不能报「已保存」。
 */
export async function saveRoleModels(p: RoleModelPatch, path = ROLE_MODEL_SETTINGS_PATH, now = Date.now(), hooks: SaveHooks = {}): Promise<RoleModelSave> {
  let lost = false;
  let lock: Awaited<ReturnType<typeof acquireLock>>;
  try { lock = await acquireLock(`${path}.lock`, LOCK_WAIT_MS); } catch (e) { return { ok: false, code: "io", error: `拿模型档位表的锁失败：${(e as Error).message}` }; }
  if (!lock) return { ok: false, code: "busy", error: "模型档位表正被别的请求修改，稍后再试" };
  try {
    const cur = readRoleModels(path);
    if (cur.status === "unreadable") return { ok: false, code: "unreadable", error: cur.error };
    if (cur.table.rev !== p.rev) return { ok: false, code: "conflict", error: `基于第 ${p.rev} 版改，现在已是第 ${cur.table.rev} 版`, current: cur.table };
    const row = cur.table.roles[p.role];
    const { tiers: curTiers, ...base } = cur.table;
    const tiers = p.tier !== undefined ? mergeTierPatch(curTiers, p.role, p) : curTiers;
    const roles = p.tier !== undefined ? cur.table.roles
      : { ...cur.table.roles, [p.role]: { claude: p.claude ?? row.claude, codex: p.codex === undefined ? row.codex : p.codex } };
    const table: RoleModelTable = { ...base, v: 1, rev: cur.table.rev + 1, roles, ...(tiers && Object.keys(tiers).length ? { tiers } : {}) };
    // 约束（含 TIER3 security 下限）挡下的是请求本身不合法：invalid（API 400），不是写盘故障
    const bad = roleModelsProblem(table);
    if (bad) return { ok: false, code: "invalid", error: `合并后的表不合法：${bad}` };
    if (cur.status === "invalid" && existsSync(path)) copyFileSync(path, `${path}.invalid-${now}`);
    // 拿锁之后全程同步、没有 await；锁在 rename 前一刻经 commitIf 再核（被暂停超期、锁被别人回收的写者在这里被拦下，不覆盖后来者）
    writeJsonAtomicSync(path, table, { mode: 0o600, trailingNewline: true, commitIf: () => {
      hooks.beforeCommit?.();
      return lock.held() || ((lost = true), false);
    } });
    return { ok: true, table, replacedInvalid: cur.status === "invalid" ? cur.error : null };
  } catch (e) {
    if (lost) return { ok: false, code: "busy", error: "模型档位表的锁已失效（被当过期回收），没写入" };
    return { ok: false, code: "io", error: `写模型档位表失败：${(e as Error).message}` };
  } finally {
    lock.release();
  }
}
