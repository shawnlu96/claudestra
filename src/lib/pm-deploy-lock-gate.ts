/**
 * 部署锁执行闸:wrapper 以独立进程组组长起它,它先阻塞读 fd 3,等 wrapper 把它的身份 / 进程组落进锁记录后写来放行字节,
 * 才以 argv 起真正的部署命令(同组,不经 shell)。fd 3 读到 EOF(wrapper 崩溃 / 被 SIGKILL / 放弃)= 不放行,一步不执行。
 * 组内信号由 wrapper 整组转发,部署命令自己收;闸本身不因信号退出,等命令结束后原样回传退出码(信号 → 128+n)。
 * 只 import node 内置模块:闸要尽量小,起来就进阻塞读。
 */
import { closeSync, readSync } from "node:fs";
import { constants } from "node:os";

/** wrapper 用它定位闸脚本(import 本模块无副作用:main 只在直接运行时执行) */
export const GATE_SCRIPT = import.meta.path;
const GATE_FD = 3;
const NOT_RELEASED = 70; // 与 wrapper 的 EXIT.lockError 一致
const SPAWN_FAILED = 127;

const log = (s: string) => process.stderr.write(`[pm-deploy-lock] ${s}\n`);

/** 阻塞等放行字节;EOF / 读错 → false */
function waitRelease(): boolean {
  const buf = Buffer.alloc(1);
  for (;;) {
    try {
      return readSync(GATE_FD, buf, 0, 1, null) === 1;
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (code === "EINTR") continue;
      if (code === "EAGAIN") {
        Bun.sleepSync(10);
        continue;
      }
      return false;
    }
  }
}

async function main(argv: string[]): Promise<number> {
  // 整组信号:闸不退出,由部署命令自己处理,闸等它结束后回传结果
  for (const s of ["SIGINT", "SIGTERM", "SIGHUP"] as const) process.on(s, () => {});
  const released = waitRelease();
  try {
    closeSync(GATE_FD);
  } catch {}
  if (!released || argv.length === 0) {
    log("执行闸未放行(锁身份未落盘或 wrapper 已退出),未执行");
    return NOT_RELEASED;
  }
  let child: ReturnType<typeof Bun.spawn>;
  try {
    child = Bun.spawn(argv, { stdio: ["inherit", "inherit", "inherit"], env: process.env });
  } catch (e) {
    log(`起命令失败:${(e as Error).message}`);
    return SPAWN_FAILED;
  }
  const code = await child.exited;
  return child.signalCode ? 128 + ((constants.signals as Record<string, number>)[child.signalCode] ?? 0) : code;
}

if (import.meta.main) process.exit(await main(process.argv.slice(2)));
