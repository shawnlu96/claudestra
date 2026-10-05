/**
 * 「cwd 解开符号链接后是什么」，同一路径一个进程只真解析一次。
 *
 * bun 的 realpathSync 在 macOS 上是 open() + F_GETPATH：launchd 起的 bridge 打开受 TCC 保护的目录（~/Documents 等）
 * 每次卡满 5s 再报 EINTR，主线程同步等着。bg 活动追踪每 10s 给每个 agent 算 3 次 slug，cwd 在 ~/Documents 的
 * agent 一个就让整个 bridge 每轮冻 15s（Discord 心跳漏拍、HTTP 全卡）。所以成功和「在但打不开」（EINTR / EPERM / EACCES）都记住；
 * 其它失败（目录还没建、EMFILE 这类一时缺资源、没有 code 的）不记，下次再试。复现与回归：tests/realpath-cache.test.ts。
 */
import { realpathSync } from "node:fs";

/** 稳定的失败：路径在、就是打不开，再试只会再卡一次；白名单外的都下次重试 */
const STABLE_FAILURES = new Set(["EINTR", "EPERM", "EACCES"]);

/** 测试接缝：注入一个假 realpath 数调用次数；生产用下面的 realpathCached */
export function makeRealpathCache(real: (p: string) => string): (p: string) => string {
  // ponytail: 不设上限、不过期——键是 agent cwd，一天几百个；软链改指向要重启进程才看得见（实际没人这么做）
  const memo = new Map<string, string>();
  return (p) => {
    const hit = memo.get(p);
    if (hit !== undefined) return hit;
    try {
      const r = real(p);
      memo.set(p, r);
      return r;
    } catch (e) {
      // 打不开就按字面算：它不是软链时字面就是对的
      if (STABLE_FAILURES.has(String((e as NodeJS.ErrnoException).code))) memo.set(p, p);
      return p;
    }
  };
}

/** 解开符号链接（macOS 的 /tmp → /private/tmp）；解不开按原样返回，不抛 */
export const realpathCached = makeRealpathCache((p) => realpathSync(p));
