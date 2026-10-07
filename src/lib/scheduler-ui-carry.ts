/**
 * UICAR2 write side: when the scheduler's own update-branch carry (scheduler-merge.ts carryReview) moves a UI card's head, the PM
 * screenshot acceptance on the old head is carried too, only if main's part touches no UI (web/**, src/bridge/**, the card's
 * extra.fileGlobs) by this process's own git, PM's last verdict is approved on `from` with the card's digest, and the card is not
 * ownerVisual. Switch `uiCarry` (recovery-policy.ts): off / observe (record only) / on. Read side: scheduler-ui-carry-read.ts.
 */
import type { Database } from "bun:sqlite";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getWorkflow } from "./ledger-scheduler.js";
import type { LedgerTask } from "./ledger-stages.js";
import { listEvents } from "./ledger-store.js";
import { insertEvent } from "./ledger-tx.js";
import { projectPmUiGate } from "./ledger-ui-approve-verdict.js";
import { recordObserved, recoveryPolicy, type RecoveryMode, type RecoveryPolicyPort } from "./recovery-policy.js";
import { readSchedulerConfig } from "./scheduler-config.js";
import { UI_CARRY_OP, uiCarryKey } from "./scheduler-ui-carry-read.js";
import { DIGEST_RE, ownerVisualOf } from "./scheduler-ui-merge-refusal.js";

const SHA = /^[a-f0-9]{40}$/;
const UI_DIRS = ["web/", "src/bridge/"];

/** `git diff --name-only <merge-base(from, mainParent)> <mainParent>` in a bare temp repo borrowing repoDir's objects. */
export function mainTouched(repoDir: string, from: string, mainParent: string): { mainBase: string; files: string[] } {
  if (!SHA.test(from) || !SHA.test(mainParent)) throw new Error("head 不是完整 SHA");
  const env = { ...Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("GIT_"))), GIT_NO_REPLACE_OBJECTS: "1",
    GIT_NO_LAZY_FETCH: "1", GIT_TERMINAL_PROMPT: "0", GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" };
  const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, env, encoding: "utf8", timeout: 30_000, maxBuffer: 8 << 20,
    stdio: ["ignore", "pipe", "pipe"] });
  const dir = mkdtempSync(join(tmpdir(), "ui-carry-"));
  try {
    const objects = join(git(repoDir, "rev-parse", "--path-format=absolute", "--git-common-dir").trim(), "objects");
    git(dir, "init", "-q", "--bare");
    writeFileSync(join(dir, "objects", "info", "alternates"), `${objects}\n`);
    const bases = git(dir, "merge-base", "--all", from, mainParent).trim().split(/\s+/);
    if (bases.length !== 1 || !SHA.test(bases[0]!)) throw new Error("merge-base 不唯一");
    const out = git(dir, "diff", "--name-only", "-z", "--no-renames", "--no-ext-diff", bases[0]!, mainParent);
    return { mainBase: bases[0]!, files: out.split("\0").filter(Boolean) };
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

/** Read every time; an unreadable file / unknown key is off. */
export function uiCarryMode(project: string, policy: RecoveryPolicyPort = recoveryPolicy): RecoveryMode {
  try { const p = policy(project, "uiCarry"); return p.source === "error" ? "off" : p.mode; } catch { return "off"; } // unreadable policy: carry nothing
}

/** note: why it was not carried (merge_phase's note); commit(carrySeq): called right after the carry's merge_phase. */
export interface UiCarryPlan { note: string | null; commit: (carrySeq: number) => void }
const NONE: UiCarryPlan = { note: null, commit: () => {} };
export interface UiCarryDeps { policy?: RecoveryPolicyPort; repoDir?: (project: string) => string | undefined }
const configRepoDir = (project: string): string | undefined => readSchedulerConfig().projects[project]?.repoDir;

/** Judged on the card before the head move, inside the carry's transaction. Never throws: any doubt is a note, nothing carried. */
export function uiCarryPlan(db: Database, task: LedgerTask, c: { intentId: string; from: string; to: string; mainParent: string }, now: number,
  deps: UiCarryDeps = {}): UiCarryPlan {
  if (getWorkflow(db, task.id)?.template !== "ui") return NONE;
  const mode = uiCarryMode(task.project, deps.policy);
  if (mode === "off") return NONE;
  const refuse = (why: string): UiCarryPlan => ({ note: `${why}，截图验收要 PM 在新 head 上补`.slice(0, 500), commit: () => {} });
  const events = listEvents(db, { project: task.project, target: task.id });
  const pm = projectPmUiGate(db, task, events), digest = task.extra.screenshotsDigest, globs = task.extra.fileGlobs ?? [];
  if (ownerVisualOf(db, task, events)) return refuse("本卡要 owner 看截图（ownerVisual）");
  if (pm.state !== "approved" || pm.seq === undefined) return refuse("本轮最后一条 PM 截图结论不是 approved");
  if (pm.head !== c.from || pm.round !== task.round || pm.specRev !== task.specRev || typeof digest !== "string" || !DIGEST_RE.test(digest) ||
    pm.screenshotsDigest !== digest) return refuse("PM 截图验收没绑在原 head / 本轮 / 本规格 / 卡上摘要");
  if (!Array.isArray(globs) || globs.some((g) => typeof g !== "string")) return refuse("卡上 fileGlobs 不是字符串列表");
  let touched: { mainBase: string; files: string[] };
  try {
    const repo = (deps.repoDir ?? configRepoDir)(task.project);
    if (!repo) return refuse("调度配置里没有本项目的 repoDir，算不了 main 触碰清单");
    touched = mainTouched(repo, c.from, c.mainParent);
  } catch (e) { return refuse(`main 触碰清单算不出（${(e as Error).message.split("\n")[0]!.slice(0, 160)}）`); }
  const own = (globs as string[]).map((g) => new Bun.Glob(g));
  const hits = touched.files.filter((f) => UI_DIRS.some((d) => f.toLowerCase().startsWith(d)) || own.some((g) => g.match(f)));
  if (hits.length) return refuse(`main 改了 ${hits.slice(0, 3).join("、")}${hits.length > 3 ? ` 等 ${hits.length} 个文件` : ""}`);
  const data = { intentId: c.intentId, from: c.from, to: c.to, round: task.round, specRev: task.specRev, digest, approvalSeq: pm.seq,
    mainBase: touched.mainBase, mainParent: c.mainParent, touched: [] as string[], changed: touched.files.slice(0, 200) };
  if (mode === "observe") {
    return { note: null, commit: () => void recordObserved(db, { project: task.project, mechanism: "uiCarry", target: task.id, actionKey: `ui-carry:${c.to}`,
      action: `沿用截图验收到 ${c.to.slice(0, 12)}（main 改了 ${touched.files.length} 个文件，都不碰界面）`, data }, now) };
  }
  return { note: null, commit: (carrySeq) => void insertEvent(db, { actor: "scheduler", now, dedupKey: uiCarryKey(c.intentId, carrySeq) }, {
    project: task.project, target: task.id, kind: "scheduler", text: `沿用截图验收到新 head ${c.to.slice(0, 12)}（main 段不碰界面）`,
    data: { op: UI_CARRY_OP, ...data, carrySeq } }, true) };
}
