/**
 * 事务日志的读写与校验。写走 state-file 的原子写(tmp + rename),读走三态读取;
 * 日志损坏、版本未知、整体校验或旧值校验对不上、步骤清单变了,一律拒绝继续——宁可停下等人,不在猜出来的状态上续跑。
 * 旧值需可无损持久化,含凭据则拒绝;诊断文本落盘前脱敏。
 */

import { createHash } from "crypto";
import { join } from "path";
import { isDeepStrictEqual } from "util";
import { redactSecrets } from "../../redact-secrets.ts";
import { readJsonState, writeJsonAtomic } from "../../state-file.ts";
import type { Journal, JournalStatus, Json, StepRecord, StepState } from "./types.ts";

export const JOURNAL_VERSION = 2;
const STATUSES: JournalStatus[] = ["running", "committed", "rolling_back", "rolled_back", "rollback_failed"];
const STEP_STATES: StepState[] = ["applying", "applied", "compensating", "compensated", "compensate_failed"];
/** 名字像凭据的字段整段遮掉(值可能不是已知 token 形态,redactSecrets 认不出) */
const SECRET_FIELD = /token|secret|password|passwd|passphrase|credential|cookie|api[_-]?key|access[_-]?key|private[_-]?key/i;

export const validTxId = (txId: string): boolean => /^[A-Za-z0-9._-]{1,128}$/.test(txId) && txId !== "." && txId !== "..";

function txPath(stateDir: string, txId: string, suffix: string): string {
  if (!validTxId(txId)) throw new Error("事务 txId 不合法");
  return join(stateDir, `${txId}.${suffix}`);
}

const journalPath = (stateDir: string, txId: string): string => txPath(stateDir, txId, "journal.json");
export const lockPath = (stateDir: string, txId: string): string => txPath(stateDir, txId, "lock");

const sha = (s: string): string => createHash("sha256").update(s).digest("hex");
const sumOf = (v: Json): string => sha(JSON.stringify(v));

function redactJson(v: Json): Json {
  if (typeof v === "string") return redactSecrets(v);
  if (Array.isArray(v)) return v.map(redactJson);
  if (v && typeof v === "object") {
    return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, SECRET_FIELD.test(k) ? "[redacted]" : redactJson(x)]));
  }
  return v;
}

export const errorText = (e: unknown): string => redactSecrets(e instanceof Error ? e.message : String(e));

export function newRecord(id: string, item: string, recovery: string, rawBefore: Json): StepRecord {
  const serialized = JSON.stringify(rawBefore);
  if (serialized === undefined || !isDeepStrictEqual(JSON.parse(serialized), rawBefore)) {
    throw new Error("旧值无法无损经过 JSON 持久化,拒绝执行");
  }
  const before = redactJson(rawBefore);
  if (JSON.stringify(before) !== JSON.stringify(rawBefore)) {
    throw new Error("旧值包含凭据,无法无损持久化;请由适配器提供不含凭据的受保护备份引用");
  }
  return { id, item, state: "applying", before, beforeSum: sumOf(before), recovery: errorText(recovery) };
}

export async function saveJournal(stateDir: string, j: Journal): Promise<void> {
  const { checksum: _drop, ...body } = j as Journal & { checksum?: string };
  await writeJsonAtomic(journalPath(stateDir, j.txId), { ...body, checksum: sha(JSON.stringify(body)) }, { mode: 0o600 });
}

export type JournalLoad = { kind: "missing" } | { kind: "bad"; error: string } | { kind: "ok"; journal: Journal };

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

function recordProblem(r: unknown, plan: string[]): string | null {
  if (!isObj(r) || typeof r.id !== "string" || !plan.includes(r.id)) return "日志里的步骤不在计划内";
  if (!STEP_STATES.includes(r.state as StepState)) return `步骤 ${r.id} 状态未知`;
  if (r.beforeSum !== sumOf(r.before as Json)) return `步骤 ${r.id} 旧值校验不符`;
  return null;
}

/** 读日志并校验;plan 是本次调用的步骤清单,和日志里的不一致说明代码 / 开关变了,不能续 */
export async function loadJournal(stateDir: string, txId: string, plan: string[]): Promise<JournalLoad> {
  const read = await readJsonState(journalPath(stateDir, txId));
  if (read.status === "missing") return { kind: "missing" };
  if (read.status === "corrupt") return { kind: "bad", error: `事务日志损坏:${read.error}` };
  const raw = read.data;
  if (!isObj(raw)) return { kind: "bad", error: "事务日志损坏:不是对象" };
  if (raw.version !== JOURNAL_VERSION) return { kind: "bad", error: `事务日志版本未知:${String(raw.version)}` };
  const { checksum, ...body } = raw;
  if (checksum !== sha(JSON.stringify(body))) return { kind: "bad", error: "事务日志校验不符(被改过或写坏)" };
  if (body.txId !== txId) return { kind: "bad", error: "事务日志的 txId 对不上" };
  if (!STATUSES.includes(body.status as JournalStatus)) return { kind: "bad", error: "事务日志状态未知" };
  if (!Array.isArray(body.plan) || JSON.stringify(body.plan) !== JSON.stringify(plan)) {
    return { kind: "bad", error: "步骤清单和事务日志对不上,拒绝续跑" };
  }
  if (!Array.isArray(body.steps)) return { kind: "bad", error: "事务日志损坏:steps 不是数组" };
  for (const [i, r] of body.steps.entries()) {
    if (!isObj(r) || r.id !== plan[i]) return { kind: "bad", error: "日志步骤重复或顺序无效" };
    const problem = recordProblem(r, plan);
    if (problem) return { kind: "bad", error: problem };
  }
  return { kind: "ok", journal: body as unknown as Journal };
}
