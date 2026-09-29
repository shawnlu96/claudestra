/** bridge 已监听后迁移存量：先 project，再 Codex ACP；升级前旧 bridge 不会收到 ACP 宿主。 */
export function startStartupMigrations(runManager: (...args: string[]) => Promise<any>): void {
  setTimeout(() => void runStartupMigrations(runManager), 3_000);
}

export async function runStartupMigrations(runManager: (...args: string[]) => Promise<any>): Promise<void> {
  try {
    const r = await runManager("project-migrate");
    if (r?.ok && r.migrated > 0) console.log(`📁 project 迁移: ${r.migrated} 个 agent 已按目录归组`);
    else if (r?.ok === false) console.error(`[startup] project 迁移失败: ${r.error ?? "未知原因"}`);
  } catch (e) { console.error(`[startup] project 迁移异常: ${String(e)}`); }
  try {
    const r = await runManager("migrate", "--startup");
    if (r?.changed?.length || r?.fellBack?.length) console.log(`[startup] Codex ACP 迁移: ${r.changed?.length ?? 0} 个改动, ${r.fellBack?.length ?? 0} 个暂退 tmux`);
    if (r?.ok === false) console.error(`[startup] Codex ACP 迁移失败: ${(r.failed ?? []).join(", ") || r.error || "未知原因"}`);
  } catch (e) { console.error(`[startup] Codex ACP 迁移异常: ${String(e)}`); }
}
