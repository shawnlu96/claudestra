/**
 * 回合失败卡算不算出借单「当前回合」的失败（lend-deps.ts failureOf）。worker 名按单固定、卡在结单时才关，单凭「这个 agent 有张开着的卡」
 * 会把开跑前的旧失败、换会话前的失败、已被后续回合接上的失败都算到这一单头上。按宿主报的失败时刻 extra.failedAt（不是 bridge 写卡的
 * createdAt：写卡要先等 registry，晚到的旧失败会被当成新回合的）三条都满足才认：失败在本单开跑之后；卡上的会话（extra.sessionId）=
 * journal 记的会话；失败之后这个会话没再开过回合（Codex rollout 的 event_msg task_started）。证明不了一律不自动停单，交回存活探测兜底，
 * 卡留在看板上由人处理（老宿主的卡没有这两个字段也是不认）。tests/lend-turn-failure.test.ts。
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

/** 这张回合失败卡为什么证明不了是本单当前回合的；null = 证明了 */
export function turnFailureDoubt(card: Pick<Ask, "extra">, row: Pick<LendRow, "sessionId" | "startedAt">,
  sessionPath: (sessionId: string) => string | null): string | null {
  const failedAt = card.extra.failedAt;
  if (typeof failedAt !== "number") return "卡上没有失败时刻（老宿主）";
  if (!row.sessionId || card.extra.sessionId !== row.sessionId) return "卡上的会话和本单不符";
  if (row.startedAt === null || failedAt < row.startedAt) return "失败发生在本单开跑之前";
  const path = sessionPath(row.sessionId);
  if (!path) return "找不到本单会话的 rollout";
  const turnAt = lastTurnStartAt(path);
  if (turnAt === null) return "rollout 尾部找不到回合开始记录";
  return turnAt > failedAt ? "失败之后会话又开过新回合" : null;
}
