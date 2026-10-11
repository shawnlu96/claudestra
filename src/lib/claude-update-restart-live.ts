/**
 * master 打 /exit 前最后一步的同步身份核对（hardening-CCIDLE1 第 5 轮审查 last-read-race）。
 *
 * masterRun() 是异步读（查子进程 + 读 Claude 进程登记），最后一次读可能返回读取开始时的过时快照：期间同一 shell 里
 * 换了一代 Claude（old@500 → new@501），pane pid 和旧会话记录都不变，/exit 就落到新那一代上。这里同步读、读完紧接着发键：
 * 拍身份时那个 Claude 进程（pid）还活着、还是那个进程（启动时间对得上），它的登记文件还写着那个会话。
 * 进程换了 / 退了 / 换了会话 / 读不了 = false（master 延后）。
 */
import { readFileSync } from "fs";
import { join } from "path";
import { ccSessionsDir, parseCcSessionEntry, procStartMatches } from "./cc-sessions.js";
import { pidAlive } from "./tmux-helper.js";

export interface RunLiveIO {
  dir: string;
  alive(pid: number): boolean;
  /** `ps -o lstart= -p <pid>`（同步）；读不出 = "" */
  lstart(pid: number): string;
}

const LIVE_IO = (): RunLiveIO => ({
  dir: ccSessionsDir(),
  alive: pidAlive,
  lstart(pid) {
    const r = Bun.spawnSync(["ps", "-o", "lstart=", "-p", String(pid)], { env: { ...process.env, LC_ALL: "C", LANG: "C", LC_TIME: "C" }, stdout: "pipe", stderr: "ignore" });
    return r.exitCode === 0 ? r.stdout.toString() : "";
  },
});

/** run = WavePorts.masterRun 的值（`会话@进程`）：这一代 Claude 此刻是否仍在、仍是那个会话 */
export function ccRunLive(run: string, io: RunLiveIO = LIVE_IO()): boolean {
  const at = run.lastIndexOf("@");
  const sessionId = run.slice(0, at);
  const pid = Number(run.slice(at + 1));
  if (at <= 0 || !Number.isInteger(pid) || pid <= 0 || !io.alive(pid)) return false;
  let raw: string;
  try {
    raw = readFileSync(join(io.dir, `${pid}.json`), "utf8");
  } catch {
    return false;
  }
  const e = parseCcSessionEntry(raw);
  return !!e && e.pid === pid && e.sessionId === sessionId && procStartMatches(e, io.lstart(pid));
}
