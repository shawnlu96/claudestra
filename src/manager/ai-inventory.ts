/**
 * `manager ai-inventory [--json] [--limit N]`（T91）：本机装了哪些 agent 运行时、实际接哪家哪个模型、订阅额度还剩多少。
 * 只读：取数在 lib/ai-inventory.ts；默认人读输出，--json 给程序（出借声明取数、远端交结论附身份）。
 */
import { collectAiInventory } from "../lib/ai-inventory.js";
import { formatAiInventory } from "../lib/ai-inventory-format.js";
import { output, outputSync } from "./core.js";

export async function cmdAiInventory(args: string[]): Promise<void> {
  const i = args.indexOf("--limit");
  const n = i >= 0 ? Number(args[i + 1]) : NaN;
  if (i >= 0 && !(Number.isInteger(n) && n > 0 && n <= 5000)) {
    output({ ok: false, error: "usage: ai-inventory [--json] [--limit <1-5000>]" });
    return;
  }
  const inv = await collectAiInventory(i >= 0 ? { limit: n } : {});
  if (args.includes("--json")) outputSync({ ok: true, ...inv });
  else console.log(formatAiInventory(inv));
}
