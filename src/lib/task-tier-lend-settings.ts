/**
 * 出借方 B 的「接受降档建议」设置（TIER3b）：statePath("task-tier-lend-settings.json")，{ v: 1, acceptDowngrade, rev, updatedAt, updatedBy }。
 * 没存过 = 缺省开；文件坏 / 读不了 = 按关算（不降档，整段走现有启动路径）并给诊断，不猜。
 * 只有 B 本人（owner：本机 CLI / owner 全权设备）或 B 的 master 能改；peer / agent / 远端 A 一律拒——网页（bridge local-api/task-tier-lend-settings.ts）
 * 和管理命令（manager/ledger-task-tier-lend-settings-cmd.ts）都经这里的 saveTierLendSettings 写、同一个权限判定。
 * 写是 rev 比对 + 原子替换（tmp + rename）。tests/task-tier-lend-settings.test.ts。
 */
import { existsSync, readFileSync } from "node:fs";
import { statePath } from "./paths.js";
import { writeJsonAtomicSync } from "./state-file.js";

export const TIER_LEND_SETTINGS_PATH = statePath("task-tier-lend-settings.json");

interface TierLendSettings { v: 1; acceptDowngrade: boolean; rev: number; updatedAt: number | null; updatedBy: string | null }
export type TierLendRead =
  | { status: "missing" | "ok"; settings: TierLendSettings }
  | { status: "invalid" | "unreadable"; settings: TierLendSettings; error: string };

const DEFAULT_TIER_LEND: TierLendSettings = { v: 1, acceptDowngrade: true, rev: 0, updatedAt: null, updatedBy: null };
const KEYS = ["v", "acceptDowngrade", "rev", "updatedAt", "updatedBy"];
const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

function parse(v: unknown): TierLendSettings | string {
  if (!isObj(v)) return "要是对象";
  const x = Object.keys(v).find((k) => !KEYS.includes(k));
  if (x !== undefined) return `不认识的字段 ${x}`;
  if (v.v !== 1) return "v 只认 1";
  if (typeof v.acceptDowngrade !== "boolean") return "acceptDowngrade 要是 true / false";
  if (!Number.isInteger(v.rev) || (v.rev as number) < 0) return "rev 要是非负整数";
  if (v.updatedAt !== null && !Number.isInteger(v.updatedAt)) return "updatedAt 要是毫秒时间或 null";
  if (v.updatedBy !== null && typeof v.updatedBy !== "string") return "updatedBy 要是字符串或 null";
  return { v: 1, acceptDowngrade: v.acceptDowngrade, rev: v.rev as number, updatedAt: v.updatedAt as number | null, updatedBy: v.updatedBy as string | null };
}

/** 坏文件按关：settings.acceptDowngrade = false，免得读不清时替出借方放开降档 */
export function readTierLendSettings(path = TIER_LEND_SETTINGS_PATH): TierLendRead {
  if (!existsSync(path)) return { status: "missing", settings: DEFAULT_TIER_LEND };
  let raw: string;
  try { raw = readFileSync(path, "utf8"); } catch (e) {
    return { status: "unreadable", settings: { ...DEFAULT_TIER_LEND, acceptDowngrade: false }, error: (e as Error).message };
  }
  let json: unknown;
  try { json = JSON.parse(raw); } catch { json = undefined; /* 下面按内容不合法报 */ }
  const s = parse(json);
  return typeof s === "string" ? { status: "invalid", settings: { ...DEFAULT_TIER_LEND, acceptDowngrade: false }, error: s } : { status: "ok", settings: s };
}

/** 谁在改：actor = ledger CLI 身份（owner / master / agent 名）；principal = 网页凭据是否 owner 全权设备（canRunFleet） */
export type TierLendEditor = { kind: "actor"; actor: string } | { kind: "web"; ownerFull: boolean };

/** null = 可改；只认 B 本人（owner）与 B 的 master */
function tierLendEditProblem(by: TierLendEditor): string | null {
  if (by.kind === "web") return by.ownerFull ? null : "只有本机 owner 的全权设备能改「接受降档建议」";
  return by.actor === "owner" || by.actor === "master" ? null : `「接受降档建议」只有本机 owner 或 master 能改（你是 ${by.actor}）`;
}

export type TierLendSave = { ok: true; settings: TierLendSettings } | { ok: false; code: "forbidden" | "conflict" | "io"; error: string; current?: TierLendSettings };

/** rev = 改之前读到的版本（CAS）；坏文件也可以用读出来的 rev 0 覆盖 */
export function saveTierLendSettings(by: TierLendEditor, input: { rev: number; acceptDowngrade: boolean }, now: number,
  path = TIER_LEND_SETTINGS_PATH): TierLendSave {
  const no = tierLendEditProblem(by);
  if (no) return { ok: false, code: "forbidden", error: no };
  const cur = readTierLendSettings(path);
  if (cur.status === "unreadable") return { ok: false, code: "io", error: `读不了设置文件，没有保存：${cur.error}` };
  if (cur.settings.rev !== input.rev) return { ok: false, code: "conflict", error: "设置刚被别处改过，请刷新后再改", current: cur.settings };
  const next: TierLendSettings = { v: 1, acceptDowngrade: input.acceptDowngrade, rev: cur.settings.rev + 1, updatedAt: now,
    updatedBy: by.kind === "web" ? "owner" : by.actor };
  try {
    writeJsonAtomicSync(path, next, { commitIf: () => readTierLendSettings(path).settings.rev === cur.settings.rev });
  } catch (e) {
    return { ok: false, code: "io", error: `保存失败，没有生效：${(e as Error).message}` };
  }
  return { ok: true, settings: next };
}
