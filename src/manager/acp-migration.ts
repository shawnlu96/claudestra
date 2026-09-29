/** update 的 Codex 迁移：短锁改 registry，放锁后逐个 restart；失败留标记供重跑。 */
import { checkAcpReady } from "../lib/acp/readiness.js";
import { migrateCodexTransports, type MigratingAgent } from "../lib/acp/migration.js";
import { resolveBunPath } from "../lib/bun-path.js";
import { acquireLock } from "../lib/file-lock.js";
import { statePath } from "../lib/paths.js";
import { SRC_DIR } from "../lib/repo-root.js";
import { runManagerProcess } from "../lib/run-manager.js";
import { isSandbox } from "../lib/sandbox.js";
import { loadRegistry, migrateWorkerToAgent, output, patchRegistryAgent, saveRegistry } from "./core.js";

const RESTART_TIMEOUT_MS = 240_000;

export async function cmdMigrate(mode?: string): Promise<void> {
  if (mode === "--pre-reload") {
    const lock = await acquireLock(statePath(".manager-write.lock"));
    try { return output({ ok: true, ...(await migrateWorkerToAgent()) }); }
    finally { lock?.release(); }
  }
  const r = await migrateAll(mode === "--startup");
  output({ ok: r.failed.length === 0, ...r });
  if (r.failed.length) { console.error(`[migrate] Codex 重启失败：${r.failed.join(", ")}`); process.exitCode = 1; }
}

export async function migrateAll(automatic = false) {
  const peek = await loadRegistry();
  const entries = { ...((peek as { workers?: Record<string, typeof peek.agents[string]> }).workers ?? {}), ...(peek.agents ?? {}) };
  const eligible = Object.values(entries).some((a) => a.runtime === "codex" &&
    ((a as MigratingAgent).transport !== "tmux" || (!automatic && (a as MigratingAgent).acpPending)));
  const ready = eligible ? await checkAcpReady(true) : { ok: false as const, reason: "没有待迁移的 Codex agent" };
  const lock = await acquireLock(statePath(".manager-write.lock"));
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
    const candidates = Object.values(agents).some((a) => a.runtime === "codex" && (a.transport !== "tmux" || (!automatic && a.acpPending)));
    if (candidates && eligible) {
      if (!ready.ok) reason = ready.reason;
      ({ changed, pending, restart } = migrateCodexTransports(agents, ready, !automatic));
      if (changed.length) await saveRegistry(reg);
      targets = new Map(restart.map((name) => [name, agents[name]!.transport!]));
    }
  } finally {
    lock?.release();
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
  for (const name of targets.keys()) {
    let r = await run(name);
    let bad = r?.ok === false || (Array.isArray(r?.results) && r.results.some((x: { ok?: boolean }) => x.ok === false));
    if (bad && targets.get(name) === "acp" && !isSandbox()) {
      // 旧线程若被适配器拒绝，不能把升级前能用的 tmux 窗口留成死窗口；先回退，再记录待迁移供重试。
      await patch(name, (a) => {
        const state = a as MigratingAgent;
        if (state.transport === "acp") { state.transport = "tmux"; state.acpPending = true; state.acpRestartFrom = "acp"; }
      });
      targets.set(name, "tmux");
      r = await run(name);
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
