/**
 * codex-sub-archive status|on|off：Codex 子线程自动归档开关（config.json autoArchiveCodexSubs，缺省关）。
 * 只改配置，归档本身在 bridge 的每日归档扫描里做（bridge/archive-sweeper.ts → lib/unmanaged-archive.ts）。
 */
import { output } from "./core.js";

export async function cmdCodexSubArchive(args: string[]): Promise<void> {
  const { readConfig, setAutoArchiveCodexSubs, DEFAULT_ARCHIVE_RETENTION_DAYS } = await import("../lib/config-store.js");
  const { CODEX_SUB_IDLE_DAYS } = await import("../lib/unmanaged-archive.js");
  const sub = (args[0] ?? "status").toLowerCase();
  if (sub !== "on" && sub !== "off" && sub !== "status" && sub !== "get") {
    output({ ok: false, error: "usage: codex-sub-archive status|on|off" });
    return;
  }
  const cfg = sub === "on" || sub === "off" ? await setAutoArchiveCodexSubs(sub === "on") : await readConfig();
  const enabled = cfg.autoArchiveCodexSubs === true;
  const days = cfg.archiveRetentionDays ?? DEFAULT_ARCHIVE_RETENTION_DAYS;
  const prune = days > 0 ? `归档区里的文件满 ${days} 天会被删除（归档保留期）` : "归档保留期是 0，归档区不会自动删除";
  output({
    ok: true,
    enabled,
    idleDays: CODEX_SUB_IDLE_DAYS,
    retentionDays: days,
    message: enabled
      ? `Codex 子线程自动归档：开。每日扫描把 ${CODEX_SUB_IDLE_DAYS} 天没写的子线程收进 archive/archived/（可在网页「归档」里恢复）；${prune}`
      : "Codex 子线程自动归档：关（缺省）。子线程留在 ~/.codex/sessions，不会被移动或删除",
  });
}
