/**
 * 状态根维护的固定落点:$HOME/.claudestra-maintenance/state/,与品牌状态根解耦,不看 CLAUDESTRA_STATE_DIR。
 * 下设 reports/<runId>/、journals/<runId>/、control/;目录 0700、产物 0600。生产入口不接受任意 journal 路径:
 * 规范化后维护根落在任一状态根里、属主不是本用户、路径上有 symlink,一律拒绝(搬根会把日志和锁一起搬走)。
 * 只依赖 node: 模块与 test-guard:身份读取器(lib/instance-id.ts 等)也经这里查屏障。tests/state-maintenance-paths.test.ts。
 */

import { chmodSync, lstatSync, mkdirSync, mkdtempSync, realpathSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve, sep } from "node:path";
import { isTestProcess, isUnderTempDir } from "../test-guard.js";

const ROOT_PARTS = [".claudestra-maintenance", "state"] as const;
const DIR_MODE = 0o700;
export const FILE_MODE = 0o600;

/** 报告与 ledger 里只出现逻辑根名,不出现个人绝对路径 */
export const LOGICAL_ROOTS = { old: "legacy-state", new: "floka-state" } as const;

export const validRunId = (id: string): boolean => /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(id) && !id.includes("..");

let testHome: string | null = null;

/** 测试进程的 home 不在临时目录下就换成本进程专用的临时目录:用例不能读写真实维护根(同 test-guard 的状态目录闸) */
function defaultHome(): string {
  const home = homedir();
  if (!isTestProcess() || isUnderTempDir(home)) return home;
  return (testHome ??= mkdtempSync(join(tmpdir(), "cstra-test-maint-")));
}

/** 维护根;home 只给测试 / 纯函数注入 */
export function maintenanceRoot(home: string = defaultHome()): string {
  return join(home, ...ROOT_PARTS);
}

export interface MaintPaths {
  root: string;
  control: string;
  reports: string;
  journals: string;
}

export function maintPaths(root: string): MaintPaths {
  return { root, control: join(root, "control"), reports: join(root, "reports"), journals: join(root, "journals") };
}

export function runDir(base: string, runId: string): string {
  if (!validRunId(runId)) throw new Error("runId 不合法");
  return join(base, runId);
}

/** 最近的已存在祖先取 realpath 再接剩余部分(/var → /private/var 这类别名比对才可靠) */
function canonical(p: string): string {
  const rest: string[] = [];
  let cur = resolve(p);
  for (;;) {
    try {
      return join(realpathSync(cur), ...rest.reverse());
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
      const up = dirname(cur);
      if (up === cur) return resolve(p);
      rest.push(basename(cur));
      cur = up;
    }
  }
}

const inside = (child: string, root: string): boolean => child === root || child.startsWith(root.endsWith(sep) ? root : root + sep);

/**
 * 维护根本身的问题(不建目录):不是绝对路径、落在状态根里、home(维护根往上两级)以下的已存在部分有 symlink 或属主不是本用户。
 * stateRoots 给旧根 / 新根(含状态根被做成 symlink 时的目标);空数组 = 只查属主与 symlink。
 */
export function rootProblems(root: string, stateRoots: string[], uid = process.getuid?.() ?? -1): string[] {
  const out: string[] = [];
  if (!isAbsolute(root)) return ["维护根必须是绝对路径"];
  const home = dirname(dirname(root));
  const c = canonical(root);
  for (const s of stateRoots) {
    for (const form of new Set([canonical(s), resolve(s)])) if (inside(c, form) || inside(form, c)) out.push("维护根与状态根重叠,拒绝");
  }
  let cur = root;
  while (inside(cur, home) && cur !== home) {
    let st;
    try {
      st = lstatSync(cur);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") out.push(`读不了维护根路径(${(e as NodeJS.ErrnoException).code})`);
      cur = dirname(cur);
      continue;
    }
    const rel = cur.slice(home.length + 1) || ".";
    if (st.isSymbolicLink()) out.push(`维护根路径上有未知 symlink:${rel}`);
    else if (!st.isDirectory()) out.push(`维护根路径上不是目录:${rel}`);
    else if (uid >= 0 && st.uid !== uid) out.push(`维护根路径属主不符:${rel}`);
    cur = dirname(cur);
  }
  return [...new Set(out)];
}

/** 建目录(0700,已存在的也收紧);路径上已存在的部分必须先过 rootProblems */
export function ensureDir(path: string): void {
  mkdirSync(path, { recursive: true, mode: DIR_MODE });
  chmodSync(path, DIR_MODE);
}

/** 维护根与三个子目录;有问题抛错,一个目录都不建 */
export function prepareMaintenanceRoot(root: string, stateRoots: string[]): MaintPaths {
  const problems = rootProblems(root, stateRoots);
  if (problems.length) throw new Error(problems.join(";"));
  const p = maintPaths(root);
  for (const d of [dirname(root), p.root, p.control, p.reports, p.journals]) ensureDir(d);
  return p;
}
