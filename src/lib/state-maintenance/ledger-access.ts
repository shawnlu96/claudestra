/**
 * 维护对台账的两处读写:核点击者角色(只认本卡项目的真实 PM 与 owner,复用 ledger roleOf),写结果指针 note。
 * note 只带 op、版本、runId、mode、结果、报告相对路径与哈希;dedupKey 按 runId+op(+ 结果版本 seq>1),补记幂等。
 * 打开即关:执行器的子进程用完马上 closeLedger,迁移期间不留台账句柄。执行器主进程不 import 本模块(它的依赖图带身份模块)。
 * tests/state-maintenance-entry.test.ts。
 */

import { readdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { closeLedger, getEventByDedup, getMeta, getTask, LEDGER_PATH, openLedger } from "../ledger-store.js";
import { roleOf } from "../ledger-stages.js";
import { appendEvent } from "../ledger-write.js";
import { ensureDir, FILE_MODE, maintPaths, validRunId } from "./paths.js";

/** 本卡:维护结果指针记在这里,角色也按它的项目核 */
const CARD_ID = "rename-floka-STATE2";

export interface PointerNote {
  op: "state_maintenance_observe" | "state_maintenance_run" | "state_maintenance_recover";
  version: string;
  runId: string;
  /** 同一 run 的第几版结果(恢复后的新结果另记一条,不覆盖旧指针);缺省即 1 */
  seq?: number;
  mode: string;
  result: string;
  reportRel: string;
  reportSha256: string;
  actor: string;
}

function withLedger<T>(path: string, fn: (db: ReturnType<typeof openLedger>) => T): T {
  const db = openLedger(path);
  try {
    return fn(db);
  } finally {
    closeLedger(path);
  }
}

/** actor 在本卡上的角色是不是 owner / 项目 PM;调度助理(master)、执行者、普通管理权限一律不行 */
export function maintenanceRoleRefusal(actor: string, ledgerPath: string = LEDGER_PATH): string | null {
  return withLedger(ledgerPath, (db) => {
    const task = getTask(db, CARD_ID);
    if (!task) return `台账里没有 ${CARD_ID},核不了角色,拒绝`;
    const role = roleOf(actor, task, getMeta(db, task.project).pms);
    return role === "owner" || role === "pm" ? null : `只给本项目 PM / owner,${actor} 是 ${role ?? "无角色"},拒绝`;
  });
}

/** 写完关掉台账,再重新打开核一次指针确实落库(关了再核,不在同一个句柄里自证) */
function writePointerNote(n: PointerNote, ledgerPath: string = LEDGER_PATH): void {
  const dedupKey = `state-maint:${n.runId}:${n.op}${seqSuffix(n)}`;
  appendPointer(n, dedupKey, ledgerPath);
  const back = withLedger(ledgerPath, (db) => getEventByDedup(db, dedupKey));
  if (!back || (back.data as { reportSha256?: unknown }).reportSha256 !== n.reportSha256) throw new Error("指针写入后复核不到,按未落库处理");
}

const seqSuffix = (n: PointerNote): string => (Number.isInteger(n.seq) && n.seq! > 1 ? `:${n.seq}` : "");

function appendPointer(n: PointerNote, dedupKey: string, ledgerPath: string): void {
  withLedger(ledgerPath, (db) => {
    const task = getTask(db, CARD_ID);
    if (!task) throw new Error(`台账里没有 ${CARD_ID}`);
    const { actor, ...data } = n;
    appendEvent(db, { actor, dedupKey }, {
      project: task.project, target: CARD_ID, kind: "note",
      text: `状态根维护 ${n.op.replace("state_maintenance_", "")}:${n.result}(报告 ${n.reportRel})`, data,
    });
  });
}

const pendingDir = (root: string): string => join(maintPaths(root).control, "pending-notes");

/** 指针落库失败:留根外待补记录,恢复按钮幂等补记 */
function savePendingNote(root: string, n: PointerNote): void {
  if (!validRunId(n.runId)) throw new Error("runId 不合法");
  ensureDir(pendingDir(root));
  writeFileSync(join(pendingDir(root), `${n.runId}.${n.op}${seqSuffix(n)}.json`), JSON.stringify(n), { mode: FILE_MODE });
}

/** 补记全部待补指针;成功的删掉待补记录。返回仍未补上的条数与原因 */
export function flushPendingNotes(root: string, ledgerPath: string = LEDGER_PATH): { done: number; failed: string[] } {
  let names: string[];
  try {
    names = readdirSync(pendingDir(root)).filter((n) => n.endsWith(".json"));
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return { done: 0, failed: [] };
    throw e;
  }
  let done = 0;
  const failed: string[] = [];
  for (const name of names) {
    const path = join(pendingDir(root), name);
    try {
      writePointerNote(JSON.parse(readFileSync(path, "utf8")) as PointerNote, ledgerPath);
      unlinkSync(path);
      done++;
    } catch (e) {
      failed.push(`${name}:${(e as Error).message}`);
    }
  }
  return { done, failed };
}

/** 先写 note,失败转待补;返回是否已落库 */
export function recordPointer(root: string, n: PointerNote, ledgerPath: string = LEDGER_PATH): { ok: true } | { ok: false; error: string } {
  try {
    writePointerNote(n, ledgerPath);
    return { ok: true };
  } catch (e) {
    const error = (e as Error).message;
    try {
      savePendingNote(root, n);
    } catch (e2) {
      return { ok: false, error: `${error};待补记录也没写成:${(e2 as Error).message}` };
    }
    return { ok: false, error };
  }
}
