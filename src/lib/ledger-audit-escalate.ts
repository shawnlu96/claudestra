/**
 * 巡检提醒升级（dispatch-recovery-AUDESC1）：推给调度助理、投出去了、60 分钟后还开着的发现，列给同项目当班 PM。
 * 现有回落（ledger-audit-service.ts FALLBACK_AFTER）只管「推不出去」；这里管「推出去了没人处理」。
 * - 取数 / 判定在这里，CLI（ledger audit）把结果作为 escalate 列表输出，bridge（bridge/ledger-audit-escalate.ts）合成通知后 --ack-escalate。
 * - 每次推送（key + notifiedAt）最多升级一次，记在状态文件 audit-escalations.json：{ "<key>@<notifiedAt>": 升级时刻 }
 *   （确认本身落在 audit-escalations.json.d 的排他标记里，json 是由标记重建的汇总，见 ackEscalations）。
 *   发现解决后再打开会有新的 notifiedAt，可以再升级一次。不写台账事件、不改 audit_findings。
 * - 开关 = 恢复策略 auditEscalate（缺省 observe）：off 不算、输出没有 escalate 字段；observe 照算、带 mode observe（bridge 只打日志）；on 推送并 ack。
 */
import type { Database } from "bun:sqlite";
import { createHash, randomUUID } from "node:crypto";
import { linkSync, mkdirSync, readdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { auditDispatcherTest, auditRecipient, type AuditRule } from "./ledger-audit.js";
import { openFindings, type StoredFinding } from "./ledger-audit-store.js";
import { getMeta, LedgerError } from "./ledger-store.js";
import { statePath } from "./paths.js";
import { recoveryPolicy, type RecoveryMode, type RecoveryPolicyPort } from "./recovery-policy.js";
import { readJsonStateSync, writeJsonAtomicSync } from "./state-file.js";

/** 推给调度助理后多久没处理就升级给 PM */
export const AUDIT_ESCALATE_MS = 60 * 60_000;
const DEFAULT_PATH = statePath("audit-escalations.json");

export interface EscalateItem {
  key: string;
  taskId: string | null;
  rule: AuditRule;
  notifiedAt: number;
  /** 调度助理 */
  from: string;
  /** 当班 PM */
  to: string;
  detail: string;
  mode: Exclude<RecoveryMode, "off">;
}

/** 状态文件：key@notifiedAt → 升级时刻 */
export type EscalateState = Record<string, number>;

/** 标记目录里会改名 / 删除的文件操作；单测注入钩子卡在「读到不合法」与「删除」之间复现并发 */
export interface EscalateFsPort {
  link(from: string, to: string): void;
  rename(from: string, to: string): void;
  unlink(path: string): void;
}
const realFs: EscalateFsPort = { link: linkSync, rename: renameSync, unlink: unlinkSync };
interface Ports { policy: RecoveryPolicyPort; path: string; fs: EscalateFsPort }
let ports: Ports = { policy: recoveryPolicy, path: DEFAULT_PATH, fs: realFs };
/** 组合接线与单测换 port；不给的字段还原默认 */
export function setAuditEscalatePorts(p: Partial<Ports> = {}): void {
  ports = { policy: p.policy ?? recoveryPolicy, path: p.path ?? DEFAULT_PATH, fs: p.fs ?? realFs };
}

const escalateId = (key: string, notifiedAt: number) => `${key}@${notifiedAt}`;

/** "<key>@<notifiedAt>"：key 里可能有 @，按最后一个切 */
export function parseEscalateId(id: string): { key: string; notifiedAt: number } | null {
  const at = id.lastIndexOf("@");
  if (at <= 0) return null;
  const n = Number(id.slice(at + 1));
  return Number.isSafeInteger(n) && n >= 0 && /^\d+$/.test(id.slice(at + 1)) ? { key: id.slice(0, at), notifiedAt: n } : null;
}

const validState = (d: unknown): boolean =>
  !!d && typeof d === "object" && !Array.isArray(d) && Object.values(d as object).every((v) => typeof v === "number");

/** 汇总文件 ∪ 确认标记；汇总读坏按空、打一行诊断，不抛 */
function readEscalateState(path = ports.path): EscalateState {
  const r = readJsonStateSync(path, validState);
  if (r.status === "corrupt") console.error(`⚠️ 巡检升级状态文件读不了，按空处理：${path}（${r.error}）`);
  return { ...(r.status === "ok" ? (r.data as EscalateState) : {}), ...readMarkers(path) };
}

function escalateMode(project: string, policy = ports.policy): RecoveryMode {
  try {
    return policy(project, "auditEscalate").mode;
  } catch {
    return "off"; // 策略读不了：保守不算
  }
}

/** 一条发现该不该升级；该升级就给出 from / to */
export function escalateTarget(f: StoredFinding, pms: readonly string[], teamDispatcher: string | null | undefined, done: EscalateState, now: number):
  { from: string; to: string } | null {
  if (f.resolvedAt !== null || f.notifiedAt === null || !f.notify) return null;
  const isDispatcher = auditDispatcherTest(teamDispatcher);
  if (!isDispatcher(f.notify)) return null;
  const pm = auditRecipient("pm_held", pms, teamDispatcher);
  if (!pm || pm === f.notify || isDispatcher(pm)) return null;
  if (now - f.notifiedAt < AUDIT_ESCALATE_MS) return null;
  if (Object.hasOwn(done, escalateId(f.key, f.notifiedAt))) return null;
  return { from: f.notify, to: pm };
}

/**
 * 这些项目该升级的发现（读 audit_findings 里开着的，dry-run 也一样）。全部项目都是 off → null（输出里不带 escalate 字段，与改前逐字一致）。
 */
export function auditEscalations(db: Database, projects: readonly string[], now: number): EscalateItem[] | null {
  const modes = projects.map((p) => [p, escalateMode(p)] as const).filter(([, m]) => m !== "off") as [string, EscalateItem["mode"]][];
  if (!modes.length) return null;
  const done = readEscalateState();
  const out: EscalateItem[] = [];
  for (const [project, mode] of modes) {
    const meta = getMeta(db, project);
    for (const f of openFindings(db, project)) {
      const t = escalateTarget(f, meta.pms, meta.team?.dispatcher, done, now);
      if (t) out.push({ key: f.key, taskId: f.taskId, rule: f.rule, notifiedAt: f.notifiedAt as number, ...t, detail: f.detail, mode });
    }
  }
  return out;
}

/**
 * --ack-escalate：记下这几次推送已升级；顺手删掉发现已解决（或已重新打开、notifiedAt 变了）的旧条目。
 * 每条确认是标记目录 <path>.d 里的一个文件，tmp 写好后 link 排他创建（已存在就不动）：确认只增不覆盖，
 * 不靠锁和租约——暂停超期的旧写者恢复后也抹不掉别人的确认（第 3 轮审查 ack-race：整份 rename 在核验与提交之间总有窗口）。
 * 清理只删已失效的条目（resolvedAt 有值或 notifiedAt 对不上）：notifiedAt 只在为空时写、重开会换新值，失效不可逆，旧写者删也不会误删。
 * audit-escalations.json 是由标记重建的汇总视图（原子写）；读取取「汇总 ∪ 标记」，汇总被旧快照覆盖也不丢确认。
 */
export async function ackEscalations(db: Database, ids: readonly string[], now: number, path = ports.path): Promise<number> {
  const bad = ids.find((id) => !parseEscalateId(id));
  if (bad) throw new LedgerError("invalid", `--ack-escalate 的每一项要是 <key>@<notifiedAt>，收到 ${bad}`);
  const before = readEscalateState(path);
  let n = 0;
  for (const id of new Set(ids)) {
    if (!Object.hasOwn(before, id)) n++;
    recordMarker(path, id, now);
  }
  compactEscalations(db, path);
  return n;
}

const markerDir = (path: string) => `${path}.d`;
const markerName = (id: string) => `sha256-${createHash("sha256").update(id, "utf8").digest("hex")}`;

/** 哈希标记只有完整 ID 与文件名一致、时间有限才构成确认；坏内容不能永久占住最终名。 */
function readHashMarker(path: string, name: string, file = name): { id: string; at: number } | null {
  try {
    const marker = JSON.parse(readFileSync(join(markerDir(path), file), "utf8")) as { id?: unknown; at?: unknown } | null;
    if (!marker || typeof marker.id !== "string" || !parseEscalateId(marker.id) || markerName(marker.id) !== name) return null;
    if (typeof marker.at !== "number" || !Number.isFinite(marker.at)) return null;
    return { id: marker.id, at: marker.at };
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") console.error(`⚠️ 巡检升级标记读不了：${name}（${(e as Error).message}）`);
    // 清理者可能刚删除文件；损坏标记不构成确认，调用者会修复或清理它。
    return null;
  }
}

/** 排他创建一条确认标记：内容先写进 tmp，再 link 到最终名（原子出现、合法标记已存在则不覆盖，损坏标记用写好的 tmp 原子修复） */
function recordMarker(path: string, id: string, now: number): void {
  const d = markerDir(path);
  mkdirSync(d, { recursive: true });
  const tmp = join(d, `.${process.pid}.${randomUUID()}.tmp`);
  writeFileSync(tmp, JSON.stringify({ id, at: now }));
  try {
    ports.fs.link(tmp, join(d, markerName(id)));
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
    if (!readHashMarker(path, markerName(id))) {
      try {
        ports.fs.rename(tmp, join(d, markerName(id)));
      } catch (r) {
        // 最终名被目录之类占着、换不掉：只带错误码不带完整路径，不自动删目录或改权限（第 6 轮审查 marker-undeletable）
        throw new Error(`巡检升级确认落不下：${markerName(id)} 不是合法确认且换不掉（${(r as NodeJS.ErrnoException).code ?? (r as Error).name}），需要人工处理`);
      }
    }
  } finally {
    try { unlinkSync(tmp); } catch { /* rename 修复已移走 tmp，排他创建后的清理也允许重复。 */ }
  }
}

/** 标记目录里的确认：id → 升级时刻（. 开头的是没提交的 tmp，跳过；内容 ID 与派生文件名必须一致） */
function readMarkers(path: string, cleanInvalid = false): EscalateState {
  let names: string[];
  try {
    names = readdirSync(markerDir(path));
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") console.error(`⚠️ 巡检升级标记目录读不了，按空处理：${markerDir(path)}（${(e as Error).message}）`);
    return {};
  }
  const out: EscalateState = {};
  for (const name of names) {
    if (name.startsWith(".")) continue;
    if (name.startsWith("sha256-")) {
      const marker = readHashMarker(path, name);
      if (marker) out[marker.id] = marker.at;
      else if (cleanInvalid) retireInvalid(path, name);
      continue;
    }
    try {
      const content = readFileSync(join(markerDir(path), name), "utf8");
      // 已落盘的旧 base64 标记仍是确认依据，升级不能让旧汇总覆盖它们。
      const id = Buffer.from(name, "base64url").toString("utf8");
      if (!parseEscalateId(id) || Buffer.from(id).toString("base64url") !== name) continue;
      out[id] = Number(content) || 0;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") console.error(`⚠️ 巡检升级标记读不了：${name}（${(e as Error).message}）`);
      // 清理者可能刚删除此标记；坏内容不构成有效确认，诊断后继续读取其余标记。
    }
  }
  return out;
}

const RETIRED = ".stale.";

/** 清理里的改名 / 删除：ENOENT 视为别人已处理；其他错误只记一条诊断不抛，compact 照常往下走 */
function cleanupOp(what: string, name: string, op: () => void): boolean {
  try {
    op();
    return true;
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code !== "ENOENT") console.error(`⚠️ 巡检升级坏标记${what}失败，跳过：${name}（${code ?? (e as Error).message}）`);
    return false;
  }
}

/**
 * 坏标记不直接 unlink（第 6 轮审查 stale-clean-race：读到不合法与删除之间，别的进程可能刚把它修好）：
 * 先 rename 到 . 开头的私有名（读取跳过），再复核私有名上的内容——仍不合法才删；已是合法确认就放回最终名。
 */
function retireInvalid(path: string, name: string): void {
  const retired = `${RETIRED}${name}.${process.pid}.${randomUUID()}`;
  if (cleanupOp("挪开", name, () => ports.fs.rename(join(markerDir(path), name), join(markerDir(path), retired)))) settleOne(path, retired);
}

/** 复核一个私有名：合法确认放回最终名（最终名已是合法确认就不动它），不合法的删掉 */
function settleOne(path: string, retired: string): void {
  const d = markerDir(path);
  const name = retired.slice(RETIRED.length).split(".")[0]!;
  if (readHashMarker(path, name, retired)) {
    try {
      ports.fs.link(join(d, retired), join(d, name));
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (code !== "EEXIST") {
        if (code !== "ENOENT") console.error(`⚠️ 巡检升级确认放回失败，私有名留到下一轮：${retired}（${code}）`);
        return;
      }
      // 最终名上又有了东西：是合法确认就不动它、删私有名；不合法就用私有名原子换掉（换不掉留到下一轮，不删确认）
      if (!readHashMarker(path, name)) return void cleanupOp("放回", name, () => ports.fs.rename(join(d, retired), join(d, name)));
    }
  }
  cleanupOp("删除", retired, () => ports.fs.unlink(join(d, retired)));
}

/** 上一轮清理中途掉电留下的私有名：逐个复核收掉 */
function settleRetired(path: string): void {
  let names: string[];
  try {
    names = readdirSync(markerDir(path));
  } catch {
    return; // 目录读不了：readMarkers 会打诊断
  }
  for (const n of names) if (n.startsWith(RETIRED)) settleOne(path, n);
}

/** 删失效标记，按剩下的重建汇总文件（不加锁：汇总只是视图，读取会并上标记） */
function compactEscalations(db: Database, path: string): void {
  const row = db.query("SELECT resolvedAt, notifiedAt FROM audit_findings WHERE key = ?");
  const live = (id: string) => {
    const p = parseEscalateId(id);
    const r = p ? (row.get(p.key) as { resolvedAt: number | null; notifiedAt: number | null } | null) : null;
    return !!p && !!r && r.resolvedAt === null && r.notifiedAt === p.notifiedAt;
  };
  settleRetired(path);
  for (const id of Object.keys(readMarkers(path, true))) {
    if (live(id)) continue;
    const legacy = Buffer.from(id).toString("base64url");
    const names = [markerName(id), ...(legacy.length <= 255 ? [legacy] : [])];
    for (const name of names) {
      try { ports.fs.unlink(join(markerDir(path), name)); } catch { /* 失效确认可以重复清理，文件已被另一清理者删除不影响结果。 */ }
    }
  }
  const next: EscalateState = {};
  for (const [id, at] of Object.entries(readEscalateState(path))) if (live(id)) next[id] = at;
  writeJsonAtomicSync(path, next);
}
