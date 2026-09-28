/**
 * talk 附件：落盘前剥元数据（image-meta-strip.ts），按剥完之后的 sha256 存成 `<dir>/<sha256>.<扩展名>`，同一张图只存一份。
 * 带扩展名是给 agent 用的：丢进工作台时正文里写的是这个路径，Claude Code 的 Read 按扩展名认图片。
 * 谁能取：上传者本人；或引用它的消息所在房间的成员；或引用它的 ask 能看到的人（human 节点交付附图，判定由调用方注入）。
 * 没人引用的上传（选了图没发）只有上传者能取，最后一次上传满 24 小时后被 sweepOrphanAtts 清掉。
 */
import type { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { stripImageMeta, type ImageMime } from "./image-meta-strip.js";
import { isMember } from "./talk-rooms.js";

/** 单张原图上限（剥之前）；二期跨实例另有更小的上限 */
export const ATT_MAX_BYTES = 8 * 1024 * 1024;
export const ORPHAN_TTL_MS = 24 * 3_600_000;

export interface StoredAtt {
  sha256: string;
  mime: ImageMime;
  bytes: number;
}

const EXT: Record<ImageMime, string> = { "image/png": ".png", "image/jpeg": ".jpg", "image/webp": ".webp" };
export const attPath = (dir: string, a: Pick<StoredAtt, "sha256" | "mime">): string => join(dir, `${a.sha256}${EXT[a.mime]}`);

export type SaveAttResult = { ok: true; att: StoredAtt } | { ok: false; code: "too_large" | "unsupported" | "corrupt" };

export function saveAtt(db: Database, dir: string, input: Uint8Array, uploaderKey: string, now = Date.now()): SaveAttResult {
  if (input.length > ATT_MAX_BYTES) return { ok: false, code: "too_large" };
  const r = stripImageMeta(input);
  if (!r.ok) return { ok: false, code: r.reason };
  const sha256 = createHash("sha256").update(r.data).digest("hex");
  const path = attPath(dir, { sha256, mime: r.mime });
  if (!existsSync(path)) {
    mkdirSync(dir, { recursive: true });
    const tmp = `${path}.${process.pid}.tmp`;
    writeFileSync(tmp, r.data, { mode: 0o600 });
    renameSync(tmp, path);
  }
  db.transaction(() => {
    db.prepare("INSERT OR IGNORE INTO atts (sha256, mime, bytes, createdAt) VALUES (?, ?, ?, ?)").run(sha256, r.mime, r.data.length, now);
    db.prepare("INSERT INTO att_uploads (sha256, uploader, createdAt) VALUES (?, ?, ?) ON CONFLICT DO UPDATE SET createdAt = excluded.createdAt").run(sha256, uploaderKey, now);
  }).immediate();
  return { ok: true, att: { sha256, mime: r.mime, bytes: r.data.length } };
}

export function getAtt(db: Database, sha256: string): StoredAtt | null {
  return db.prepare("SELECT sha256, mime, bytes FROM atts WHERE sha256 = ?").get(sha256) as StoredAtt | null;
}

/** 发消息前核对：每张图都已上传过，且上传者是发送者本人或它已在发送者能看的地方被引用过（不能拿别人的 sha 顶替） */
export function attsUsableBy(db: Database, shas: readonly string[], keys: readonly string[], canSeeAsk: (askId: string) => boolean): boolean {
  return shas.every((sha) => canReadAtt(db, sha, keys, canSeeAsk));
}

export function canReadAtt(db: Database, sha256: string, keys: readonly string[], canSeeAsk: (askId: string) => boolean): boolean {
  if (!getAtt(db, sha256)) return false;
  const marks = keys.map(() => "?").join(",");
  if (keys.length && db.prepare(`SELECT 1 FROM att_uploads WHERE sha256 = ? AND uploader IN (${marks}) LIMIT 1`).get(sha256, ...keys)) return true;
  const refs = db.prepare("SELECT refKind, refId FROM att_refs WHERE sha256 = ?").all(sha256) as { refKind: string; refId: string }[];
  for (const r of refs) {
    if (r.refKind === "ask" && canSeeAsk(r.refId)) return true;
    if (r.refKind !== "msg") continue;
    const slash = r.refId.indexOf("/");
    const m = db.prepare("SELECT roomFp, roomId FROM messages WHERE origin = ? AND id = ?").get(r.refId.slice(0, slash), r.refId.slice(slash + 1)) as { roomFp: string; roomId: string } | null;
    if (m && isMember(db, { creatorFp: m.roomFp, id: m.roomId }, keys)) return true;
  }
  return false;
}

/** 把附件挂到一个 ask 上（human 节点交付附图） */
export function refAttsFromAsk(db: Database, shas: readonly string[], askId: string): void {
  const ins = db.prepare("INSERT OR IGNORE INTO att_refs (sha256, refKind, refId) VALUES (?, 'ask', ?)");
  for (const sha of shas) ins.run(sha, askId);
}

/** 删掉没人引用的附件（行 + 文件）；还有引用的跳过 */
export function removeUnreferenced(db: Database, dir: string, shas: readonly string[]): number {
  let n = 0;
  for (const sha of shas) {
    const att = getAtt(db, sha);
    if (!att || db.prepare("SELECT 1 FROM att_refs WHERE sha256 = ? LIMIT 1").get(sha)) continue;
    db.prepare("DELETE FROM att_uploads WHERE sha256 = ?").run(sha);
    db.prepare("DELETE FROM atts WHERE sha256 = ?").run(sha);
    rmSync(attPath(dir, att), { force: true });
    n++;
  }
  return n;
}

/** 上传了却一直没被引用的（选了图没发），过了 24 小时清掉 */
export function sweepOrphanAtts(db: Database, dir: string, now = Date.now()): number {
  const rows = db.prepare(
    "SELECT sha256 FROM atts a WHERE NOT EXISTS (SELECT 1 FROM att_refs r WHERE r.sha256 = a.sha256) AND NOT EXISTS (SELECT 1 FROM att_uploads u WHERE u.sha256 = a.sha256 AND u.createdAt >= ?)",
  ).all(now - ORPHAN_TTL_MS) as { sha256: string }[];
  return removeUnreferenced(db, dir, rows.map((r) => r.sha256));
}
