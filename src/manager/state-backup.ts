/** `state-backup list | now | restore <时间戳> [文件名…]`：关键状态文件的快照（逻辑在 lib/state-backup.ts，bridge 每小时自动做一份） */
import { BACKUP_FILES, listSnapshots, restoreLocked, takeSnapshot } from "../lib/state-backup.js";
import { LEND_WORKER_MARK } from "../lib/runtimes/clean-env.js";
import { output } from "./core.js";

const USAGE = `usage: state-backup list | now | restore <时间戳> [文件名…]（文件名只能是 ${BACKUP_FILES.join(" ")}）`;

export async function cmdStateBackup(args: string[]): Promise<void> {
  const [sub, ...rest] = args;
  if (sub === "list") return output({ ok: true, snapshots: listSnapshots() });
  if (sub === "now") {
    const r = takeSnapshot();
    return output({ ok: true, ...r, message: r.created ? `已快照 ${r.ts}：${r.files.join(" ")}` : r.ts ? `和上一份 ${r.ts} 一样，没新建` : "没有可快照的文件" });
  }
  if (sub !== "restore" || !rest[0]) return output({ ok: false, error: USAGE });
  // 恢复旧的 principals 会让之后撤销的令牌重新生效：外来出借任务不许顺手做
  if (process.env[LEND_WORKER_MARK]) return output({ ok: false, error: "出借 worker 不能恢复状态文件" });
  const r = await restoreLocked(rest[0], rest.slice(1));
  if (!r.ok) return output(r);
  output({
    ...r,
    message: `已从 ${rest[0]} 恢复：${r.restored.join(" ")}。恢复前的文件另存在 ${r.safetyTs ?? "（当时一个都没有，没另存）"}。` +
      (r.restored.includes("principals.json") ? "principals 是快照时刻的内容：之后撤销的设备 / 令牌会重新生效，去 设置 · 设备 核对一遍。" : ""),
  });
}
