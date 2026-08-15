/**
 * v2.19.0 实例指纹 —— 「这条消息是哪个进程发的」。
 *
 * 由来（2026-08-15）：Discord 频道里出现两条内容为假的「Claude Code 已退出
 * （掉线）」告警，而本机 bridge 的 stdout 和 metrics.jsonl 里都没有对应记录，
 * 被告警的两个 agent 的 claude 进程其实一直活着。查了半天最后卡在一个无解的
 * 问题上：**消息本身不携带任何发信方信息**——同一个 bot token 在任何机器、
 * 任何进程里发出来的消息长得一模一样，事后无从归属。
 *
 * 所以凡是「系统自己主动发起、且可能被误判来源」的告警，都带上这个尾注。
 * 一行小字换来的是：下次再出现，一眼就知道是谁发的。
 */

import { hostname } from "os";
import { readFileSync } from "fs";

let cached: string | null = null;

export function instanceTag(): string {
  if (cached) return cached;
  let ver = "";
  try {
    const pkg = JSON.parse(
      readFileSync(new URL("../../package.json", import.meta.url), "utf8"),
    ) as { version?: string };
    ver = pkg.version ?? "";
  } catch {
    /* 读不到版本就只报机器和 pid */
  }
  const host = hostname().replace(/\.local$|\.lan$/i, "");
  cached = `${host}·pid${process.pid}${ver ? `·v${ver}` : ""}`;
  return cached;
}

/** Discord 小字尾注（`-#` 只在行首生效，所以调用方要把它单独放一行） */
export function originFooter(): string {
  return `-# 来源 ${instanceTag()}`;
}
