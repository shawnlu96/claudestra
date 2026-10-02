/**
 * 「自动定」一节怎么追加进规格：先把计划（文件、偏移、前缀哈希、整节文字）落库，再按计划用 O_APPEND 只写缺的尾巴——只追加，从不改写
 * 已有字节（验收线 5，改写 = P0）。崩溃在中途：下次核对前缀哈希与已写的那段，补齐剩下的。
 * 计划失效（规格在两次尝试之间被改过）：文件里还没有本条的起始标记 → 抛 SpecReplan，按当前文件末尾重新计划；
 * 已经有完整的一节 → 算写完；只有半截又被改过 → 抛错计次，到次数线由 order-ask-default.ts 投递给 PM、之后退避重试。tests/order-ask-default.test.ts。
 */
import type { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { closeSync, fsyncSync, openSync, readFileSync, writeSync } from "node:fs";
import { listAsks, patchAsk, type Ask } from "./ledger-asks.js";
import { getMeta, getTask } from "./ledger-store.js";
import { specPathFor } from "./task-spec.js";

/** i28-ASK4 测试类扩围（order-ask-default.ts isTestScopeAsk）的自动定：一节里写申请的文件和理由，不写默认做法 */
const REASON_TEXT: Record<string, string> = { superseded_assertion: "被本规格替代的旧断言", new_test: "为本卡新行为补测试" };
export const testScopeFiles = (a: Ask): string[] | null =>
  a.extra.autoScope === true && Array.isArray(a.extra.files) ? a.extra.files.map(String) : null;

interface AppendPlan { path: string; offset: number; prefixHash: string; section: string }
const digest = (b: Buffer) => createHash("sha256").update(b).digest("hex");
const planOf = (a: Ask) => (a.extra.defaultAppendPlan ?? undefined) as AppendPlan | undefined;
const startMarker = (id: string) => `<!-- ask-default:${id} -->`;

/** 计划作废、可以按当前文件末尾重来（文件里没有本条的任何完整标记） */
export class SpecReplan extends Error {}
/** 同一规格前一条追加还没完成：排队等它，不算本条失败 */
export class SpecBusy extends Error {}

/** Called under the ledger write lock, in a separate transaction from appendDefaultSpec. */
export function prepareDefaultSpec(db: Database, a: Ask): void {
  if (planOf(a)) return;
  const task = a.taskId ? getTask(db, a.taskId) : null;
  const path = task && specPathFor(task, getMeta(db, task.project).docsDir);
  if (!path) throw new Error("找不到规格文件路径，保留追加任务");
  // A failed append owns this file's tail until repaired; later asks must not interleave their sections with it.
  if (listAsks(db, { states: ["answered"] }).some((x) => x.id !== a.id && x.extra.defaultAppend === "pending" && planOf(x)?.path === path)) {
    throw new SpecBusy("同一规格有未完成的追加，先恢复前一条");
  }
  const before = readFileSync(path);
  const quote = (s: string) => s.split(/\r?\n/).map((l) => `> ${l}`).join("\n");
  const files = testScopeFiles(a);
  const decided = files
    ? `申请加进范围的测试文件（${REASON_TEXT[String(a.extra.reason)] ?? String(a.extra.reason)}）：\n${files.map((f) => `- \`${f}\``).join("\n")}\n\n`
      + "结论：测试类扩围自动批准，以上文件已追加进本卡 fileGlobs。PM 若已另行答复，以规格里 PM 定为准。"
    : `默认做法：\n${quote(String(a.extra.default))}\n\n结论：按执行者默认做法定。PM 若已另行答复，以规格里 PM 定为准。`;
  const section = `\n\n${startMarker(a.id)}\n## 自动定（${new Date(Number(a.extra.defaultAt)).toISOString()}）\n\n`
    + `问题原文：\n${quote(a.body)}\n\n${decided}\n<!-- /ask-default:${a.id} -->\n`;
  patchAsk(db, a.id, { extra: { defaultAppendPlan: { path, offset: before.length, prefixHash: digest(before), section } } });
}

/** 计划和文件对不上时：整节已在 → 写完；连起始标记都没有 → 重新计划；只有半截 → 不动文件，交上层计次 */
function staleOutcome(file: Buffer, a: Ask, plan: AppendPlan, why: string): "done" {
  if (file.includes(Buffer.from(plan.section))) return "done";
  if (!file.includes(Buffer.from(startMarker(a.id)))) throw new SpecReplan(`${why}，按当前末尾重新计划`);
  throw new Error(`${why}，且本条只写了半截，不改写，交 PM 核对`);
}

export function appendDefaultSpec(a: Ask): void {
  const plan = planOf(a);
  if (!plan) throw new Error("缺少持久化追加计划");
  const before = readFileSync(plan.path), section = Buffer.from(plan.section);
  if (before.length < plan.offset || digest(before.subarray(0, plan.offset)) !== plan.prefixHash) {
    staleOutcome(before, a, plan, "规格原文已变化");
    return;
  }
  const tail = before.subarray(plan.offset, plan.offset + section.length);
  if (!section.subarray(0, tail.length).equals(tail)) {
    staleOutcome(before, a, plan, "规格末尾已变化");
    return;
  }
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
