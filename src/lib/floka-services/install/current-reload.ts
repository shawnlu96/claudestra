/**
 * SVCRELOAD1 · install-cli/update after a committed switch to the new family: reload only that family's already-loaded jobs.
 * No CLI/plist rewrite, no migration step, no new grant; the old family is never started and no job is bootstrapped.
 * Proof = services-current {side:"new"} + the snapshot, a terminal forward journal and committed.json of the same plan,
 * live under services/ or exactly one retired-<id>/. A running journal, missing/bad-checksum files, a rollback, a CLI-only
 * snapshot, an id/side mismatch or a still-loaded old label refuse and keep the gate's result.
 * Recovery key serviceCurrentReload (default on): off = the gate's result as before; observe = the same result plus one
 * recovery_observe sample per plan id + code version (labels and counts only). The mode is reread under the lock right
 * before acting. Rollback: `ledger scheduler-recovery claude-orchestrator off --key serviceCurrentReload --reason ...`.
 * tests/floka-services-current-reload.test.ts.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { CONFIG_PATH, RUNTIME_DIR, STATE_DIR } from "../../paths.js";
import { readJsonStateSync } from "../../state-file.js";
import { openLedger } from "../../ledger-store.js";
import { recordObserved, recoveryPolicy, type ObservedAction, type RecoveryMode } from "../../recovery-policy.js";
import { REPO_ROOT } from "../../repo-root.js";
import { prepareMaintenanceRoot } from "../../state-maintenance/paths.js";
import { takeExecutorLock } from "../../state-maintenance/run-store.js";
import { object, renameMode } from "../../floka-config/values.js";
import type { InstallCliResult } from "../../cli-install.js";
import type { Journal, ServicePlan } from "../plan/types.js";
import { realRun } from "./host.js";
import { digest, readStored, type Snapshot } from "./store.js";

const SERVICE_CURRENT_RELOAD_KEY = "serviceCurrentReload" as const;
const PROJECT = "claude-orchestrator";
const PART = /^[\w.:@/-]{1,60}$/;

/** Fake in tests. loaded: null = unknown (never absence). reload: null = done, otherwise the failure. */
export interface ServiceManager {
  loaded(label: string): Promise<boolean | null>;
  reload(label: string): Promise<string | null>;
}
export interface ReloadPorts {
  configPath: string;
  root: string;
  /** serviceCurrentReload's effective mode, read on every call. */
  mode(): RecoveryMode;
  lock(): { release(): void } | { error: string };
  manager(): ServiceManager;
  observe(a: ObservedAction): void;
  /** Code version the update installs; part of the observe dedup key. */
  version(): string;
}

export type CurrentProof = { ok: true; plan: ServicePlan; home: string; digest: string } | { ok: false; error: string };

function renameModes(configPath: string): { services: string; cli: string } {
  const raw = readJsonStateSync(configPath);
  const rename = object(object(raw.status === "ok" ? raw.data : {}).rename);
  return { services: renameMode(rename.services), cli: renameMode(rename.cli) };
}

/** cli on, no observe, committed side new. Anything else stays with the gate's result (old family keeps its contract). */
function eligible(configPath: string, root: string): boolean {
  const m = renameModes(configPath);
  if (m.cli !== "on" || m.services === "observe") return false;
  try { return readStored<{ side: string }>(join(root, "services-current.json"))?.side === "new"; } catch { return true; }
}

function family(dir: string): { snapshot: Snapshot | null; journal: Journal | null; committed: { id?: string; side?: string } | null } {
  return { snapshot: readStored<Snapshot>(join(dir, "active.json")), journal: readStored<Journal>(join(dir, "journal.json")),
    committed: readStored(join(dir, "committed.json")) };
}
function check(f: ReturnType<typeof family>): string | null {
  const { snapshot: s, journal: j, committed: c } = f;
  if (!s) return "缺少服务快照";
  if (!j) return "缺少服务日志";
  if (j.status === "running") return "服务事务 active 未结清";
  if (j.status !== "committed" || j.direction !== "forward") return "服务事务终态不是新族提交";
  if (s.cliOnly) return "快照只切了 CLI，与当前族 new 冲突";
  if (j.planKey !== JSON.stringify(s.plan) || j.snapshot && digest(j.snapshot) !== digest(s.plan)) return "服务日志与快照不一致";
  if (!c || c.id !== s.plan.id || c.side !== "new") return "提交凭据与快照不一致";
  if (!s.plan.services.length) return "快照没有服务";
  return null;
}

/** Validate the committed current family. Never throws: unreadable or conflicting proof is a refusal. */
export function readCurrentProof(root: string): CurrentProof {
  try {
    if (readStored<{ side: string }>(join(root, "services-current.json"))?.side !== "new") return { ok: false, error: "当前族不是 new" };
    const live = join(root, "services");
    let chosen: ReturnType<typeof family> | null = null;
    if (readdirSync(root).includes("services")) {
      chosen = family(live);
      const bad = check(chosen);
      if (bad) return { ok: false, error: bad };
    } else {
      const retired = readdirSync(root).filter(n => n.startsWith("retired-")).map(n => family(join(root, n)))
        .filter(f => check(f) === null);
      if (retired.length !== 1) return { ok: false, error: retired.length ? "多个已退役的新族提交，无法确定当前族" : "缺少新族提交证明" };
      chosen = retired[0]!;
    }
    const s = chosen.snapshot!;
    return { ok: true, plan: s.plan, home: s.input.home, digest: digest([s.plan, chosen.journal, chosen.committed]) };
  } catch (e) {
    return { ok: false, error: `证明读不了：${e instanceof Error ? e.message : String(e)}` };
  }
}

const refused = (gate: InstallCliResult, why: string): InstallCliResult =>
  ({ ...gate, errors: [`当前族重载已拒绝：${why}；未重载任何服务`, ...gate.errors] });

function observeSample(p: ReloadPorts, proof: CurrentProof): void {
  const target = proof.ok && PART.test(proof.plan.id) ? proof.plan.id : "services-current";
  const version = PART.test(p.version()) ? p.version() : "unknown";
  const action = proof.ok ? `重载当前族 ${proof.plan.services.length} 个服务（${proof.plan.services.map(s => s.newLabel).join(", ")}）`
    : "拒绝重载当前族（证明不成立）";
  try {
    p.observe({ project: PROJECT, mechanism: SERVICE_CURRENT_RELOAD_KEY, target, actionKey: `reload:${version}:${proof.ok ? "act" : "refuse"}`,
      action, data: { services: proof.ok ? proof.plan.services.length : 0 } });
  } catch (e) { console.error(`[serviceCurrentReload] observe 记录失败（结果不变）：${(e as Error).message}`); }
}

/**
 * Called with the gate's non-null result. Returns that result unchanged unless the current family is new and committed,
 * cli is on and the key is on; then the outcome of reloading exactly the current family's loaded jobs.
 */
export async function reloadCurrentFamily(gate: InstallCliResult, p: ReloadPorts): Promise<InstallCliResult> {
  if (!eligible(p.configPath, p.root)) return gate;
  const mode = p.mode();
  if (mode === "off") return gate;
  const before = readCurrentProof(p.root);
  if (mode === "observe") { observeSample(p, before); return gate; }
  if (!before.ok) return refused(gate, before.error);
  const lock = p.lock();
  if ("error" in lock) return refused(gate, `${lock.error}；稍后重试 install-cli/update`);
  try {
    // Recheck everything under the shared maintenance lock: a switch, retirement or mode change may have landed meanwhile.
    if (!eligible(p.configPath, p.root)) return gate;
    const now = p.mode();
    if (now === "off") return gate;
    const proof = readCurrentProof(p.root);
    if (now === "observe") { observeSample(p, proof); return gate; }
    if (!proof.ok) return refused(gate, proof.error);
    if (proof.digest !== before.digest) return refused(gate, "取锁期间提交证明已变化；请重试");
    const manager = p.manager(), plan = proof.plan, home = proof.home;
    const state = await Promise.all(plan.services.map(async s => ({ s, old: await manager.loaded(s.oldLabel), cur: await manager.loaded(s.newLabel) })));
    const conflict = state.filter(x => x.old !== false).map(x => x.s.oldLabel);
    if (conflict.length) return refused(gate, `旧族服务仍在或状态未知：${conflict.join(", ")}`);
    const unknown = state.filter(x => x.cur === null).map(x => x.s.newLabel);
    if (unknown.length) return refused(gate, `当前族服务状态未知：${unknown.join(", ")}`);
    const daemons: InstallCliResult["daemons"] = [], errors: string[] = [];
    for (const { s, cur } of state) {
      const plistPath = join(home, "Library/LaunchAgents", `${s.newLabel}.plist`);
      if (!cur) {
        daemons.push({ label: s.newLabel, plistPath, loaded: false, warning: "未加载：本次只重载已有服务，不新增" });
        errors.push(`${s.newLabel} 未加载，未启动`);
        continue;
      }
      let failure: string | null;
      try { failure = await manager.reload(s.newLabel); } catch (e) { failure = e instanceof Error ? e.message : String(e); }
      daemons.push({ label: s.newLabel, plistPath, loaded: failure === null, ...(failure === null ? {} : { warning: failure }) });
      if (failure !== null) errors.push(`${s.newLabel} 重载失败：${failure}`);
    }
    return { ...gate, daemons, errors: errors.length ? [...errors, "当前族重载未全部成功；可重试 install-cli/update"] : [],
      warnings: [`当前族（new）只重载 ${daemons.filter(d => d.loaded).length}/${plan.services.length} 个已有服务；未重装 CLI/plist、未迁移`] };
  } catch (e) {
    return refused(gate, `重载出错：${e instanceof Error ? e.message : String(e)}`);
  } finally { lock.release(); }
}

function launchdManager(): ServiceManager {
  const domain = `gui/${process.getuid?.() ?? -1}`;
  return {
    loaded: async label => {
      const r = await realRun(["launchctl", "print", `${domain}/${label}`]);
      if (r.code === 0) return true;
      return r.code !== null && /could not find service|service not found/i.test(r.stderr) ? false : null;
    },
    reload: async label => {
      const r = await realRun(["launchctl", "kickstart", "-k", `${domain}/${label}`]);
      return r.code === 0 ? null : `launchctl kickstart 退出码 ${r.code ?? "超时"}`;
    },
  };
}

export function productionReloadPorts(root: string, configPath = CONFIG_PATH): ReloadPorts {
  return {
    configPath, root,
    mode: () => recoveryPolicy(PROJECT, SERVICE_CURRENT_RELOAD_KEY).mode,
    lock: () => { prepareMaintenanceRoot(root, [STATE_DIR, RUNTIME_DIR]); return takeExecutorLock(root); },
    manager: () => launchdManager(),
    observe: a => { recordObserved(openLedger(), a, Date.now()); },
    version: () => {
      try { return String(JSON.parse(readFileSync(join(REPO_ROOT, "package.json"), "utf8")).version); } catch { return "unknown"; }
    },
  };
}
