/**
 * 沙箱里 Pi 状态的文件边界（#301 r1 P1-1/P1-2）：按**真实路径**判归属，不按字面目录。
 * - 读：会话目录 / 文件经符号链接指到真实沙箱根之外的，当它不存在（pi-session.ts、runtimes/pi.ts）；
 * - 写凭据：目标目录不许是链接、真实路径在根下、权限强制 0700；文件用唯一名排他创建（O_EXCL|O_NOFOLLOW）、fchmod 0600、
 *   原子 rename，已有的目标是链接就拒——不复用上次中断留下的 tmp，也不跟着链接写到根外。
 * 不依赖 sandbox.ts（它反过来调这里）。检查与使用之间仍有极短窗口：防的是 agent / 人误放的链接，不是同机的对抗进程。tests/pi-acp-sandbox-fs.test.ts。
 */
import { randomBytes } from "node:crypto";
import { chmodSync, closeSync, constants, fchmodSync, fstatSync, lstatSync, mkdirSync, openSync, realpathSync, renameSync, unlinkSync, writeSync } from "node:fs";
import { dirname, isAbsolute, relative } from "node:path";

const realOrNull = (p: string): string | null => {
  try {
    return realpathSync(p);
  } catch {
    return null; // 不存在 / 悬空链接：调用方按「不在根下」处理
  }
};

const lstatOrNull = (p: string) => {
  try {
    return lstatSync(p);
  } catch {
    return null; // 不存在
  }
};

/** p 的真实路径在 root 的真实路径之下（不含 root 本身）；任一方解析不了都算不在 */
export function realInside(root: string, p: string): boolean {
  const r = root ? realOrNull(root) : null;
  const q = realOrNull(p);
  if (!r || !q) return false;
  const rel = relative(r, q);
  return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
}

/** 沙箱的 Pi 目录：是链接、存在却不是目录、真实路径不在真实沙箱根下，都返回原因；还不存在算合格（pi / pi-auth 会在根下新建） */
export function piStateDirProblem(root: string, dir: string): string | null {
  const st = lstatOrNull(dir);
  if (!st) return realOrNull(dirname(dir)) === realOrNull(root) ? null : `${dir} 的上级不是沙箱根`;
  if (st.isSymbolicLink()) return `${dir} 是符号链接：沙箱的 Pi 目录必须是根下的真实目录（链接会把会话 / 凭据带到根外）`;
  if (!st.isDirectory()) return `${dir} 不是目录`;
  return realInside(root, dir) ? null : `${dir} 的真实路径不在沙箱根 ${root} 下`;
}

/** 建 / 修正一个只给自己的目录：不许是链接，已存在也强制 0700，最后核对 */
export function ensurePrivateDir(dir: string): void {
  if (!lstatOrNull(dir)) mkdirSync(dir, { mode: 0o700 });
  const st = lstatSync(dir);
  if (st.isSymbolicLink() || !st.isDirectory()) throw new Error(`${dir} 不是真实目录（是链接或文件），不往里写凭据`);
  chmodSync(dir, 0o700);
  if ((lstatSync(dir).mode & 0o777) !== 0o700) throw new Error(`${dir} 的权限改不成 0700`);
}

/** 原子写一个 0600 的文件：目标已存在且不是普通文件（链接等）就拒；tmp 唯一名、排他创建、不跟链接，失败删掉自己的 tmp */
export function writePrivateFile(path: string, text: string): void {
  const cur = lstatOrNull(path);
  if (cur && !cur.isFile()) throw new Error(`${path} 已存在且不是普通文件（链接？），不覆盖`);
  const tmp = `${path}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
  const fd = openSync(tmp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try {
    fchmodSync(fd, 0o600); // umask 只会去掉位，可能比 0600 还紧：显式定成 0600
    writeSync(fd, text);
    if ((fstatSync(fd).mode & 0o777) !== 0o600) throw new Error(`${tmp} 的权限不是 0600`);
    closeSync(fd);
    renameSync(tmp, path);
    const done = lstatSync(path);
    if (!done.isFile() || (done.mode & 0o777) !== 0o600) throw new Error(`${path} 写完后不是 0600 的普通文件`);
  } catch (e) {
    try {
      closeSync(fd);
    } catch {
      /* 已经关过（rename 那步失败）：fd 不会泄漏 */
    }
    if (lstatOrNull(tmp)) unlinkSync(tmp);
    throw e;
  }
}
