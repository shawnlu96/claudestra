/**
 * doctor：两个 bridge 共用一个状态目录（不支持）。到达序号文件记着最近一次发现别的进程也在写它（lib/arrival-order.ts），
 * 一天内发现过就 warn：两份 bridge 各自发号会重号，owner 的「停」和开口谁先谁后会判错。同一端口上的两份另有端口检查报。
 * 判定是纯函数（tests/arrival-order.test.ts）。
 */
import type { SeqFile } from "./arrival-order.js";
import type { Check } from "./doctor.js";
import { statePath } from "./paths.js";
import { readJsonStateSync } from "./state-file.js";

const RECENT_MS = 24 * 3600_000;

export function arrivalSeqVerdict(file: SeqFile | undefined, now: number): Check[] {
  const f = file?.foreign;
  if (!f || now - f.at > RECENT_MS) return [];
  const min = Math.max(1, Math.round((now - f.at) / 60_000));
  return [{
    group: "bridge", name: "到达序号", status: "warn",
    detail: `${min} 分钟前发现另一个进程（pid ${f.pid ?? "?"}）也在写到达序号：两个 bridge 共用一个状态目录，「停」和开口的先后会判错`,
    fix: "只留 launchd 托管的那份（launchctl list | grep claudestra；ps aux | grep src/bridge.ts），停掉另一份",
  }];
}

/** 号文件是 bridge/turn-cuts.ts 的 turn-cuts.json 换后缀 */
export function checkArrivalSeq(): Check[] {
  const r = readJsonStateSync(statePath("turn-cuts-seq.json"));
  return arrivalSeqVerdict(r.status === "ok" ? (r.data as SeqFile) : undefined, Date.now());
}
