/**
 * 任务规格卡的定位与读取：`ledger dispatch` / `review-pack`（manager）和 bridge 的班子路由共用同一份，
 * 保证「规格卡要不要对抗式」两边读的是同一个来源（改了一边，路由和审查包就会对同一次 pass 下相反的结论）。
 * tests/task-spec.test.ts。
 */
import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import type { LedgerTask } from "./ledger-stages.js";
import { reviewPolicy } from "./review-pack.js";

/** 读得到就给全文，否则 null；读失败只打一行（规格卡 / 上一轮 md 缺了只让输出少几行，不值得让调用方失败） */
export function readTextSoft(path: string | null): string | null {
  if (!path || !existsSync(path)) return null;
  try {
    return readFileSync(path, "utf-8");
  } catch (e) {
    console.error(`⚠️ 读不到 ${path}：${(e as Error).message}`);
    return null;
  }
}

/** 规格卡：任务上记的是存在的绝对路径就用它，否则 <docsDir>/tasks/<T>.md；都没有为 null */
export function specPathFor(task: Pick<LedgerTask, "id" | "spec">, docsDir: string | null): string | null {
  if (task.spec && isAbsolute(task.spec) && existsSync(task.spec)) return task.spec;
  const p = docsDir ? join(docsDir, "tasks", `${task.id}.md`) : null;
  return p && existsSync(p) ? p : null;
}

/**
 * 规格卡正文的审查策略：string = 写了「审查：」；null = 没写、也没提对抗式；
 * undefined = 不知道（没有正文，或提到「对抗」却读不出「审查：」——不能当成不要对抗式）
 */
export function policyFromSpec(text: string | null): string | null | undefined {
  if (text === null) return undefined;
  return reviewPolicy(text) ?? (text.includes("对抗") ? undefined : null);
}

/** 任务规格卡的审查策略（policyFromSpec）；找不到规格卡 = undefined */
export function specPolicyOf(task: Pick<LedgerTask, "id" | "spec">, docsDir: string | null): string | null | undefined {
  return policyFromSpec(readTextSoft(specPathFor(task, docsDir)));
}
