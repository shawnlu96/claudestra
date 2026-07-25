/**
 * bun 可执行文件的绝对路径解析。
 *
 * 为什么需要它：launchd 起的 daemon 和 Claude Code 的 hook 都跑在一个 PATH 极窄的
 * /bin/sh 里，不带 ~/.bun/bin，所以拉子进程必须用绝对路径。此前代码在 5 处各自写死
 * `${HOME}/.bun/bin/bun` —— 只有用官方 install.sh 装 bun 的人才对。用 Homebrew /
 * mise / asdf 装的人（bun 在 /opt/homebrew/bin/bun，~/.bun 根本不存在）会顺利通过
 * 安装向导（它用的是 which bun），然后 launchd 每 10 秒 spawn 一次不存在的二进制，
 * 全程没有任何用户可见提示，cron 与截图直接哑掉。
 *
 * 解析顺序（顺序本身是有讲究的）：
 *   1. which bun —— 拿到的通常是稳定符号链接（/opt/homebrew/bin/bun、~/.bun/bin/bun）。
 *      这条刻意排在 execPath 前面：Homebrew 环境下 process.execPath 是
 *      /opt/homebrew/Cellar/bun/<版本>/bin/bun，**带版本号**，而这个路径会被写进
 *      launchd plist 和 CLI wrapper —— brew 升级一次 bun，旧版本目录就没了，
 *      daemon 直接起不来。实测本机 execPath=.../Cellar/bun/1.3.14/bin/bun 而
 *      which=/opt/homebrew/bin/bun，正是这个坑。
 *   2. process.execPath —— launchd 那种 PATH 极窄、which 找不到 bun 的环境下用它，
 *      当前进程的解释器一定是可用的。
 *   3. ~/.bun/bin/bun —— 官方安装位置兜底，与历史行为一致。
 */

import { existsSync } from "fs";
import { execFileSync } from "child_process";
import { homedir } from "os";
import { dirname } from "path";

let cached: string | null = null;

export function resolveBunPath(): string {
  if (cached) return cached;

  try {
    const found = execFileSync("/usr/bin/which", ["bun"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    if (found && existsSync(found)) return (cached = found);
  } catch {
    /* which 不存在 / PATH 里没有 bun（launchd 环境常见），走下一条 */
  }

  const self = process.execPath;
  if (self && /(^|\/)bun[^/]*$/.test(self) && existsSync(self)) {
    return (cached = self);
  }

  return (cached = `${homedir()}/.bun/bin/bun`);
}

/** bun 所在目录，用于给子进程拼 PATH。 */
export function bunBinDir(): string {
  return dirname(resolveBunPath());
}
