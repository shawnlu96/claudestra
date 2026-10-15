/**
 * 改名环境变量的唯一取值处（rename.env，档位由 FLOKA_RENAME_ENV 给）：
 *   off     只认旧名，与没有本模块时逐项相同（缺省；值写错也按 off）；
 *   observe 解析照旧，另在 stderr 报一次「on 档会改取新名」的候选；
 *   on      新名优先、旧名兜底；只有旧名时告警一次；两边不同取新名并告警。
 * 告警只写变量名，不写值。每次调用现算，不缓存取到的值。只依赖 node: 内置（见 names.ts）。
 */
import { flokaName, ISOLATED_DIRS, ISOLATION_SUFFIXES, LEGACY_PREFIX, legacyName, RENAMED_SUFFIXES } from "./names.ts";

type Env = Record<string, string | undefined>;
type EnvGear = "off" | "observe" | "on";

/** 档位开关自己只有新名：它是迁移的开关，不存在旧版本要兼容 */
const RENAME_ENV_VAR = "FLOKA_RENAME_ENV";

const notedOnce = new Set<string>();
function noteOnce(key: string, line: string): void {
  if (notedOnce.has(key)) return;
  notedOnce.add(key);
  process.stderr.write(`[floka-env] ${line}\n`);
}

const present = (v: string | undefined): v is string => v !== undefined && v.trim() !== "";
const differ = (a: string, b: string): boolean => a.trim() !== b.trim();

function envRenameGear(env: Env = process.env): EnvGear {
  const v = (env[RENAME_ENV_VAR] || "").trim();
  if (v === "observe" || v === "on") return v;
  if (v && v !== "off") noteOnce(`gear:${v}`, `${RENAME_ENV_VAR} 不是 off / observe / on，按 off 处理`);
  return "off";
}

/** 普通改名变量（后缀，如 STATE_DIR）按档位取值；返回原值（不 trim），与直接读 env 的旧写法一致 */
export function readRenamedEnv(suffix: string, env: Env = process.env): string | undefined {
  const [oldKey, newKey] = [legacyName(suffix), flokaName(suffix)];
  const [o, n] = [env[oldKey], env[newKey]];
  const gear = envRenameGear(env);
  if (gear === "off") return o;
  if (gear === "observe") {
    if (present(n)) {
      const how = present(o) && differ(o, n) ? `与 ${oldKey} 冲突，on 档取 ${newKey}` : `on 档取 ${newKey}`;
      noteOnce(`observe:${suffix}`, `observe：${how}（现在仍按 ${oldKey}）`);
    }
    return o;
  }
  if (present(n)) {
    if (present(o) && differ(o, n)) noteOnce(`conflict:${suffix}`, `${oldKey} 与 ${newKey} 不同，取 ${newKey}`);
    return n;
  }
  if (present(o)) noteOnce(`legacy:${suffix}`, `只设了旧名 ${oldKey}，请改用 ${newKey}（过渡期仍认）`);
  return o;
}

export class FlokaIsolationConflict extends Error {
  constructor(suffix: string) {
    super(`隔离变量 ${legacyName(suffix)} 与 ${flokaName(suffix)} 都设了且不同：拒绝，不替你选一边`);
    this.name = "FlokaIsolationConflict";
  }
}

/** 隔离变量：不看档位，两套名字都认；都设了且不同就抛 FlokaIsolationConflict */
export function readIsolationEnv(suffix: string, env: Env = process.env): string | undefined {
  const [o, n] = [env[legacyName(suffix)], env[flokaName(suffix)]];
  if (present(o) && present(n) && differ(o, n)) throw new FlokaIsolationConflict(suffix);
  return present(o) ? o : present(n) ? n : o;
}

/** 沙箱或测试进程（两套开关任一为 1，或 bun test 的 NODE_ENV=test） */
function isIsolatedProcess(env: Env = process.env): boolean {
  return ["SANDBOX", "TEST"].some((s) => (readIsolationEnv(s, env) || "").trim() === "1") || env.NODE_ENV === "test";
}

/** 任何档位都核：沙箱 / lab / 测试变量两套名字冲突就抛；沙箱与测试进程里状态 / 运行目录的两名冲突也抛 */
function assertIsolationEnv(env: Env = process.env): void {
  for (const s of ISOLATION_SUFFIXES) readIsolationEnv(s, env);
  if (isIsolatedProcess(env)) for (const s of ISOLATED_DIRS) readIsolationEnv(s, env);
}

/**
 * 进程入口（lib/paths.ts 加载时）调一次：on 档把登记的每个变量按新名优先解析后写回两个名字，
 * 直接读旧名的老代码和继承本进程 env 的子进程都拿到同一个值（过渡期同值双名）；observe 只报候选；off 不动。
 */
export function applyRenamedEnv(env: Env = process.env): void {
  assertIsolationEnv(env);
  const gear = envRenameGear(env);
  if (gear === "off") return;
  for (const s of RENAMED_SUFFIXES) {
    const v = readRenamedEnv(s, env);
    if (gear === "on" && present(v)) env[legacyName(s)] = env[flokaName(s)] = v;
  }
}

/**
 * 子进程启动前缀 / 从零拼的 env 用：给定旧名 → 值，on 档另出同值的新名并带上档位开关；off / observe 原样返回。
 */
export function withFlokaTwins(vars: Record<string, string>, env: Env = process.env): Record<string, string> {
  if (envRenameGear(env) !== "on") return vars;
  const out: Record<string, string> = { ...vars };
  for (const [k, v] of Object.entries(vars)) if (k.startsWith(LEGACY_PREFIX)) out[flokaName(k.slice(LEGACY_PREFIX.length))] = v;
  out[RENAME_ENV_VAR] = "on";
  return out;
}
