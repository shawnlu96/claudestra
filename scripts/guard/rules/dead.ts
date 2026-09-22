// 死导出：包一层 knip（它自己没有 baseline 模式）。每个未使用的导出/类型/文件一个 key，
// 出现新的就失败，--update 删掉已经消失的。knip 是可选 devDependency，缺席时本规则跳过。
import { existsSync } from "fs";
import { join } from "path";
import type { Counts, RuleResult } from "../types.ts";

interface KnipIssue {
  file: string;
  exports?: { name: string }[];
  types?: { name: string }[];
  files?: unknown[];
}

/** knip --reporter json 的输出 → `dead:<file>#<name>` 计数。 */
export function parseKnip(json: string): Counts {
  const data = JSON.parse(json) as { files?: string[]; issues?: KnipIssue[] };
  const counts: Counts = {};
  for (const f of data.files ?? []) counts[`dead:${f}#<file>`] = 1;
  for (const issue of data.issues ?? []) {
    for (const e of [...(issue.exports ?? []), ...(issue.types ?? [])]) counts[`dead:${issue.file}#${e.name}`] = 1;
    if ((issue.files ?? []).length) counts[`dead:${issue.file}#<file>`] = 1;
  }
  return counts;
}

function knipBin(root: string): string | null {
  const bin = process.env.GUARD_KNIP || join(root, "node_modules", ".bin", "knip");
  return existsSync(bin) ? bin : null;
}

export function measureDead(root: string): RuleResult {
  const bin = knipBin(root);
  if (!bin) return { counts: {}, skipped: "knip 未安装（devDependency 声明了但没装），跳过死导出检查" };
  const args = ["--config", "scripts/guard/knip.json", "--include", "files,exports,types", "--reporter", "json", "--no-exit-code"];
  const p = Bun.spawnSync([bin, ...args], { cwd: root, stdout: "pipe", stderr: "pipe" });
  const out = p.stdout.toString().trim();
  try {
    return { counts: parseKnip(out) };
  } catch {
    const err = p.stderr.toString().trim().split("\n").slice(-3).join(" | ");
    return { counts: {}, skipped: `knip 输出不是 JSON（exit ${p.exitCode}）：${err.slice(0, 160)}` };
  }
}
