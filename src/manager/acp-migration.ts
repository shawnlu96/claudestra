/** Codex 迁移：启动时保住活跃旧回合；人工迁移才重启活跃 agent。 */
import { checkAcpReady } from "../lib/acp/readiness.js";
import { deferActiveCodexMigration, migrateCodexTransports, type MigratingAgent } from "../lib/acp/migration.js";
import { resolveBunPath } from "../lib/bun-path.js";
import { acquireLock } from "../lib/file-lock.js";
import { statePath } from "../lib/paths.js";
import { SRC_DIR } from "../lib/repo-root.js";
import { runManagerProcess } from "../lib/run-manager.js";
import { isSandbox } from "../lib/sandbox.js";
import { loadRegistry, migrateWorkerToAgent, output, patchRegistryAgent, saveRegistry } from "./core.js";

const RESTART_TIMEOUT_MS = 240_000;

export async function cmdMigrate(mode?: string, name?: string): Promise<void> {
  if (mode === "--launch-idle") return output(await (await import("./acp-idle-launch.js")).launchIdleAcp(name ?? ""));
  if (mode === "--idle") {
    const r = await (await import("./acp-idle-migration.js")).migrateIdleCodex((name) => runManagerProcess(["migrate", "--launch-idle", name], {
      bunPath: resolveBunPath(), managerPath: `${SRC_DIR}/manager.ts`, timeoutMs: RESTART_TIMEOUT_MS,
    }));
    output({ ok: r.failed.length === 0, ...r });
    return;
  }
  const r = await runMigrateMode(mode, migrateWorkersOnly, migrateAll);
  output(r);
  if ("failed" in r && r.failed.length) { console.error(`[migrate] Codex 重启失败：${r.failed.join(", ")}`); process.exitCode = 1; }
}

async function migrateWorkersOnly() {
  const lock = await acquireLock(statePath(".manager-write.lock"));
  if (!lock) throw new Error("migrate 写锁未拿到，跳过本轮而非并发改 registry");
  try { return await migrateWorkerToAgent(); }
  finally { lock.release(); }
}

export async function runMigrateMode(
  mode: string | undefined,
  worker: () => Promise<{ migrated: boolean; entries: number }>,
  acp: (automatic: boolean) => ReturnType<typeof migrateAll>,
) {
  if (mode !== "--acp" && mode !== "--startup") {
    return { ok: true, ...(await worker()) };
  }
  const r = await acp(mode === "--startup");
  return { ok: r.failed.length === 0, ...r };
}

export async function migrateAll(automatic = false) {
  const peek = await loadRegistry();
  const entries = { ...((peek as { workers?: Record<string, typeof peek.agents[string]> }).workers ?? {}), ...(peek.agents ?? {}) };
  const eligible = Object.values(entries).some((a) => a.runtime === "codex" &&
    ((a as MigratingAgent).transport !== "tmux" || (!automatic && (a as MigratingAgent).acpPending)));
  const ready = eligible ? await checkAcpReady(true) : { ok: false as const, reason: "没有待迁移的 Codex agent" };
  const lock = await acquireLock(statePath(".manager-write.lock"));
  if (!lock) throw new Error("ACP 迁移写锁未拿到，跳过本轮而非并发改 registry");
  let worker: Awaited<ReturnType<typeof migrateWorkerToAgent>>;
  let changed: string[] = [];
  let pending: string[] = [];
  let restart: string[] = [];
  let reason: string | undefined;
  let targets = new Map<string, string>();
  try {
    worker = await migrateWorkerToAgent();
    const reg = await loadRegistry();
    const agents = reg.agents as Record<string, MigratingAgent>;
    const deferred = automatic ? deferActiveCodexMigration(agents) : { changed: [], pending: [] };
    changed = deferred.changed;
    pending = deferred.pending;
    const candidates = Object.values(agents).some((a) => a.runtime === "codex" && (a.transport !== "tmux" || (!automatic && a.acpPending)));
    if (candidates && eligible) {
      if (!ready.ok) reason = ready.reason;
      const planned = migrateCodexTransports(agents, ready, !automatic);
      changed.push(...planned.changed);
      pending.push(...planned.pending);
      restart = planned.restart;
      targets = new Map(restart.map((name) => [name, agents[name]!.transport!]));
    }
    if (changed.length) await saveRegistry(reg);
  } finally {
    lock.release();
  }
  const results = await restartMigrated(targets, (name) => runManagerProcess(["restart", "--", name], {
    bunPath: resolveBunPath(), managerPath: `${SRC_DIR}/manager.ts`, timeoutMs: RESTART_TIMEOUT_MS,
  }), patchRegistryAgent);
  return { ...worker, changed, pending, ...results, ...(reason ? { fallbackReason: reason } : {}) };
}

/** ACP 接旧线程失败时自动再起 tmux；第二次还失败才留待重启标记。 */
export async function restartMigrated(
  targets: Map<string, string>, run: (name: string) => Promise<any>, patch: typeof patchRegistryAgent,
): Promise<{ restarted: string[]; fellBack: string[]; failed: string[] }> {
  const restarted: string[] = [], fellBack: string[] = [], failed: string[] = [];
  const safeRun = async (name: string) => {
    try { return await run(name); }
    catch (e) {
      console.error(`[migrate] ${name} 的 restart 子进程异常: ${String(e)}`);
      return { ok: false, error: String(e) };
    }
  };
  for (const name of targets.keys()) {
    let r = await safeRun(name);
    let bad = r?.ok === false || (Array.isArray(r?.results) && r.results.some((x: { ok?: boolean }) => x.ok === false));
    if (bad && targets.get(name) === "acp" && !isSandbox()) {
      // 旧线程若被适配器拒绝，不能把升级前能用的 tmux 窗口留成死窗口；先回退，再记录待迁移供重试。
      await patch(name, (a) => {
        const state = a as MigratingAgent;
        if (state.transport === "acp") { state.transport = "tmux"; state.acpPending = true; state.acpRestartFrom = "acp"; }
      });
      targets.set(name, "tmux");
      r = await safeRun(name);
      bad = r?.ok === false || (Array.isArray(r?.results) && r.results.some((x: { ok?: boolean }) => x.ok === false));
      if (!bad) fellBack.push(name);
    }
    if (bad) { failed.push(name); continue; }
    restarted.push(name);
    let actual: string | undefined;
    await patch(name, (a) => {
      const state = a as MigratingAgent;
      actual = state.transport;
      if (state.transport === targets.get(name)) { delete state.acpRestartPending; delete state.acpRestartFrom; }
    });
    if (targets.get(name) === "acp" && actual === "tmux" && !fellBack.includes(name)) fellBack.push(name);
  }
  return { restarted, fellBack, failed };
}
