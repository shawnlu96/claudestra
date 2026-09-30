/**
 * `manager codex-wall status|clear`（T78 Codex 额度墙，运行时在 bridge/codex-wall.ts）。
 *   status：读 codex-wall.json（bridge 每次变动都落盘）+ 押后队列里 Codex 墙押着的条数，只读。
 *   clear ：owner 手动确认 Codex 额度已恢复——留一个请求文件（同 quota-wall clear 的文件信箱），bridge 下一拍（≤15 秒）取走并出墙，
 *           走和自动出墙同一套恢复（补投 → 续跑 → 收卡 → 告诉 caller / owner）。
 */
import { existsSync } from "node:fs";
import { CODEX_WALL_CLEAR_PATH, CODEX_WALL_PATH, codexWallActive, isCodexWallState, type CodexWallState } from "../lib/codex-wall.js";
import { readJsonStateSync, writeJsonAtomicSync } from "../lib/state-file.js";
import { output } from "./core.js";
import { wallQueued } from "./quota-wall.js";

const CLEAR_WAIT_MS = 20_000;
const POLL_MS = 500;

function readState(): CodexWallState | null {
  const r = readJsonStateSync(CODEX_WALL_PATH, isCodexWallState);
  return r.status === "ok" ? (r.data as CodexWallState) : null;
}

const iso = (ms: number | null | undefined) => (typeof ms === "number" ? new Date(ms).toISOString() : null);

function describe(s: CodexWallState | null) {
  const w = s?.wall;
  if (!w) return { active: false, wall: null, queued: wallQueued("codex_quota_wall") };
  return {
    active: codexWallActive(s!),
    wall: {
      source: w.source, enteredAt: iso(w.enteredAt), resetsAt: iso(w.resetsAt), resetsText: w.resetsText, credits: w.credits,
      agents: Object.values(w.hits).map((h) => h.agent), probeDown: !!w.probeDown,
      exit: w.exit ? { at: iso(w.exit.at), via: w.exit.via } : null, recovery: w.recovery ?? null,
    },
    queued: wallQueued("codex_quota_wall"),
  };
}

export async function cmdCodexWall(args: string[]): Promise<void> {
  const sub = args[0] || "status";
  if (sub === "status") return output(describe(readState()));
  if (sub !== "clear") {
    process.exitCode = 1;
    return output({ ok: false, error: "用法: codex-wall status|clear" });
  }
  const before = readState();
  if (!before || !codexWallActive(before)) return output({ ok: true, cleared: false, note: "现在没有 Codex 额度墙", ...describe(before) });
  writeJsonAtomicSync(CODEX_WALL_CLEAR_PATH, { at: Date.now(), by: "cli" });
  // 等 bridge 取走请求、出墙；恢复本身接着在 bridge 里跑，不在这里等完
  for (const deadline = Date.now() + CLEAR_WAIT_MS; Date.now() < deadline; await Bun.sleep(POLL_MS)) {
    const now = readState();
    if (now?.wall?.exit) return output({ ok: true, cleared: true, ...describe(now) });
  }
  output({ ok: true, cleared: false, pending: existsSync(CODEX_WALL_CLEAR_PATH), note: "请求已留下，bridge 20 秒内没取走（bridge 没在跑？）；它起来后的第一拍会出墙" });
}
