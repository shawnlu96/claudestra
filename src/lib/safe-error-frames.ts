/**
 * PROPLOG1：catch 里能安全写进日志的一行错误描述——错误名、执行阶段、栈里仓库内文件的相对路径加行列（最多 8 帧）。
 * 不输出错误 message（可能带中心原文、凭据、URL）、函数名、本机绝对路径；node_modules、bun 内部、仓库外的帧只记一个计数。
 * 给只打 `(e as Error).name` 的 catch 用：线上报错要能定位到行，又不能把原文带进日志。
 */
import { realpathSync } from "fs";
import { isAbsolute, relative, resolve, sep } from "path";
import { fileURLToPath } from "url";
import { REPO_ROOT } from "./repo-root.js";

export const MAX_SAFE_FRAMES = 8;

/** 栈行末尾的位置：`at fn (/abs/file.ts:12:3)`、`at /abs/file.ts:12:3`、`at file:///abs/file.ts:12:3` */
const LOCATION = /\(?((?:file:\/\/)?\/[^()]*?):(\d+):(\d+)\)?\s*$/;
/** 相对路径只放行普通文件名字符：防栈里夹带的奇怪字节进日志 */
const SAFE_PATH = /^[\w@.+-]+(?:\/[\w@.+-]+)*$/;
const SAFE_NAME = /^[A-Za-z_$][\w$]{0,63}$/;

const repoRoots = (root: string): string[] => {
  const abs = resolve(root);
  let real = abs;
  try { real = realpathSync(abs); } catch { /* 读不到真实路径就只认原样 */ }
  return [...new Set([abs, real])];
};
const DEFAULT_ROOTS = repoRoots(REPO_ROOT);

/** 仓库内的相对路径；仓库外 / node_modules / 不像普通文件名 → null */
function inRepo(roots: readonly string[], file: string): string | null {
  for (const root of roots) {
    const rel = relative(root, file);
    if (!rel || rel.startsWith("..") || isAbsolute(rel)) continue;
    const posix = rel.split(sep).join("/");
    if (posix.split("/").includes("node_modules") || !SAFE_PATH.test(posix)) return null;
    return posix;
  }
  return null;
}

/** 错误名：Error 的 name 只放行标识符形状（自定义 name 可能被塞了原文），其他抛出值记 non_error */
export function safeErrorName(e: unknown): string {
  if (!(e instanceof Error)) return "non_error";
  return SAFE_NAME.test(e.name) ? e.name : "Error";
}

/** 栈里仓库内的帧（`相对路径:行:列`，至多 max 个，按栈顺序）+ 其余帧的个数（含超出 max 的仓库帧） */
export function safeFrames(e: unknown, o: { root?: string; max?: number } = {}): { frames: string[]; external: number } {
  const stack = e instanceof Error && typeof e.stack === "string" ? e.stack : "";
  const roots = o.root === undefined ? DEFAULT_ROOTS : repoRoots(o.root), max = o.max ?? MAX_SAFE_FRAMES;
  const frames: string[] = [];
  let external = 0;
  // 只看 `at ` 开头的行：首行（以及多行 message）是错误原文，不碰
  for (const raw of stack.split("\n")) {
    const line = raw.trim();
    if (!line.startsWith("at ")) continue;
    const m = LOCATION.exec(line);
    let rel: string | null = null;
    if (m) {
      let file = m[1]!;
      if (file.startsWith("file://")) { try { file = fileURLToPath(file); } catch { file = ""; } }
      rel = file ? inRepo(roots, file) : null;
    }
    if (rel && frames.length < max) frames.push(`${rel}:${m![2]}:${m![3]}`);
    else external++;
  }
  return { frames, external };
}

/** 一行：`RangeError（阶段 开卡；帧 src/a.ts:1:2 ← src/b.ts:3:4；其他帧 2）`。stage 由调用方给固定文字 */
export function safeErrorLine(e: unknown, stage: string, o: { root?: string; max?: number } = {}): string {
  const { frames, external } = safeFrames(e, o);
  const parts = [`阶段 ${stage}`, `帧 ${frames.length ? frames.join(" ← ") : "无"}`, ...(external ? [`其他帧 ${external}`] : [])];
  return `${safeErrorName(e)}（${parts.join("；")}）`;
}
