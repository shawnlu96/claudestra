/**
 * FRESHENTRY1 · 全新 Floka 根从真实安装入口（`manager.ts install-cli`、`setup.ts`）启动。两个入口在 import 其他模块之前
 * 先 import fresh-root-preload.ts，它把入口交给这里：严格 fresh 判定 → 恢复键 installFreshEntry → 现有的 chooseFreshStateRoot。
 * - 严格 fresh：旧根不存在、~/.floka 是普通目录、两种名字的 STATE_DIR 都没设、没有维护屏障、维护根里没有任何状态日志
 *   （有日志 = 迁移中断）、~/.floka 的身份要么两份文件都没有、要么两份都在且有效（坏身份不补、不重造）。不满足就不动手，
 *   让 paths.ts 照原样报它自己的错。
 * - 恢复键 installFreshEntry（缺省 on）：在动作前现读 recovery-policy.json（旧根与 ~/.floka 两处都读，取最保守的），
 *   项目 claude-orchestrator 的 keys.installFreshEntry → 项目 mode → on；文件坏 / 结构不合法（与 recovery-policy.ts 同一严格判据）→ off。不经 recovery-policy.ts：
 *   那里加载期就 import paths.ts。off = 入口什么都不做（与基线一致）；observe = 只记一条「本会选 X」的样本，不动手。
 * - 观察样本落维护根 observe/installFreshEntry.jsonl，按 入口@版本 + 动作去重，只有入口名、版本、动作，没有路径与身份内容。
 * 只依赖 node: 内置与 fresh-root.ts 同一批模块（不经 paths.ts）。tests/floka-fresh-entry.test.ts。
 */
import { createPrivateKey } from "node:crypto";
import { appendFileSync, lstatSync, mkdirSync, readFileSync, readdirSync } from "node:fs";
import { basename, join } from "node:path";
import type { ObservedAction, RecoveryMode } from "../recovery-policy.js";
import { maintenanceBarrierPresent } from "../floka-config/default-root.ts";
import { RECOVERY_KEYS } from "../recovery-keys.ts";
import { stateDirIn } from "../state-dir.ts";
import { maintenanceRoot } from "../state-maintenance/paths.ts";
import { chooseFreshStateRoot, type FreshRootChoice, type FreshRootResult } from "./fresh-root.ts";

const INSTALL_FRESH_ENTRY_KEY = "installFreshEntry";
const PROJECT = "claude-orchestrator";
const MODES: readonly RecoveryMode[] = ["on", "observe", "off"];
const MANUAL_STALL_HOURS_MAX = 720; // 同 recovery-policy.ts
const RANK: Record<RecoveryMode, number> = { on: 0, observe: 1, off: 2 };

type Env = Record<string, string | undefined>;
export type FreshEntryTarget = "manager:install-cli" | "setup";
export type FreshEntryCheck =
  | { status: "fresh"; choice: FreshRootChoice }
  | { status: "skip"; reason: "override" | "not-fresh" }
  | { status: "refuse"; reason: "interrupted-migration" | "bad-identity" };
export type FreshEntryOutcome =
  | { mode: RecoveryMode; check: FreshEntryCheck; action: "none" }
  | { mode: "observe"; check: FreshEntryCheck; action: "observed"; recorded: boolean }
  | { mode: "on"; check: FreshEntryCheck; action: "chosen"; result: FreshRootResult };

/** 进程是不是从两个入口脚本起的（manager 的其他子命令也算：它们由本卡管、且一律不动手） */
export const isEntryScript = (argv: readonly string[] = process.argv): boolean => ["manager.ts", "setup.ts"].includes(basename(argv[1] ?? ""));

/** 只认两个真实安装入口；manager 的其他子命令、直接 import cli-install 的脚本不归本卡 */
export function freshEntryTarget(argv: readonly string[] = process.argv): FreshEntryTarget | null {
  const script = basename(argv[1] ?? "");
  if (script === "setup.ts") return "setup";
  if (script === "manager.ts" && argv[2] === "install-cli") return "manager:install-cli";
  return null;
}

/** lstat 不跟软链：~/.floka 与旧根必须是本体 */
const kind = (path: string): "missing" | "dir" | "file" | "other" => {
  const s = lstatSync(path, { throwIfNoEntry: false });
  return !s ? "missing" : s.isDirectory() && !s.isSymbolicLink() ? "dir" : s.isFile() ? "file" : "other";
};

/** 与 default-root.ts 的身份锚同一判据：id 是 [\w-]{1,64}，key 是 ed25519 私钥 */
function identityState(root: string): "none" | "valid" | "bad" {
  const files = ["instance-id", "instance-key.pem"].map(n => join(root, n));
  const present = files.map(p => kind(p) !== "missing");
  if (!present.some(Boolean)) return "none";
  if (!files.every(p => kind(p) === "file")) return "bad";
  if (!/^[\w-]{1,64}$/.test(readFileSync(files[0]!, "utf8").trim())) return "bad";
  try {
    return createPrivateKey(readFileSync(files[1]!)).asymmetricKeyType === "ed25519" ? "valid" : "bad";
  } catch { return "bad"; }
}

function hasJournals(home: string): boolean {
  try { return readdirSync(join(maintenanceRoot(home), "journals")).length > 0; } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw e;
  }
}

/** 只读：这台机器是不是本卡要放行的全新根，放行时按现有缺省规则选哪个根 */
export function checkFreshEntry(home: string, env: Env = process.env): FreshEntryCheck {
  if ((env.CLAUDESTRA_STATE_DIR || "").trim() || (env.FLOKA_STATE_DIR || "").trim()) return { status: "skip", reason: "override" };
  if (kind(stateDirIn(home)) !== "missing" || kind(join(home, ".floka")) !== "dir" || maintenanceBarrierPresent(home)) {
    return { status: "skip", reason: "not-fresh" };
  }
  if (hasJournals(home)) return { status: "refuse", reason: "interrupted-migration" };
  const id = identityState(join(home, ".floka"));
  if (id === "bad") return { status: "refuse", reason: "bad-identity" };
  return { status: "fresh", choice: id === "valid" ? "floka" : "legacy" };
}

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const isMode = (v: unknown): v is RecoveryMode => MODES.includes(v as RecoveryMode);
const isPosInt = (v: unknown) => Number.isSafeInteger(v) && (v as number) >= 1;

/**
 * 与 recovery-policy.ts 的 parseRecoveryFile 同一套严格判据（那边加载期 import paths.ts，这里不能引）：顶层只能
 * { projects: {...}, machine?: {...} }；每个项目只能有 mode / manualStallHours / keys / rev 且取值合法；keys 只认已登记的恢复键。
 * 任何一处不合法 = 整个文件无效 → 保守 off，绝不把坏文件当「没配」走缺省 on。
 */
function validPolicyDocument(data: unknown): data is { projects: Record<string, { mode?: RecoveryMode; keys?: Record<string, RecoveryMode> }> } {
  if (!isObj(data) || !isObj(data.projects) || Object.keys(data).some(k => k !== "projects" && k !== "machine")) return false;
  if (data.machine !== undefined && !isObj(data.machine)) return false;
  return Object.values(data.projects).every(p => isObj(p)
    && Object.keys(p).every(k => ["mode", "manualStallHours", "keys", "rev"].includes(k))
    && (p.rev === undefined || isPosInt(p.rev))
    && (p.mode === undefined || isMode(p.mode))
    && (p.manualStallHours === undefined || (Number.isInteger(p.manualStallHours) && (p.manualStallHours as number) >= 1 && (p.manualStallHours as number) <= MANUAL_STALL_HOURS_MAX))
    && (p.keys === undefined || (isObj(p.keys) && Object.entries(p.keys).every(([k, m]) => (RECOVERY_KEYS as readonly string[]).includes(k) && isMode(m)))));
}

function readMode(path: string): RecoveryMode | null {
  let raw: string;
  try { raw = readFileSync(path, "utf8"); } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
    return "off";
  }
  let data: unknown;
  try { data = JSON.parse(raw); } catch { return "off"; } // 读不了的策略文件 = 保守停手，同 recovery-policy.ts
  if (!validPolicyDocument(data)) return "off";
  const p = Object.hasOwn(data.projects, PROJECT) ? data.projects[PROJECT] : undefined;
  return p?.keys?.[INSTALL_FRESH_ENTRY_KEY] ?? p?.mode ?? null;
}

/** 每次现读，不缓存：运行中切档对下一次动作立即生效 */
export function freshEntryMode(home: string): RecoveryMode {
  let mode: RecoveryMode = "on";
  for (const root of [stateDirIn(home), join(home, ".floka")]) {
    const m = readMode(join(root, "recovery-policy.json"));
    if (m && RANK[m] > RANK[mode]) mode = m;
  }
  return mode;
}

function packageVersion(): string {
  try { return String(JSON.parse(readFileSync(join(import.meta.dir, "..", "..", "..", "package.json"), "utf8")).version || "unknown"); } catch { return "unknown"; }
}

/** 观察样本：入口@版本 + 动作一条，已有就不再写 */
function observeFreshEntry(home: string, sample: ObservedAction): boolean {
  const dir = join(maintenanceRoot(home), "observe");
  const file = join(dir, `${INSTALL_FRESH_ENTRY_KEY}.jsonl`);
  const dedup = `${sample.target}|${sample.actionKey}`;
  let seen = "";
  try { seen = readFileSync(file, "utf8"); } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
  }
  if (seen.split("\n").some(line => line && (() => { try { return JSON.parse(line).dedup === dedup; } catch { return false; } })())) return false;
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  appendFileSync(file, `${JSON.stringify({ dedup, mechanism: sample.mechanism, target: sample.target, actionKey: sample.actionKey, action: sample.action })}\n`, { mode: 0o600 });
  return true;
}

/** 入口调用：先严格判定，再在动作前现读模式；on 走现有选择，observe 只记样本，off 什么都不做 */
export function runFreshEntry(target: FreshEntryTarget, home: string, env: Env = process.env, version = packageVersion()): FreshEntryOutcome {
  const check = checkFreshEntry(home, env);
  const mode = freshEntryMode(home);
  if (mode === "off" || check.status !== "fresh") return { mode, check, action: "none" };
  if (mode === "observe") {
    const sample: ObservedAction = {
      project: PROJECT, mechanism: INSTALL_FRESH_ENTRY_KEY, target, actionKey: `${version}:${check.choice}`, action: `全新根选 ${check.choice}`,
    };
    return { mode, check, action: "observed", recorded: observeFreshEntry(home, sample) };
  }
  return { mode, check, action: "chosen", result: chooseFreshStateRoot(home, check.choice) };
}
