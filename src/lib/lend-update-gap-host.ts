/**
 * Production ports of the lender update gap (lend-update-gap.ts): the CFG updateGap read for this host, the "has the checkout
 * reached the target" probe, manager update's completion record (update-inflight marker judged by its own updateVerdict) and
 * the launcher's thin calls. The policy project is the registered project whose dirs hold this
 * checkout (REPO_ROOT, real paths), never an order's project or a worker cwd: one gap drains every project's orders.
 * CFG's reader is loaded from its frozen location (recovery-materials-wiring cfgReaderPath) on every read; a missing project,
 * a missing / broken reader or any answer that is not a plain configured mode observes with a diagnostic (PM ruling UPDW).
 * tests/lend-update-gap-host.test.ts.
 */
import type { Database } from "bun:sqlite";
import { existsSync, readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { getLocalVersion, isNewer } from "./github-release.js";
import { LEND_JOURNAL_PATH, openLendJournal } from "./lend-journal.js";
import {
  gapAwaitsLauncher, launcherBeginUpdate, launcherGapStep, launcherUpdateExited, type GapMode, type GapPolicy, type GapPort, type LauncherGo, type UpdateState,
  type UpdateTarget,
} from "./lend-update-gap.js";
import { UPDATE_LOCK } from "./paths.js";
import { pidAlive } from "./pending-ops.js";
import { readProjects, resolveProjectForRealDir } from "./projects.js";
import { cfgReaderPath } from "./recovery-materials-wiring.js";
import { REPO_ROOT } from "./repo-root.js";
import { launchdStartedAt, readUpdateMarker, UPDATE_ABANDONED, UPDATE_INFLIGHT, updateVerdict, type DaemonState } from "./update-inflight.js";

export const GAP_MECHANISM = "updateGap";
const MODES: readonly unknown[] = ["on", "observe", "off"];
const observe = (diag: string) => ({ mode: "observe" as GapMode, diag });

export interface GapPolicyDeps { projectsPath?: string; repoRoot?: string; reader?: string }

/** CFG's recoveryPolicy(project, "updateGap") for the project owning this checkout; anything unreadable observes. */
export function gapPolicyPort(o: GapPolicyDeps = {}): GapPolicy {
  return async () => {
    let project: string | undefined;
    try {
      project = resolveProjectForRealDir((await readProjects(o.projectsPath)).projects, o.repoRoot ?? REPO_ROOT)?.id;
    } catch (e) { return observe(`projects.json 读不了（${(e as Error).message.slice(0, 120)}）`); }
    if (!project) return observe(`本机仓库 ${o.repoRoot ?? REPO_ROOT} 不属于任何已登记项目`);
    const at = o.reader ?? cfgReaderPath();
    if (!existsSync(at)) return observe(`CFG 读取未安装（${at}）`);
    try {
      const fn = ((await import(pathToFileURL(at).href)) as Record<string, unknown>).recoveryPolicy;
      if (typeof fn !== "function") return observe("CFG 模块没有导出 recoveryPolicy");
      const p = (fn as (project: string, mechanism: string) => unknown)(project, GAP_MECHANISM) as { mode?: unknown; source?: unknown; diagnostic?: unknown } | null;
      if (!p || !MODES.includes(p.mode)) return observe(`项目 ${project} 的 ${GAP_MECHANISM} 策略值不认识`);
      if (p.source === "error") return observe(`项目 ${project} 的 ${GAP_MECHANISM} 读失败：${String(p.diagnostic ?? "").slice(0, 160)}`);
      return { mode: p.mode as GapMode };
    } catch (e) { return observe(`CFG 读 ${GAP_MECHANISM} 失败：${(e as Error).message.slice(0, 160)}`); }
  };
}

async function git(repo: string, ...args: string[]): Promise<number | null> {
  return (await gitOut(repo, ...args))?.code ?? null;
}

async function gitOut(repo: string, ...args: string[]): Promise<{ code: number; out: string } | null> {
  try {
    const p = Bun.spawn(["git", "-C", repo, ...args], { stdout: "pipe", stderr: "ignore" });
    const [code, out] = await Promise.all([p.exited, new Response(p.stdout).text()]);
    return { code, out: out.trim() };
  } catch { return null; /* git not runnable: "cannot tell", the gap waits and the caller words it as unverifiable */ }
}

/** release: package.json is not older than the tag; beta: the target commit is HEAD or an ancestor of it. */
export async function reachedTarget(t: UpdateTarget, repo = REPO_ROOT, local = getLocalVersion): Promise<boolean | null> {
  if (t.channel === "release") {
    try { return !isNewer(t.ref, await local()); } catch { return null; /* unreadable package.json: cannot tell */ }
  }
  const code = await git(repo, "merge-base", "--is-ancestor", t.ref, "HEAD");
  return code === 0 ? true : code === 1 ? false : null;
}

export interface UpdateStateDeps {
  marker?: string; abandoned?: string; lock?: string; repo?: string; now?: () => number; alive?: (pid: number) => boolean;
  daemonStarts?: () => Promise<Record<string, DaemonState>>;
}

async function launchdStarts(): Promise<Record<string, DaemonState>> {
  const { DAEMONS } = await import("./cli-wrapper.js");
  return Object.fromEntries(DAEMONS.map((x) => [x.label, launchdStartedAt(x.label)]));
}

/**
 * manager update's completion record, judged the way its own resume (update.ts resumeUpdate) judges it: a live update.lock
 * holder = running; an in-flight marker goes through updateVerdict (live / clear = done / finish-* = tail owed / report =
 * cannot be finished); an abandoned marker for this target = given up on. Unreadable marker or HEAD = unknown, never none.
 */
export async function updateState(t: UpdateTarget, o: UpdateStateDeps = {}): Promise<UpdateState> {
  const marker = o.marker ?? UPDATE_INFLIGHT, alive = o.alive ?? pidAlive;
  try {
    const pid = parseInt(readFileSync(o.lock ?? UPDATE_LOCK, "utf8").trim(), 10);
    if (pid > 0 && alive(pid)) return { kind: "running" };
  } catch { /* no lock file = no update holding it */ }
  if (existsSync(marker)) {
    const m = readUpdateMarker(marker);
    if (!m) return { kind: "unknown", why: `${marker} 读不了` };
    const repo = o.repo ?? REPO_ROOT;
    const head = await gitOut(repo, "rev-parse", "HEAD");
    if (!head || head.code !== 0 || !head.out) return { kind: "unknown", why: "git rev-parse HEAD 失败" };
    const ahead = head.out !== m.target && (await git(repo, "merge-base", "--is-ancestor", m.target, "HEAD")) === 0;
    let starts: Record<string, DaemonState>;
    try { starts = await (o.daemonStarts ?? launchdStarts)(); } catch (e) { return { kind: "unknown", why: `daemon 状态读不了：${(e as Error).message.slice(0, 120)}` }; }
    const v = updateVerdict(m, head.out, (o.now ?? Date.now)(), alive, starts, ahead);
    if (v.action === "live") return { kind: "running" };
    if (v.action === "report") return { kind: "abandoned", why: v.why };
    if (v.action !== "clear") return { kind: "unfinished", step: m.step };
  }
  const ab = readUpdateMarker(o.abandoned ?? UPDATE_ABANDONED);
  if (ab && (ab.targetLabel === t.label || ab.target === t.ref)) return { kind: "abandoned", why: ab.abandonReason ?? `停在「${ab.step}」` };
  return { kind: "none" };
}

export const gapPort = (o: GapPolicyDeps = {}): GapPort => ({
  policy: gapPolicyPort(o), reached: (t) => reachedTarget(t, o.repoRoot), updateState: (t) => updateState(t, { repo: o.repoRoot }),
});

/**
 * The launcher's access: only when this host has a lend journal (it never lent = nothing to drain, behaviour unchanged).
 * Any journal error answers null, and the launcher then keeps its old path (update only when nothing is busy).
 */
export async function withLendJournal<T>(fn: (db: Database) => T, path = LEND_JOURNAL_PATH): Promise<T | null> {
  if (!existsSync(path)) return null;
  try {
    const db = openLendJournal(path);
    try { return fn(db); } finally { db.close(); }
  } catch (e) {
    console.error(`[update-gap] lend journal 读写失败，按没有空档走老路径：${(e as Error).message.slice(0, 200)}`);
    return null;
  }
}

/** The launcher's one gate before spawning `manager update` (busy = its busyAgentWindows answer). No journal = the old rule. */
export async function launcherUpdateGate(t: UpdateTarget, busy: string[], now = Date.now(), path = LEND_JOURNAL_PATH): Promise<LauncherGo> {
  return (await withLendJournal((db) => launcherGapStep(db, t, busy, now), path)) ?? (busy.length ? { go: false, why: `在忙: ${busy.join(", ")}` } : { go: true });
}

/** Right before spawning: flips a ready gap to updating; false = a gap is draining / already updating, do not spawn. */
export async function launcherBeginGapUpdate(t: UpdateTarget, now = Date.now(), path = LEND_JOURNAL_PATH): Promise<boolean> {
  return (await withLendJournal((db) => launcherBeginUpdate(db, t, now).go, path)) ?? true;
}

/** Record the spawned update's exit when the launcher outlives it (a successful update reloads the launcher before this runs). */
export function trackUpdateExit(t: UpdateTarget, exited: Promise<number>, path = LEND_JOURNAL_PATH): void {
  exited.then((code) => withLendJournal((db) => launcherUpdateExited(db, t.ref, code, Date.now()), path),
    (e) => console.error(`[update-gap] 等更新进程退出失败，空档按 SETTLE_MS 兜底判定：${(e as Error).message}`));
}

/** A ready gap waits for the launcher with intake paused: the launcher checks every minute instead of every 30. */
export async function launcherGapWaiting(path = LEND_JOURNAL_PATH): Promise<boolean> {
  return (await withLendJournal(gapAwaitsLauncher, path)) ?? false;
}
