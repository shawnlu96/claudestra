/**
 * setup / update 安装 statusline 用量缓存（scripts/statusline-usage.sh）：
 *   - statusLine 没配 → 原子写入规范脚本（CAS：写前核对文件字节没被别人改过）；
 *   - 已是我们的（规范脚本或它的 --wrap 包装）→ 不动（重复跑不套娃）；
 *   - 用户自己的 statusLine → 一个字节都不改，只落一份「包装计划」，等本机 owner 在按钮上明确批准
 *     （bridge/account-usage-statusline-consent.ts）才由 applyWrapPlan 应用：原命令原样包进去，输出照旧；
 *   - settings.json 读不了 / 坏 JSON / 不是对象 → 不写。用户不批准系统照常跑，看板显示未知。
 * 计划绑定 settings 原字节 hash 与包装后字节 hash、有效期，一次消费。单测 tests/statusline-usage-install.test.ts（只用 fixture）。
 */
import { createHash, randomBytes } from "crypto";
import { copyFileSync, readFileSync } from "fs";
import { join } from "path";
import { claudeUserSettingsPath } from "./bypass-consent.js";
import { shellEscape } from "./claude-launch.js";
import { acquireLock } from "./file-lock.js";
import { refuseInSandbox, statePath } from "./paths.js";
import { readJsonStateSync, writeJsonAtomicSync, writeTextAtomicSync } from "./state-file.js";

export const WRAP_PLAN_PATH = statePath("statusline-wrap-plan.json");
export const WRAP_PLAN_TTL_MS = 24 * 3600_000;
const SCRIPT_REL = "scripts/statusline-usage.sh";

export interface WrapPlan {
  planId: string;
  /** 只认本机 owner（devices.ts OWNER_PRINCIPAL_ID）批准；批准侧另核点击者身份 */
  owner: "owner:self";
  settingsPath: string;
  origSha: string;
  newSha: string;
  originalCommand: string;
  wrappedCommand: string;
  createdAt: number;
  expiresAt: number;
  consumedAt: number | null;
}

export interface InstallDeps {
  repoRoot: string;
  settingsPath?: string;
  planPath?: string;
  now?: () => number;
}

export type InstallResult =
  | { action: "installed" | "already" }
  | { action: "planned"; planId: string; originalCommand: string }
  | { action: "skipped"; reason: "unreadable" | "corrupt" | "busy" | "changed" };

export const canonicalStatuslineCommand = (repoRoot: string): string => shellEscape(join(repoRoot, SCRIPT_REL));
export const wrappedStatuslineCommand = (repoRoot: string, original: string): string =>
  `${canonicalStatuslineCommand(repoRoot)} --wrap ${shellEscape(original)}`;

/** 规范脚本或它的包装（任意 clone 路径都算）：再跑 setup / update 不再套一层 */
export function isOurStatusline(command: unknown): boolean {
  if (typeof command !== "string") return false;
  const first = command.trim().match(/^'([^']*)'|^(\S+)/);
  const bin = first ? (first[1] ?? first[2] ?? "") : "";
  return bin.endsWith(`/${SCRIPT_REL}`);
}

const sha = (s: string): string => createHash("sha256").update(s).digest("hex");
const serialize = (o: unknown): string => JSON.stringify(o, null, 2) + "\n";

type Read = { ok: true; raw: string; settings: Record<string, any> } | { ok: false; reason: "unreadable" | "corrupt" };

function readSettings(path: string): Read {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return { ok: true, raw: "", settings: {} };
    return { ok: false, reason: "unreadable" };
  }
  try {
    const v = JSON.parse(raw);
    if (!v || typeof v !== "object" || Array.isArray(v)) return { ok: false, reason: "corrupt" };
    return { ok: true, raw, settings: v };
  } catch {
    return { ok: false, reason: "corrupt" }; // 坏 JSON 当空写回会清掉用户的整份配置：只报不写
  }
}

/** CAS 写：tmp 写好、rename 前再读一次，字节变了（别的写者抢先）就放弃。导出给单测 */
export function casWrite(path: string, expectRaw: string, text: string): boolean {
  try {
    writeTextAtomicSync(path, text, { preserveMode: true, mode: 0o600, commitIf: () => currentRaw(path) === expectRaw });
    return true;
  } catch (e) {
    console.error(`[statusline] 没写 ${path}: ${(e as Error).message}`);
    return false;
  }
}

function currentRaw(path: string): string | null {
  try {
    return readFileSync(path, "utf8");
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "ENOENT" ? "" : null;
  }
}

async function withSettingsLock<T>(path: string, busy: T, fn: () => T): Promise<T> {
  const lock = await acquireLock(`${path}.claudestra-statusline.lock`, 5_000);
  if (!lock) return busy;
  try {
    return fn();
  } finally {
    lock.release();
  }
}

/** setup / update 调这个：没配就装、是我们的就不动、用户自己的只出计划不改字节 */
export async function ensureStatuslineUsage(deps: InstallDeps): Promise<InstallResult> {
  if (!deps.settingsPath) refuseInSandbox("写 ~/.claude/settings.json 的 statusLine（全局 Claude Code 配置）");
  const path = deps.settingsPath ?? claudeUserSettingsPath();
  const now = deps.now ?? Date.now;
  return withSettingsLock<InstallResult>(path, { action: "skipped", reason: "busy" }, () => {
    const r = readSettings(path);
    if (!r.ok) return { action: "skipped", reason: r.reason };
    const cur = r.settings.statusLine;
    if (cur === undefined || cur === null) {
      const next = { ...r.settings, statusLine: { type: "command", command: canonicalStatuslineCommand(deps.repoRoot) } };
      return casWrite(path, r.raw, serialize(next)) ? { action: "installed" } : { action: "skipped", reason: "changed" };
    }
    if (isOurStatusline(cur?.command)) return { action: "already" };
    if (typeof cur?.command !== "string" || !cur.command.trim()) return { action: "skipped", reason: "corrupt" };
    const plan = makePlan(path, r, deps.repoRoot, now());
    writeJsonAtomicSync(deps.planPath ?? WRAP_PLAN_PATH, plan, { mode: 0o600 });
    return { action: "planned", planId: plan.planId, originalCommand: plan.originalCommand };
  });
}

function wrappedText(settings: Record<string, any>, wrapped: string): string {
  return serialize({ ...settings, statusLine: { ...settings.statusLine, command: wrapped } });
}

function makePlan(settingsPath: string, r: Extract<Read, { ok: true }>, repoRoot: string, at: number): WrapPlan {
  const originalCommand = r.settings.statusLine.command as string;
  const wrappedCommand = wrappedStatuslineCommand(repoRoot, originalCommand);
  return {
    planId: randomBytes(8).toString("hex"), owner: "owner:self", settingsPath, origSha: sha(r.raw),
    newSha: sha(wrappedText(r.settings, wrappedCommand)), originalCommand, wrappedCommand,
    createdAt: at, expiresAt: at + WRAP_PLAN_TTL_MS, consumedAt: null,
  };
}

const isPlan = (d: unknown): d is WrapPlan =>
  !!d && typeof d === "object" && typeof (d as WrapPlan).planId === "string" && typeof (d as WrapPlan).origSha === "string";

/** 待批准的计划（没有 / 坏 / 已消费 / 已过期 = null） */
export function pendingWrapPlan(nowMs = Date.now(), planPath = WRAP_PLAN_PATH): WrapPlan | null {
  const r = readJsonStateSync(planPath, isPlan);
  if (r.status !== "ok") return null;
  const p = r.data as WrapPlan;
  return p.consumedAt === null && nowMs < p.expiresAt ? p : null;
}

export type ApplyResult = { ok: true } | { ok: false; reason: "no_plan" | "plan_mismatch" | "expired" | "drift" | "busy" | "write_failed" };

/**
 * 应用已批准的计划（批准侧已核过 owner 与按钮来源）：planId 必须是当前未消费、未过期的那份；
 * 磁盘字节 hash 必须仍是计划时的原字节、算出来的新字节 hash 必须等于计划里的——任何漂移都不写。
 * 写前备份原字节，CAS 写入，成功后把计划标成已消费（重放 = no_plan）。
 */
export async function applyWrapPlan(planId: string, opts: { planPath?: string; now?: () => number } = {}): Promise<ApplyResult> {
  const planPath = opts.planPath ?? WRAP_PLAN_PATH;
  const now = (opts.now ?? Date.now)();
  const r = readJsonStateSync(planPath, isPlan);
  if (r.status !== "ok") return { ok: false, reason: "no_plan" };
  const path = (r.data as WrapPlan).settingsPath;
  return withSettingsLock<ApplyResult>(path, { ok: false, reason: "busy" }, () => {
    const again = readJsonStateSync(planPath, isPlan); // 锁内重读：并发的两次批准只有一次看得到未消费
    if (again.status !== "ok") return { ok: false, reason: "no_plan" };
    const plan = again.data as WrapPlan;
    if (plan.planId !== planId || plan.consumedAt !== null) return { ok: false, reason: plan.planId !== planId ? "plan_mismatch" : "no_plan" };
    if (now >= plan.expiresAt) return { ok: false, reason: "expired" };
    const cur = readSettings(plan.settingsPath);
    if (!cur.ok || sha(cur.raw) !== plan.origSha || cur.settings.statusLine?.command !== plan.originalCommand) return { ok: false, reason: "drift" };
    const text = wrappedText(cur.settings, plan.wrappedCommand);
    if (sha(text) !== plan.newSha) return { ok: false, reason: "drift" };
    copyFileSync(plan.settingsPath, `${plan.settingsPath}.claudestra-statusline.bak`);
    if (!casWrite(plan.settingsPath, cur.raw, text)) return { ok: false, reason: "write_failed" };
    writeJsonAtomicSync(planPath, { ...plan, consumedAt: now }, { mode: 0o600 });
    return { ok: true };
  });
}

/** setup / update 打印用的一行结论 */
export function describeInstall(r: InstallResult): string {
  switch (r.action) {
    case "installed": return "statusline 用量缓存已配置";
    case "already": return "statusline 用量缓存已在（未改动）";
    case "planned": return "你已有自己的 statusLine：未改动；包装计划等本机 owner 在看板按钮上批准（不批准也能用，用量显示未知）";
    default: return `statusline 用量缓存未配置（${r.reason}），未改动 settings.json`;
  }
}

/** 薄调用入口（setup / update 各一行）：失败只告警，绝不拦安装 / 升级 */
export async function installStatuslineUsage(repoRoot: string, log: (s: string) => void = console.error): Promise<void> {
  try {
    log(`[statusline] ${describeInstall(await ensureStatuslineUsage({ repoRoot }))}`);
  } catch (e) {
    log(`[statusline] 安装跳过: ${(e as Error).message}`);
  }
}
