/**
 * i28-SECPOOL1：security 卡的审查是否也进统一池，按项目开关（docs/architecture/security-pool.md）。
 * statePath("security-pool.json") = { projects: { <id>: "on" | "observe" | "off" } }，只有 `ledger security-pool` 写。
 * 缺省 / 损坏 / 非法取值 = off：审查只在本机，和开关出现前逐字一样；observe 派单同 off，只在放置说明里多一句池去处。
 * 规划器不读这个文件：autoSnapshot 把值填进快照的 securityPool，判定一律走 securityReviewLocalOnly。
 * tests/security-pool.test.ts。
 */
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { acquireLock } from "./file-lock.js";
import { statePath } from "./paths.js";
import { readJsonStateSync, reportCorrupt, StateCorruptError, writeJsonAtomicSync } from "./state-file.js";

export type SecurityPoolMode = "on" | "observe" | "off";
const SECURITY_POOL_MODES: readonly SecurityPoolMode[] = ["on", "observe", "off"];

export const isSecurityPoolMode = (v: unknown): v is SecurityPoolMode => (SECURITY_POOL_MODES as readonly unknown[]).includes(v);

/**
 * 这张卡的审查是否只能在本机：security 卡且开关不是 on。不是 security 卡（含没有流程）= false，各调用方原有的
 * `!workflow` 判断照旧自己写。mode 缺省 = off。
 */
export function securityReviewLocalOnly(workflow: { template: string } | null | undefined, mode: SecurityPoolMode | null | undefined): boolean {
  return workflow?.template === "security" && mode !== "on";
}

/** observe：派单同 off，但放置说明要给出「按统一池会放到哪」 */
export const securityPoolObserved = (workflow: { template: string } | null | undefined, mode: SecurityPoolMode | null | undefined): boolean =>
  workflow?.template === "security" && mode === "observe";

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const validFile = (v: unknown): boolean => isObj(v) && (v.projects === undefined || isObj(v.projects));

/** 非法取值每个项目 + 值只喊一次：autoSnapshot 每轮每张 security 卡都会读 */
const warned = new Set<string>();

const securityPoolPath = (): string => statePath("security-pool.json");

/** 读者：缺键 / 文件不存在 / 损坏 / 非法取值都按 off；非法取值打一次带项目名的警告 */
export function securityPoolMode(project: string, path = securityPoolPath()): SecurityPoolMode {
  const r = readJsonStateSync(path, validFile);
  if (r.status === "corrupt") reportCorrupt(path, r.error, "security-pool");
  const v = r.status === "ok" ? (r.data as { projects?: Record<string, unknown> }).projects?.[project] : undefined;
  if (v === undefined || isSecurityPoolMode(v)) return v ?? "off";
  const key = `${project}\0${JSON.stringify(v)}`;
  if (!warned.has(key)) {
    warned.add(key);
    console.error(`⚠️ [security-pool] 项目 ${project} 的开关取值 ${JSON.stringify(v)} 不认识（只能是 on / observe / off），按 off 处理: ${path}`);
  }
  return "off";
}

/**
 * 写者：非法取值直接报错；文件损坏拒写，不把「空 + 这次改动」盖回去（lib/state-file.ts 的约定）。
 * 各项目共用一份文件，读改写在 `<path>.lock` 跨进程锁里做：两个 PM 同时切不同项目，后写者也不会抹掉先写者的键
 * （tmp+rename 只防半写，不防丢更新；ledger 命令不拿 manager 命令级写锁）。拿不到锁直接报错，不降级写；
 * 读完后失租（暂停超过租期、锁被回收）也报错不写：rename 前用 lock.held 核租。
 */
export async function setSecurityPoolMode(project: string, mode: string, path = securityPoolPath()): Promise<{ from: SecurityPoolMode; mode: SecurityPoolMode }> {
  if (!isSecurityPoolMode(mode)) throw new Error(`security-pool 开关只能是 on / observe / off（不是 ${mode}）`);
  mkdirSync(dirname(path), { recursive: true }); // 锁是 mkdir 抢的，父目录得先在
  const lock = await acquireLock(`${path}.lock`);
  if (!lock) throw new Error(`security-pool 开关文件锁 20s 未拿到，没写（稍后重试）: ${path}.lock`);
  try {
    const r = readJsonStateSync(path, validFile);
    if (r.status === "corrupt") throw new StateCorruptError(path, r.error);
    const projects = r.status === "ok" ? (r.data as { projects?: Record<string, unknown> }).projects ?? {} : {};
    const from = securityPoolMode(project, path);
    // 读完后被暂停超过租期、锁已被别人回收：旧副本不能盖回去（会抹掉别人的更新）。rename 前核租，失租直接报错不写
    try { writeJsonAtomicSync(path, { projects: { ...projects, [project]: mode } }, { commitIf: lock.held }); } catch (e) {
      if (!lock.held()) throw new Error(`security-pool 开关文件锁已失租（被当过期回收），没写，重跑命令即可: ${path}.lock`);
      throw e;
    }
    return { from, mode };
  } finally { lock.release(); }
}
