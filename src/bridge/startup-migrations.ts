/** bridge 已监听后迁移存量：先 project，再 Codex ACP；升级前旧 bridge 不会收到 ACP 宿主。 */
export function startStartupMigrations(runManager: (...args: string[]) => Promise<any>): void {
  setTimeout(() => void runStartupMigrations(runManager), 3_000);
  let running = false;
  setInterval(() => {
    if (running) return;
    running = true;
    void runManager("migrate", "--idle").then((r) => {
      if (r?.migrated?.length) console.log(`[startup] 空闲 Codex 已迁 ACP: ${r.migrated.join(", ")}`);
      if (r?.ok === false) console.warn(`[startup] 空闲迁移未完成: ${(r.failed ?? []).join(", ")}`);
    }).catch((e) => console.error(`[startup] 空闲迁移重试失败: ${String(e)}`)).finally(() => { running = false; });
  }, 30_000).unref();
}

export async function runStartupMigrations(
  runManager: (...args: string[]) => Promise<any>, warn: (message: string) => void = console.warn,
): Promise<void> {
  try {
    const r = await runManager("project-migrate");
    if (r?.ok && r.migrated > 0) console.log(`📁 project 迁移: ${r.migrated} 个 agent 已按目录归组`);
    else if (r?.ok === false) console.error(`[startup] project 迁移失败: ${r.error ?? "未知原因"}`);
  } catch (e) { console.error(`[startup] project 迁移异常: ${String(e)}`); }
  try {
    const r = await runManager("migrate", "--startup");
    if (r?.changed?.length || r?.fellBack?.length) console.log(`[startup] Codex ACP 迁移: ${r.changed?.length ?? 0} 个改动, ${r.fellBack?.length ?? 0} 个暂退 tmux`);
    if (r?.pending?.length) warn(`[startup] Codex ACP 待迁移（活跃会话未打断）: ${r.pending.join(", ")}；回合结束后自动重试；也可空闲后执行 manager migrate --acp`);
    if (r?.ok === false) console.error(`[startup] Codex ACP 迁移失败: ${(r.failed ?? []).join(", ") || r.error || "未知原因"}`);
  } catch (e) { console.error(`[startup] Codex ACP 迁移异常: ${String(e)}`); }
}
