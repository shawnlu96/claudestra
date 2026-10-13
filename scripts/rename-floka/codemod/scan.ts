/**
 * 机械改名碰文件系统的规矩都在这里：哪些目录不进（依赖、构建物、真实状态目录、外部安装副本），扫描根和输入文件
 * 怎么核，软链怎么处置。只读——这个模块不写任何东西；写临时目标根的在 apply.ts。
 */
import { existsSync, lstatSync, readdirSync, realpathSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import { DEFAULT_RUNTIME_DIR } from "../../../src/lib/paths.ts";
import { stateDirIn } from "../../../src/lib/state-dir.ts";

export type Env = Record<string, string | undefined>;
export interface FsCtx { env: Env; home: string }
export interface Skipped { path: string; reason: string }
export interface Entry { rel: string; link: boolean }

/** 拒绝执行 / 拒绝读取。message 以 `kind: ` 开头，CLI 据此给退出码 1（参数、表本身的错是 2） */
export class Refusal extends Error {
  constructor(readonly kind: string, detail: string) {
    super(`${kind}: ${detail}`);
  }
}

/** 按目录名排除：版本库内部、依赖、构建物、别的仓库 pin 进来的闭包。查的时候只认自有属性（constructor、toString 这类目录名不在名单里） */
export const EXCLUDED_DIR_NAMES: Record<string, string> = {
  ".git": "版本库内部",
  node_modules: "依赖",
  Pods: "依赖",
  vendor: "外部 pin 的副本",
  ".packages": "依赖",
  ".next": "构建物",
  target: "构建物",
  out: "构建物",
  dist: "构建物",
  build: "构建物",
  DerivedData: "构建物",
  coverage: "构建物",
};

export const within = (child: string, parent: string) => child === parent || child.startsWith(parent.endsWith(sep) ? parent : parent + sep);

export function realOr(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return resolve(p); // 不存在的路径读不到也写不到，按字面比较就够
  }
}

/** 真实状态目录、运行时目录（含环境变量指过去的，取值口径同 lib/state-dir：先 trim，空串当没设） */
export function stateDirs({ env, home }: FsCtx): string[] {
  const overrides = [env.CLAUDESTRA_STATE_DIR, env.CLAUDESTRA_RUNTIME_DIR].map((v) => (v ?? "").trim()).filter(Boolean);
  return [stateDirIn(home), DEFAULT_RUNTIME_DIR, ...overrides].map(realOr);
}

/** 装到仓库外面的副本：CLI 包装脚本、launchd / systemd 单元、桌面应用、中继服务器上的部署。它们由安装步骤重写，不由本脚本改 */
export function installCopies(home: string): string[] {
  const underHome = [".local/bin", ".bun/bin", "Library/LaunchAgents", ".config/systemd/user"].map((p) => join(home, p));
  return [...underHome, "/Applications/Claudestra.app", "/opt/claudestra", "/etc/systemd/system", "/etc/nginx"].map(realOr);
}

/**
 * 扫描根的真实路径。根是受保护目录或它的上级 → 拒绝；落在外部安装副本里 → 拒绝；落在状态目录里的只认带 .git 的
 * 检出（出借 worker 的工作副本就在状态目录下面，它是仓库不是状态）。
 */
export function checkedRoot(root: string, ctx: FsCtx): string {
  if (!existsSync(root) || !lstatSync(root).isDirectory()) throw new Refusal("root_not_directory", root);
  const real = realpathSync(root);
  for (const dir of installCopies(ctx.home)) {
    if (within(dir, real) || within(real, dir)) throw new Refusal("refuse_install_copy", `${root} 是外部安装副本、在它里面或是它的上级`);
  }
  for (const dir of stateDirs(ctx)) {
    if (within(dir, real)) throw new Refusal("refuse_state_dir", `${root} 是状态/运行时目录或它的上级`);
    if (within(real, dir) && !existsSync(join(real, ".git"))) throw new Refusal("refuse_state_dir", `${root} 在状态/运行时目录里且不是仓库检出`);
  }
  return real;
}

function inCheckout(file: string, stop: string): boolean {
  for (let d = dirname(file); d !== stop && within(d, stop); d = dirname(d)) if (existsSync(join(d, ".git"))) return true;
  return false;
}

/** 输入文件（--config / --rules-file / --plan）读之前按真实路径核：在状态目录里的拒绝，例外只有其下仓库检出里的文件 */
export function checkedInput(path: string, what: string, cwd: string, ctx: FsCtx): string {
  const abs = resolve(cwd, path);
  if (!existsSync(abs)) throw new Refusal("input_missing", `${what} ${path} 不存在`);
  const real = realpathSync(abs);
  if (!lstatSync(real).isFile()) throw new Refusal("input_not_file", `${what} ${path} 不是普通文件`);
  const hit = stateDirs(ctx).find((dir) => within(real, dir) && !inCheckout(real, dir));
  if (hit) throw new Refusal("refuse_state_input", `${what} ${path} 在状态/运行时目录里（或是指向那里的软链）`);
  return real;
}

/**
 * 按名字排序走一遍目录树。不跟软链：软链原样交给调用方（link = true），由它判断指向哪里。排除掉的目录记进 skipped，
 * 只记最上面那一层。blocked 是落在根里面的受保护目录（状态目录、安装副本）。
 */
export function* walkTree(root: string, blocked: string[], skipped: Skipped[], dir = root): Generator<Entry> {
  for (const name of readdirSync(dir).sort()) {
    const full = join(dir, name);
    const rel = full.slice(root.length + 1).split(sep).join("/");
    const st = lstatSync(full);
    if (st.isSymbolicLink()) yield { rel, link: true };
    else if (st.isFile()) yield { rel, link: false };
    else if (!st.isDirectory()) skipped.push({ path: rel, reason: "不是普通文件" });
    else if (Object.hasOwn(EXCLUDED_DIR_NAMES, name)) skipped.push({ path: `${rel}/`, reason: EXCLUDED_DIR_NAMES[name]! });
    else if (blocked.some((b) => within(full, b))) skipped.push({ path: `${rel}/`, reason: "状态目录或外部安装副本" });
    else yield* walkTree(root, blocked, skipped, full);
  }
}
