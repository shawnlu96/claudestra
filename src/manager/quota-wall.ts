/**
 * `manager quota-wall status|clear`（T24 额度闸，运行时在 bridge/quota-wall.ts）。
 *   status：读 quota-wall.json（bridge 每次变动都落盘）+ 押后队列里额度闸的条数，只读。
 *   clear ：人工确认额度已恢复——留一个请求文件，bridge 下一拍（≤15 秒）取走并出闸，走和自动出闸同一套恢复
 *           （关菜单 → 补投 → 续跑）。不加 HTTP 路由：CLI 没有 /api/v1 凭据，文件信箱在 bridge 不在线时也不丢请求。
 */
import { existsSync } from "node:fs";
import { statePath } from "../lib/paths.js";
import { isWallState, QUOTA_WALL_CLEAR_PATH, QUOTA_WALL_PATH, wallActive, type WallState } from "../lib/quota-wall.js";
import { readJsonStateSync, writeJsonAtomicSync } from "../lib/state-file.js";
import { output } from "./core.js";

function readWall(): WallState | null {
  const r = readJsonStateSync(QUOTA_WALL_PATH, isWallState);
  return r.status === "ok" ? (r.data as WallState) : null;
}

function wallQueued(): number {
  const r = readJsonStateSync(statePath("held-messages.json"));
  if (r.status !== "ok" || !r.data || typeof r.data !== "object") return 0;
  return Object.values(r.data as Record<string, unknown>).reduce<number>(
    (n, q) => n + (Array.isArray(q) ? q.filter((i) => (i as { reason?: unknown })?.reason === "quota_wall").length : 0), 0);
}

function summary(s: WallState | null) {
  const w = s?.wall ?? null;
  if (!w) return { active: false, wall: null };
  const iso = (ms: number | null | undefined) => (typeof ms === "number" ? new Date(ms).toISOString() : null);
  return {
    active: wallActive(s!),
    wall: {
      kind: w.kind, source: w.source, enteredAt: iso(w.enteredAt), resetsAt: iso(w.resetsAt), resetsText: w.resetsText,
      agents: Object.values(w.hits).map((h) => h.agent), notified: w.notifiedAt !== undefined,
      exit: w.exit ? { at: iso(w.exit.at), via: w.exit.via } : null, recovery: w.recovery ?? null,
    },
    queued: wallQueued(),
  };
}

export async function cmdQuotaWall(args: string[]): Promise<void> {
  const sub = args[0] || "status";
  if (sub === "status") return output(summary(readWall()));
  if (sub !== "clear") {
    output({ ok: false, error: "用法: quota-wall status|clear" });
    process.exitCode = 1;
    return;
  }
  const before = readWall();
  if (!before || !wallActive(before)) return output({ ok: true, cleared: false, note: "现在没有额度闸", ...summary(before) });
  writeJsonAtomicSync(QUOTA_WALL_CLEAR_PATH, { at: Date.now(), by: "cli" });
  // bridge 15 秒一拍：等它取走请求、出闸（恢复本身接着在 bridge 里跑，不在这里等完）
  for (let i = 0; i < 40; i++) {
    await Bun.sleep(500);
    const now = readWall();
    if (now?.wall?.exit) return output({ ok: true, cleared: true, ...summary(now) });
  }
  output({
    ok: true, cleared: false, pending: existsSync(QUOTA_WALL_CLEAR_PATH),
    note: "请求已留下，bridge 20 秒内没取走（bridge 没在跑？）；它起来后的第一拍会出闸",
  });
}
