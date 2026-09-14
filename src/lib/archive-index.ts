/**
 * 归档台账（v2.23+）—— 「归档」栏的唯一数据源。
 *
 * 为什么不能直接列归档目录（owner 2026-09-14「归档列表里要我们自己手动加入的，
 * 才是归档啊」）：`~/.claude-orchestrator/archive/` 是大杂烩 —— 每日兜底会给
 * **每个在跑的 agent** 做安全快照、退役（kill / fork / adopt）也会自动快照。
 * 那些是防丢机制，不是"用户归档过的"。所以另起一份**只记手动归档动作**的台账：
 * 网页上点「归档」才写一条，列表只读它。
 *
 * 存储：~/.claude-orchestrator/archived.json（0600 语义同 peers/principals，
 * 文件小、写少读多；读失败一律当空台账，绝不因为台账坏了让功能不可用）。
 */
import { existsSync } from "node:fs";
import { readFile, writeFile, rename } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

export const ARCHIVE_INDEX_PATH = join(
  homedir(),
  ".claude-orchestrator",
  "archived.json",
);

export interface ArchivedItem {
  /** agent = 归档并停掉一个纳管 agent；unmanaged = 归档一个未纳管会话 */
  kind: "agent" | "unmanaged";
  /** agent 名（含 agent- 前缀）或会话 id */
  id: string;
  /** 归档时它的会话 id(s)，用于恢复/查看历史 */
  sessionIds: string[];
  archivedAt: number;
  /** 归档时的备注（例如 "kill + registry 保留"） */
  note?: string;
}

function asArray(v: unknown): ArchivedItem[] {
  if (!Array.isArray(v)) return [];
  return v.filter(
    (e): e is ArchivedItem =>
      !!e && typeof e === "object" && ((e as ArchivedItem).kind === "agent" || (e as ArchivedItem).kind === "unmanaged") &&
      typeof (e as ArchivedItem).id === "string",
  );
}

export async function readArchiveIndex(): Promise<ArchivedItem[]> {
  if (!existsSync(ARCHIVE_INDEX_PATH)) return [];
  try {
    return asArray(JSON.parse(await readFile(ARCHIVE_INDEX_PATH, "utf8")));
  } catch {
    return [];
  }
}

async function writeIndex(items: ArchivedItem[]): Promise<void> {
  const tmp = `${ARCHIVE_INDEX_PATH}.${process.pid}.tmp`;
  await writeFile(tmp, JSON.stringify(items, null, 2), { mode: 0o600 });
  await rename(tmp, ARCHIVE_INDEX_PATH);
}

/** 追加一条（同 kind+id 覆盖旧记录，避免反复归档堆重复条目） */
export async function addArchivedItem(item: ArchivedItem): Promise<ArchivedItem[]> {
  const cur = (await readArchiveIndex()).filter(
    (e) => !(e.kind === item.kind && e.id === item.id),
  );
  const next = [item, ...cur];
  await writeIndex(next);
  return next;
}

/** 从台账移除（删除归档条目用）；不存在则无操作 */
export async function removeArchivedItem(kind: string, id: string): Promise<ArchivedItem[]> {
  const next = (await readArchiveIndex()).filter((e) => !(e.kind === kind && e.id === id));
  await writeIndex(next);
  return next;
}
