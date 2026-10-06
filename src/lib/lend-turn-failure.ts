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

/** 从尾部按块倒读：每次 read 不超过 CHUNK；回合开始之后 rollout 可能写好几 MiB（工具输出），整份读进内存不行，只看尾部 1 MiB 又会漏 */
const CHUNK = 256 * 1024;
/** 最多往前读这么多还没有 task_started 就按不认处理（卡留给人）；跨块残行也受它约束，内存最多占这么多 */
const MAX_SCAN_BYTES = 64 * 1024 * 1024;

/** rollout 最后一个 task_started 的时刻（只往前读 maxScan 字节）；没有、读不了、超出上限 = null。导出给测试压小上限 */
export function lastTurnStartAt(path: string, maxScan = MAX_SCAN_BYTES): number | null {
  let fd: number;
  try { fd = openSync(path, "r"); } catch { return null; } // 文件没了 / 读不了：不知道最近一轮何时开的，调用方按不认处理
  try {
    const size = fstatSync(fd).size;
    const floor = Math.max(0, size - maxScan);
    let carry = Buffer.alloc(0); // 上一块（更靠后）开头那段不完整的行，接到这一块末尾
    for (let end = size; end > floor;) {
      const start = Math.max(floor, end - CHUNK);
      const chunk = Buffer.alloc(end - start);
      readSync(fd, chunk, 0, chunk.length, start);
      const buf = Buffer.concat([chunk, carry]);
      // 按 \n 字节切：UTF-8 多字节字符里不会出现 0x0A，切开不会坏字；第 0 段只有读到文件开头才是完整行
      let hi = buf.length;
      for (;;) {
        const nl = hi > 0 ? buf.lastIndexOf(10, hi - 1) : -1; // hi = 0 时不能传 -1：负偏移会从尾部重新找
        if (nl < 0 && start > 0) break;
        const at = turnStartIn(buf.subarray(nl + 1, hi));
        if (at !== undefined) return at;
        if (nl < 0) break;
        hi = nl;
      }
      carry = Buffer.from(buf.subarray(0, hi));
      end = start;
    }
    return null;
  } finally { closeSync(fd); }
}

/** 一行是 task_started 就给它的时刻（时间戳坏 = null）；不是 = undefined，接着往前找 */
function turnStartIn(line: Buffer): number | null | undefined {
  if (!line.includes('"task_started"')) return undefined;
  try {
    const rec = JSON.parse(line.toString("utf8"));
    if (rec?.type !== "event_msg" || rec.payload?.type !== "task_started") return undefined;
    const at = Date.parse(rec.timestamp);
    return Number.isFinite(at) ? at : null;
  } catch { return undefined; } // 上限处被截断的行 / 工具输出里恰好带这个字样的坏行：不是回合开始记录，接着往前找
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
  if (turnAt === null) return "rollout 末尾 64 MiB 内找不到回合开始记录";
  return turnAt > failedAt ? "失败之后会话又开过新回合" : null;
}
