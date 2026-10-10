/**
 * i28-SECPOOL1：security 卡的审查是否也进统一池，按项目开关（docs/architecture/security-pool.md）。
 * statePath("security-pool.json") = { rev, projects: { <id>: "on" | "observe" | "off" } }，只有 `ledger security-pool` 写；
 * 每次写另存一份 `.r<rev>` 版本定稿，当前值以版本链最新一版为准（见 setSecurityPoolMode）。
 * 缺省 / 损坏 / 非法取值 = off：审查只在本机，和开关出现前逐字一样；observe 派单同 off，只在放置说明里多一句池去处。
 * 规划器不读这个文件：autoSnapshot 把值填进快照的 securityPool，判定一律走 securityReviewLocalOnly。
 * 版本号 CAS 读写抽成 readProjectMode / setProjectMode，i28-SECPOOL2 的 private-pool.json（card-repo.ts）共用同一份，不另抄。
 * tests/security-pool.test.ts。
 */
import { randomUUID } from "node:crypto";
import { existsSync, linkSync, mkdirSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
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
const validFile = (v: unknown): boolean => isObj(v) && (v.projects === undefined || isObj(v.projects)) &&
  (v.rev === undefined || (Number.isSafeInteger(v.rev) && (v.rev as number) >= 0));

/** 非法取值每个项目 + 值只喊一次：autoSnapshot 每轮每张 security 卡都会读 */
const warned = new Set<string>();

const securityPoolPath = (): string => statePath("security-pool.json");
/** 第 rev 版的定稿：link 排他创建，同一个版本号只有一个写者能占到（见 setSecurityPoolMode） */
const revPath = (path: string, rev: number): string => `${path}.r${rev}`;

type PoolRead = { status: "ok"; rev: number; projects: Record<string, unknown> } | { status: "corrupt"; path: string; error: string };

/**
 * 当前值 = 从 security-pool.json 的 rev（缺 = 0）往后顺着 `.r<rev+1>`、`.r<rev+2>` … 走到头的那一版（版本号以文件名为准）。
 * security-pool.json 只是镜像：迟到的旧写者 rename 可能把它盖回旧版，但版本链只增不改不删，读者照样走到最新。
 */
function readLatest(path: string): PoolRead {
  let at = path, r = readJsonStateSync(path, validFile), rev = 0, projects: Record<string, unknown> = {};
  for (;;) {
    if (r.status === "corrupt") return { status: "corrupt", path: at, error: r.error };
    if (r.status === "ok") {
      const d = r.data as { rev?: number; projects?: Record<string, unknown> };
      if (at === path) rev = d.rev ?? 0;
      projects = d.projects ?? {};
    }
    const next = revPath(path, rev + 1);
    if (!existsSync(next)) return { status: "ok", rev, projects };
    at = next;
    rev += 1;
    r = readJsonStateSync(next, validFile);
  }
}

function modeOf(label: string, project: string, projects: Record<string, unknown>, path: string): SecurityPoolMode {
  const v = projects[project];
  if (v === undefined || isSecurityPoolMode(v)) return v ?? "off";
  const key = `${label}\0${project}\0${JSON.stringify(v)}`;
  if (!warned.has(key)) {
    warned.add(key);
    console.error(`⚠️ [${label}] 项目 ${project} 的开关取值 ${JSON.stringify(v)} 不认识（只能是 on / observe / off），按 off 处理: ${path}`);
  }
  return "off";
}

/** 通用读者（security-pool / private-pool 共用，label 是文件名与警告前缀）：缺键 / 文件不存在 / 损坏 / 非法取值都按 off；非法取值打一次带项目名的警告 */
export function readProjectMode(label: string, project: string, path: string): SecurityPoolMode {
  const r = readLatest(path);
  if (r.status === "corrupt") { reportCorrupt(r.path, r.error, label); return "off"; }
  return modeOf(label, project, r.projects, path);
}

export const securityPoolMode = (project: string, path = securityPoolPath()): SecurityPoolMode => readProjectMode("security-pool", project, path);

const isEexist = (e: unknown): boolean => (e as NodeJS.ErrnoException)?.code === "EEXIST";
const COMMIT_ATTEMPTS = 20;

/**
 * 通用写者（security-pool / private-pool 共用）：非法取值直接报错；文件损坏拒写，不把「空 + 这次改动」盖回去（lib/state-file.ts 的约定）。
 * 各项目共用一份文件，读改写是乐观并发（审查 project-mode-race）：读到第 N 版，提交 = `link(tmp, .r<N+1>)` 排他创建，
 * 内核保证同一版本号只有一个写者成功。别人先占了 N+1（含本进程读完后被暂停任意久、期间别人已提交）→ EEXIST，
 * 重读最新版、在它上面重做这次改动再试，不会拿旧副本盖掉别人的更新；没有租期，也就没有「暂停超租被接管」。
 * 定稿后再 tmp+rename 刷新 security-pool.json 镜像；这一步迟到也只会把镜像盖旧，读者顺版本链仍读到最新。
 */
export async function setProjectMode(label: string, project: string, mode: string, path: string): Promise<{ from: SecurityPoolMode; mode: SecurityPoolMode }> {
  if (!isSecurityPoolMode(mode)) throw new Error(`${label} 开关只能是 on / observe / off（不是 ${mode}）`);
  mkdirSync(dirname(path), { recursive: true });
  for (let i = 0; i < COMMIT_ATTEMPTS; i++) {
    const cur = readLatest(path);
    if (cur.status === "corrupt") throw new StateCorruptError(cur.path, cur.error);
    const from = modeOf(label, project, cur.projects, path), rev = cur.rev + 1;
    const text = JSON.stringify({ rev, projects: { ...cur.projects, [project]: mode } }, null, 2);
    const tmp = `${path}.${process.pid}.${randomUUID()}.tmp`;
    try {
      writeFileSync(tmp, text, { flag: "wx" });
      try { linkSync(tmp, revPath(path, rev)); } catch (e) { if (isEexist(e)) continue; throw e; }
    } finally { try { unlinkSync(tmp); } catch { /* 没建成 */ } }
    // 镜像另写一份（不和版本定稿共用 inode：就地改镜像的编辑器不能改到定稿）
    // 已定稿：镜像写失败只警告，不能报「没写」
    try { writeJsonAtomicSync(path, JSON.parse(text)); } catch (e) { console.error(`⚠️ [${label}] 第 ${rev} 版已生效，镜像 ${path} 没刷新（读者按版本链读，不影响）: ${(e as Error).message}`); }
    return { from, mode };
  }
  throw new Error(`${label} 开关连续 ${COMMIT_ATTEMPTS} 次被别的写者抢先提交，没写（稍后重试）: ${path}`);
}

export const setSecurityPoolMode = (project: string, mode: string, path = securityPoolPath()): Promise<{ from: SecurityPoolMode; mode: SecurityPoolMode }> =>
  setProjectMode("security-pool", project, mode, path);
