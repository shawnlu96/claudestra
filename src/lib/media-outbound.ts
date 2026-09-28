/**
 * 出站附件副本账本：agent reply 的 files 由 bridge 拷进 inbox（`<毫秒>_<清洗名>`），拷的同时记下「谁、哪个原路径 → 哪个副本」。
 * 媒体索引按账认领出站副本：只落到同一个 agent 名下，原路径要一致、时间要对得上。
 * 没有账的老副本只能按「名字 + 时间窗」猜，猜的结果一律不可信（非 manage 只拿占位）——猜错就是把 A 的文件交给 B 的 guest（T22 审查 P1-2）。
 * 表与媒体索引同库，但不随索引版本清空：账是事实，丢了就再也认不回来。
 */
import type { Database } from "bun:sqlite";
import { copyFile, mkdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { sanitizeAttachmentBase } from "./attachment-name.js";

/** 副本相对 reply 记录时间的认领窗：拷贝在 reply 调用后发生，往前只留时钟误差，往后给慢投递 */
export const OUT_WINDOW_BEFORE_MS = 5_000;
export const OUT_WINDOW_AFTER_MS = 10 * 60_000;

export function ensureOutboundTable(db: Database): void {
  db.exec(`CREATE TABLE IF NOT EXISTS out_copies (
    dest TEXT PRIMARY KEY, agent TEXT NOT NULL, src TEXT NOT NULL, ms INTEGER NOT NULL)`);
  db.exec("CREATE INDEX IF NOT EXISTS out_copies_src ON out_copies(agent, src, ms)");
}

/** registry 名是 agent-xxx；投递侧拿到的可能是裸名。master / 解析失败的 "?" 原样 */
export function canonicalAgent(name: string): string {
  return name === "master" || name === "?" || name.startsWith("agent-") ? name : `agent-${name}`;
}

async function freeName(dir: string, base: string): Promise<string> {
  for (let ms = Date.now(); ; ms++) {
    const name = `${ms}_${base}`;
    try {
      await stat(join(dir, name));
    } catch {
      return name; // 不存在 = 可用（同一毫秒两个同名副本以前会互相覆盖）
    }
  }
}

/**
 * 把 reply 的附件拷进 inbox 并记账；返回 SSE 事件用的 { name, attachment }。拷贝失败只记日志、跳过那一个（与原行为一致）。
 * db 取不到（索引库坏了）也照样拷，只是没账——那几个副本以后只能按名字猜、对非 manage 不可见。
 */
export async function copyOutboundFiles(paths: string[], agent: string, inboxDir: string, db: Database | null): Promise<{ name: string; attachment: string }[]> {
  const out: { name: string; attachment: string }[] = [];
  for (const p of paths) {
    try {
      const base = sanitizeAttachmentBase(p);
      await mkdir(inboxDir, { recursive: true });
      const dest = await freeName(inboxDir, base);
      await copyFile(p, join(inboxDir, dest));
      out.push({ name: base, attachment: dest });
      db?.prepare("INSERT OR REPLACE INTO out_copies (dest, agent, src, ms) VALUES (?, ?, ?, ?)").run(dest, canonicalAgent(agent), p.trim(), Number(dest.split("_")[0]));
    } catch (e) {
      console.error(`API 出站附件拷贝失败 ${p}:`, (e as Error).message);
    }
  }
  return out;
}

/**
 * 账上这个 agent 在消息时间窗里拷过的这个原路径的副本，取时间最接近的一份：同一路径连发两次（改了图再发）时，
 * 两份副本都在窗里，取最早的会让新消息打开旧图。同一次投递给多个前端会各拷一份，内容相同，取哪份都一样。
 */
export function ledgerCopy(db: Database, agent: string, src: string, tsMs: number): string | null {
  const row = db
    .prepare("SELECT dest FROM out_copies WHERE agent = ? AND src = ? AND ms BETWEEN ? AND ? ORDER BY ABS(ms - ?) ASC, ms ASC LIMIT 1")
    .get(agent, src, tsMs - OUT_WINDOW_BEFORE_MS, tsMs + OUT_WINDOW_AFTER_MS, tsMs) as { dest: string } | null;
  return row?.dest ?? null;
}

/** 这个副本在账上属于别的 agent（老数据按名字猜时要排除掉） */
export function ownedByOther(db: Database, agent: string, dest: string): boolean {
  const row = db.prepare("SELECT agent FROM out_copies WHERE dest = ?").get(dest) as { agent: string } | null;
  return !!row && row.agent !== agent;
}
