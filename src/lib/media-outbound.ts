/**
 * inbox 文件归属账：agent reply 的 files 由 bridge 拷进 inbox（`<毫秒>_<清洗名>`），拷的同时记下「谁、哪个原路径 → 哪个副本」；
 * API 入站上传（`api_<毫秒>_<清洗名>`）落盘时也记一笔（src = UPLOAD_SRC）。两种名字都原子占名，一个文件只属于一次写入。
 * 媒体索引按账认领出站副本：只落到同一个 agent 名下，原路径要一致、时间要对得上；入站行指向账上别的 agent 的文件就不可信。
 * 没有账的老副本只能按「名字 + 时间窗」猜，猜的结果一律不可信（非 manage 只拿占位）——猜错就是把 A 的文件交给 B 的 guest（T22 审查 P1-2）。
 * 表与媒体索引同库，但不随索引版本清空：账是事实，丢了就再也认不回来。
 */
import type { Database } from "bun:sqlite";
import { constants } from "node:fs";
import { copyFile, mkdir, open, unlink } from "node:fs/promises";
import { join } from "node:path";
import { sanitizeAttachmentBase } from "./attachment-name.js";

/** 副本相对 reply 记录时间的认领窗：拷贝在 reply 调用后发生，往前只留时钟误差，往后给慢投递 */
export const OUT_WINDOW_BEFORE_MS = 5_000;
export const OUT_WINDOW_AFTER_MS = 10 * 60_000;
/** 入站上传在账上的 src（出站副本记的是 agent 给的原路径） */
const UPLOAD_SRC = "upload";

export function ensureOutboundTable(db: Database): void {
  db.exec(`CREATE TABLE IF NOT EXISTS out_copies (
    dest TEXT PRIMARY KEY, agent TEXT NOT NULL, src TEXT NOT NULL, ms INTEGER NOT NULL)`);
  db.exec("CREATE INDEX IF NOT EXISTS out_copies_src ON out_copies(agent, src, ms)");
}

/** registry 名是 agent-xxx；投递侧拿到的可能是裸名。master / 解析失败的 "?" 原样 */
export function canonicalAgent(name: string): string {
  return name === "master" || name === "?" || name.startsWith("agent-") ? name : `agent-${name}`;
}

/**
 * 原子占名拷贝：COPYFILE_EXCL 让「名字已被占」由内核判定，撞名（同一毫秒同名、另一个并发拷贝抢先）就换下一毫秒重试。
 * 先 stat 再覆盖写不是原子的：两个 agent 同一毫秒发同名文件会拿到同一个名字，后写的覆盖先写的，账和内容对不上（T22 审查 r2 P1-A）。
 */
async function copyToFreeName(src: string, dir: string, base: string): Promise<string> {
  for (let ms = Date.now(); ; ms++) {
    const name = `${ms}_${base}`;
    try {
      await copyFile(src, join(dir, name), constants.COPYFILE_EXCL);
      return name;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
    }
  }
}

function recordOwner(db: Database | null, dest: string, agent: string, src: string, ms: number): void {
  db?.prepare("INSERT OR REPLACE INTO out_copies (dest, agent, src, ms) VALUES (?, ?, ?, ?)").run(dest, canonicalAgent(agent), src, ms);
}

/**
 * API 入站上传落盘：open(wx) 原子占名，撞名（同一毫秒同名、同一请求里两个同名文件）就换带随机数字后缀的名字重试，
 * 仍是 `api_<数字>_<名>`（展示名剥前缀的规则不变）。以前按毫秒拼名直接覆盖写：一方的 guest 能读到另一方的文件（T22 adv1 P1-1）。
 * 返回落盘的绝对路径；db 拿不到也照样写，只是没账。
 */
export async function saveUpload(dir: string, name: string, data: Uint8Array, agent: string, db: Database | null): Promise<string> {
  await mkdir(dir, { recursive: true });
  const base = name.replace(/[^\w.\-]/g, "_");
  const ms = Date.now();
  for (let i = 0; i < 20; i++) {
    const file = `api_${ms}${i ? String(Math.floor(Math.random() * 1e6)).padStart(6, "0") : ""}_${base}`;
    const dest = join(dir, file);
    let fh;
    try {
      fh = await open(dest, "wx");
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "EEXIST") continue;
      throw e;
    }
    try {
      await fh.writeFile(data);
    } catch (e) {
      await unlink(dest).catch((u) => console.error(`上传写入失败后清理 ${dest} 失败:`, (u as Error).message));
      throw e;
    } finally {
      await fh.close();
    }
    recordOwner(db, file, agent, UPLOAD_SRC, ms);
    return dest;
  }
  throw new Error(`no free upload name for ${base}`);
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
      const dest = await copyToFreeName(p, inboxDir, base);
      out.push({ name: base, attachment: dest });
      recordOwner(db, dest, agent, p.trim(), Number(dest.split("_")[0]));
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

/** 这个 inbox 文件在账上属于别的 agent（老数据按名字猜时要排除掉；入站行指向它就不可信） */
export function ownedByOther(db: Database, agent: string, dest: string): boolean {
  const row = db.prepare("SELECT agent FROM out_copies WHERE dest = ?").get(dest) as { agent: string } | null;
  return !!row && row.agent !== agent;
}
