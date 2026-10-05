/**
 * 回合失败卡算不算出借单「当前回合」的失败（lend-deps.ts failureOf）。worker 名按单固定、卡在结单时才关，单凭「这个 agent 有张开着的卡」
 * 会把开跑前的旧失败、换会话前的失败、已被后续回合接上的失败都算到这一单头上。按宿主报的失败时刻 extra.failedAt（不是 bridge 写卡的
 * createdAt：写卡要先等 registry，晚到的旧失败会被当成新回合的）三条都满足才认：失败在本单开跑之后；卡上的会话（extra.sessionId）=
 * journal 记的会话；失败之后这个会话没再开过回合（Codex rollout 的 event_msg task_started）。读不准一律不认，交回存活探测兜底
 * （老宿主的卡没有这两个字段也是不认）。tests/lend-turn-failure.test.ts。
 */
import { closeSync, fstatSync, openSync, readSync } from "node:fs";
import type { Ask } from "./ledger-asks.js";
import type { LendRow } from "./lend-journal.js";

/** ponytail: 只看尾部 1 MiB，失败那一轮开头之后又写了超过 1 MiB 就找不到 task_started、按不认处理；真碰上再改成分块倒读 */
const TAIL_BYTES = 1024 * 1024;

/** rollout 尾部最后一个 task_started 的时刻；没有、读不了 = null */
function lastTurnStartAt(path: string): number | null {
  let fd: number;
  try { fd = openSync(path, "r"); } catch { return null; } // 文件没了 / 读不了：不知道最近一轮何时开的，调用方按不认处理
  try {
    const size = fstatSync(fd).size;
    const len = Math.min(size, TAIL_BYTES);
    const buf = Buffer.alloc(len);
    readSync(fd, buf, 0, len, size - len);
    for (const line of buf.toString("utf8").split("\n").reverse()) {
      if (!line.includes('"task_started"')) continue;
      try {
        const rec = JSON.parse(line);
        if (rec?.type !== "event_msg" || rec.payload?.type !== "task_started") continue;
        const at = Date.parse(rec.timestamp);
        return Number.isFinite(at) ? at : null;
      } catch { continue; } // 尾巴开头那行被截断、不是完整 JSON：跳过，再往前没有更早的行了
    }
    return null;
  } finally { closeSync(fd); }
}

export function isCurrentTurnFailure(card: Pick<Ask, "extra">, row: Pick<LendRow, "sessionId" | "startedAt">,
  sessionPath: (sessionId: string) => string | null): boolean {
  const failedAt = card.extra.failedAt;
  if (typeof failedAt !== "number" || !row.sessionId || row.startedAt === null || failedAt < row.startedAt || card.extra.sessionId !== row.sessionId) return false;
  const path = sessionPath(row.sessionId);
  const turnAt = path ? lastTurnStartAt(path) : null;
  return turnAt !== null && turnAt <= failedAt;
}
