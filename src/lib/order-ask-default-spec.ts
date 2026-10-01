/** The append job is committed before touching the spec. Recovery writes only its missing suffix, never the original bytes. */
import type { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { closeSync, fsyncSync, openSync, readFileSync, writeSync } from "node:fs";
import { listAsks, patchAsk, type Ask } from "./ledger-asks.js";
import { getMeta, getTask } from "./ledger-store.js";
import { specPathFor } from "./task-spec.js";

interface AppendPlan { path: string; offset: number; prefixHash: string; section: string }
const digest = (b: Buffer) => createHash("sha256").update(b).digest("hex");
const planOf = (a: Ask) => a.extra.defaultAppendPlan as AppendPlan | undefined;

/** Called under the ledger write lock, in a separate transaction from appendDefaultSpec. */
export function prepareDefaultSpec(db: Database, a: Ask): void {
  if (planOf(a)) return;
  const task = a.taskId ? getTask(db, a.taskId) : null;
  const path = task && specPathFor(task, getMeta(db, task.project).docsDir);
  if (!path) throw new Error("规格文件不存在，保留追加任务");
  // A failed append owns this file's tail until repaired; later asks must not interleave their sections with it.
  if (listAsks(db, { states: ["answered"] }).some((x) => x.id !== a.id && x.extra.defaultAppend === "pending" && planOf(x)?.path === path)) {
    throw new Error("同一规格有未完成的追加，先恢复前一条");
  }
  const before = readFileSync(path);
  const quote = (s: string) => s.split(/\r?\n/).map((l) => `> ${l}`).join("\n");
  const section = `\n\n<!-- ask-default:${a.id} -->\n## 自动定(${new Date(Number(a.extra.defaultAt)).toISOString()})\n\n`
    + `问题原文：\n${quote(a.body)}\n\n默认做法：\n${quote(String(a.extra.default))}\n\n`
    + `结论：按执行者默认做法定。PM 若已另行答复，以规格里 PM 定为准。\n<!-- /ask-default:${a.id} -->\n`;
  patchAsk(db, a.id, { extra: { defaultAppendPlan: { path, offset: before.length, prefixHash: digest(before), section } } });
}

export function appendDefaultSpec(_db: Database, a: Ask): void {
  const plan = planOf(a);
  if (!plan) throw new Error("缺少持久化追加计划");
  const before = readFileSync(plan.path), section = Buffer.from(plan.section);
  if (digest(before.subarray(0, plan.offset)) !== plan.prefixHash) throw new Error("规格原文已变化，不改写，等待核对");
  const tail = before.subarray(plan.offset, plan.offset + section.length);
  if (!section.subarray(0, tail.length).equals(tail)) throw new Error("规格末尾已变化，不改写，等待核对");
  let written = tail.length;
  if (written === section.length) return;
  const fd = openSync(plan.path, "a");
  try {
    while (written < section.length) {
      const n = writeSync(fd, section, written, section.length - written);
      if (!n) throw new Error("规格追加未写入，下次重试");
      written += n;
    }
    fsyncSync(fd);
  } finally { closeSync(fd); }
}
