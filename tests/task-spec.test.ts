/** lib/task-spec.ts：规格卡定位（任务上记的绝对路径优先，否则 docsDir/tasks/<T>.md）与审查策略的三种结果 */
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { readTextSoft, specPathFor, specPolicyOf } from "../src/lib/task-spec.js";

function docs(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "task-spec-"));
  mkdirSync(join(dir, "tasks"));
  for (const [name, text] of Object.entries(files)) writeFileSync(join(dir, "tasks", name), text);
  return dir;
}

describe("task-spec", () => {
  test("specPathFor：任务上记的绝对路径存在就用它，否则 docsDir/tasks/<T>.md；都没有为 null", () => {
    const d = docs({ "T1.md": "# T1" });
    const own = join(d, "own.md");
    writeFileSync(own, "# own");
    expect(specPathFor({ id: "T1", spec: own }, d)).toBe(own);
    expect(specPathFor({ id: "T1", spec: "tasks/T1.md" }, d)).toBe(join(d, "tasks", "T1.md"));
    expect(specPathFor({ id: "T2", spec: null }, d)).toBeNull();
    expect(specPathFor({ id: "T1", spec: null }, null)).toBeNull();
  });

  test("specPolicyOf：写了审查行 = 那一行；规格卡在但没写 = null；找不到规格卡 = undefined（不知道）", () => {
    const d = docs({ "T1.md": "# T1\n\n- 审查：Claude 审查员一轮；最后一轮对抗式\n", "T2.md": "# T2\n" });
    expect(specPolicyOf({ id: "T1", spec: null }, d)).toBe("Claude 审查员一轮；最后一轮对抗式");
    expect(specPolicyOf({ id: "T2", spec: null }, d)).toBeNull();
    expect(specPolicyOf({ id: "T3", spec: null }, d)).toBeUndefined();
    expect(readTextSoft(null)).toBeNull();
  });
});
