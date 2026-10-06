/**
 * 出借额度线的配置（QLINE1）：每个家族一条提醒线（warnPct）和一条停接线（stopPct），外加整体模式 on / observe / off。
 * 存在 statePath("lend-quota-lines.json")，与 lend.json 分开：这里只收窄容量，不碰授权 / 凭据，写坏了也撤不掉授权。
 * 读分三态：missing = 用默认 70/80、on；invalid（坏 JSON、多字段、越界、提醒线不低于停线）= 也按默认执行，但如实标 invalid，
 * 网页能看到并直接重存修好；不会因为文件坏了就当作「没有限制」。写只走 saveQuotaLines：锁 + 校验 + 原子写，一族改动不碰另一族。
 * tests/lend-quota-line-config.test.ts。
 */
import { copyFileSync, existsSync } from "node:fs";
import { acquireLock } from "./file-lock.js";
import { LEND_FAMILIES, type LendFamily } from "./lend-wire-types.js";
import { statePath } from "./paths.js";
import { readJsonState, readJsonStateSync, writeJsonAtomic, type StateRead } from "./state-file.js";

export const QUOTA_LINES_PATH = statePath("lend-quota-lines.json");
const QUOTA_LINE_MODES = ["on", "observe", "off"] as const;
export type QuotaLineMode = (typeof QUOTA_LINE_MODES)[number];
export interface FamilyLine { warnPct: number; stopPct: number }
export interface QuotaLinesFile { v: 1; mode: QuotaLineMode; families: Record<LendFamily, FamilyLine> }
export type QuotaLinesRead =
  | { status: "missing"; file: QuotaLinesFile }
  | { status: "invalid"; error: string; file: QuotaLinesFile }
  | { status: "ok"; file: QuotaLinesFile };

const DEFAULT_LINE: FamilyLine = { warnPct: 70, stopPct: 80 };
export const defaultQuotaLines = (): QuotaLinesFile => ({
  v: 1, mode: "on", families: Object.fromEntries(LEND_FAMILIES.map((f) => [f, { ...DEFAULT_LINE }])) as Record<LendFamily, FamilyLine>,
});

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const isPct = (v: unknown): v is number => typeof v === "number" && Number.isInteger(v) && v >= 0 && v <= 100;
const extra = (o: Record<string, unknown>, allowed: readonly string[]): string | undefined => Object.keys(o).find((k) => !allowed.includes(k));

/** 一族的两条线：有限整数 0..100、提醒线严格低于停线；错了给一句原因 */
function lineProblem(v: unknown, where: string): string | null {
  if (!isObj(v)) return `${where} 要是对象`;
  const x = extra(v, ["warnPct", "stopPct"]);
  if (x !== undefined) return `${where} 不认识的字段 ${x}`;
  if (!isPct(v.warnPct)) return `${where}.warnPct 要是 0..100 的整数`;
  if (!isPct(v.stopPct)) return `${where}.stopPct 要是 0..100 的整数`;
  if (v.warnPct >= v.stopPct) return `${where} 提醒线要低于停接线`;
  return null;
}

/** 整份文件的校验；null = 合法。缺任何一族也算坏：缺族不能静默套默认，否则网页显示的和执行的会分叉 */
export function quotaLinesProblem(v: unknown): string | null {
  if (!isObj(v)) return "不是 JSON 对象";
  const x = extra(v, ["v", "mode", "families"]);
  if (x !== undefined) return `不认识的字段 ${x}`;
  if (v.v !== 1) return "v 要是 1";
  if (!QUOTA_LINE_MODES.includes(v.mode as QuotaLineMode)) return "mode 要是 on / observe / off";
  if (!isObj(v.families)) return "families 要是对象";
  const fx = extra(v.families, LEND_FAMILIES);
  if (fx !== undefined) return `不认识的家族 ${fx}`;
  for (const f of LEND_FAMILIES) {
    if (v.families[f] === undefined) return `缺家族 ${f}`;
    const p = lineProblem(v.families[f], `families.${f}`);
    if (p) return p;
  }
  return null;
}

function toRead(r: StateRead): QuotaLinesRead {
  if (r.status === "missing") return { status: "missing", file: defaultQuotaLines() };
  if (r.status === "corrupt") return { status: "invalid", error: r.error, file: defaultQuotaLines() };
  const p = quotaLinesProblem(r.data);
  return p ? { status: "invalid", error: p, file: defaultQuotaLines() } : { status: "ok", file: r.data as QuotaLinesFile };
}

export const readQuotaLines = async (path = QUOTA_LINES_PATH): Promise<QuotaLinesRead> => toRead(await readJsonState(path));
/** claim 前末刻核用的同步读：每次现读，不缓存（网页刚改的线下一次 claim 就生效） */
export const readQuotaLinesSync = (path = QUOTA_LINES_PATH): QuotaLinesRead => toRead(readJsonStateSync(path));

/** 网页的一次修改：一族的两条线、模式，至少一样；别的字段一律拒 */
export interface QuotaLinesPatch { family?: LendFamily; warnPct?: number; stopPct?: number; mode?: QuotaLineMode }

/** 请求体 → 补丁；错了给一句原因（整份拒，不部分更新） */
export function parsePatch(b: unknown): QuotaLinesPatch | string {
  if (!isObj(b)) return "请求体要是 JSON 对象";
  const x = extra(b, ["family", "warnPct", "stopPct", "mode"]);
  if (x !== undefined) return `不认识的字段 ${x}`;
  const out: QuotaLinesPatch = {};
  if (b.mode !== undefined) {
    if (!QUOTA_LINE_MODES.includes(b.mode as QuotaLineMode)) return "mode 要是 on / observe / off";
    out.mode = b.mode as QuotaLineMode;
  }
  const lineGiven = b.family !== undefined || b.warnPct !== undefined || b.stopPct !== undefined;
  if (lineGiven) {
    if (!LEND_FAMILIES.includes(b.family as LendFamily)) return "family 要是 codex 或 claude";
    const p = lineProblem({ warnPct: b.warnPct, stopPct: b.stopPct }, b.family as string);
    if (p) return p;
    Object.assign(out, { family: b.family, warnPct: b.warnPct, stopPct: b.stopPct });
  }
  if (!lineGiven && out.mode === undefined) return "没有要改的：给 family + warnPct + stopPct，或 mode";
  return out;
}

const applyPatch = (base: QuotaLinesFile, p: QuotaLinesPatch): QuotaLinesFile => ({
  v: 1, mode: p.mode ?? base.mode,
  families: { ...base.families, ...(p.family ? { [p.family]: { warnPct: p.warnPct!, stopPct: p.stopPct! } } : {}) },
});

export type SaveResult = { ok: true; file: QuotaLinesFile; replacedInvalid: string | null } | { ok: false; code: "busy" | "io"; error: string };
const LOCK_WAIT_MS = 5_000;

/**
 * 锁内现读 → 合并 → 原子写。拿不到锁 = busy，不降级裸写（两个网页同时改不同族时，后写的会覆盖先写的那族）。
 * 磁盘上是坏文件：先另存 `<file>.invalid-<ts>` 再以默认为底写入，网页因此能直接修好坏配置，原文件留底不丢。
 * 写失败（含另存失败）一律 ok:false，调用方不能报「已生效」。
 */
export async function saveQuotaLines(p: QuotaLinesPatch, path = QUOTA_LINES_PATH, now = Date.now()): Promise<SaveResult> {
  let lock: Awaited<ReturnType<typeof acquireLock>>;
  try { lock = await acquireLock(`${path}.lock`, LOCK_WAIT_MS); } catch (e) { return { ok: false, code: "io", error: `拿额度线配置的锁失败：${(e as Error).message}` }; }
  if (!lock) return { ok: false, code: "busy", error: "额度线配置正被别的请求修改，稍后再试" };
  try {
    const cur = await readQuotaLines(path);
    if (cur.status === "invalid" && existsSync(path)) copyFileSync(path, `${path}.invalid-${now}`);
    const file = applyPatch(cur.file, p);
    const bad = quotaLinesProblem(file);
    if (bad) return { ok: false, code: "io", error: `合并后的配置不合法：${bad}` };
    if (!lock.held()) return { ok: false, code: "busy", error: "额度线配置的锁已失效，没写入" };
    await writeJsonAtomic(path, file, { mode: 0o600, trailingNewline: true });
    return { ok: true, file, replacedInvalid: cur.status === "invalid" ? cur.error : null };
  } catch (e) {
    return { ok: false, code: "io", error: `写额度线配置失败：${(e as Error).message}` };
  } finally {
    lock.release();
  }
}
