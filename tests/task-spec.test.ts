/** lib/task-spec.ts：规格卡定位（任务上记的绝对路径优先，否则 docsDir/tasks/<T>.md）与审查策略的三种结果 */
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { reviewPolicy } from "../src/lib/review-pack.js";
import { policyFromSpec, readTextSoft, specPathFor, specPolicyOf } from "../src/lib/task-spec.js";

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

/**
 * 第 3 轮复验扫出的 13 份真实规格卡（审查写在行中间 / 分隔符后 / 粗体，旧正则只认行首「- 审查：」全读成 null）：
 * 这里是各卡里那一行的原文，逐份核对解析结果；T38 没有「审查：」只有「最后一轮对抗式审查」，要判不知道。
 */
const REAL_CARDS: [string, string, string][] = [
  ["N7", "- runtime：Claude Code，Opus 5.5，effort high。审查：Claude 审查员（并发 / 消息投递类，最后一轮用对抗式审查员）。", "Claude 审查员（并发 / 消息投递类，最后一轮用对抗式审查员）。"],
  ["T12c", "- runtime：Claude Code，Opus 5.5，effort high。审查：Claude 审查员一轮；涉及安全 / 并发 / 投递的，最后一轮对抗式。", "Claude 审查员一轮；涉及安全 / 并发 / 投递的，最后一轮对抗式。"],
  ["T13b", "- runtime：Claude Code，Opus 5.5，effort high。审查：Claude 审查员（最后一轮对抗式：专找「再跑一次」会误删 / 误建的路径）。", "Claude 审查员（最后一轮对抗式：专找「再跑一次」会误删 / 误建的路径）。"],
  ["T13c", "- 执行者：待派｜分支 `task/t13c-trust-pane`｜审查：Claude 审查员 → 对抗式最后一轮（投递 + 发键）", "Claude 审查员 → 对抗式最后一轮（投递 + 发键）"],
  ["T17", "- runtime：Claude Code，Opus 5.5，effort high。审查：Claude 审查员一轮；涉及安全 / 并发 / 投递的，最后一轮对抗式。", "Claude 审查员一轮；涉及安全 / 并发 / 投递的，最后一轮对抗式。"],
  ["T18", "- runtime：Claude Code，Opus 5.5，effort high。审查：Claude 审查员一轮；涉及安全 / 并发 / 投递的，最后一轮对抗式。", "Claude 审查员一轮；涉及安全 / 并发 / 投递的，最后一轮对抗式。"],
  ["T19", "- runtime：Claude Code，Opus 5.5，effort high。审查：Claude 审查员一轮；涉及安全 / 并发 / 投递的，最后一轮对抗式。", "Claude 审查员一轮；涉及安全 / 并发 / 投递的，最后一轮对抗式。"],
  ["T20", "- runtime：Claude Code，Opus 5.5，effort high。审查：Claude 审查员一轮；涉及安全 / 并发 / 投递的，最后一轮对抗式。", "Claude 审查员一轮；涉及安全 / 并发 / 投递的，最后一轮对抗式。"],
  ["T22", "- runtime：Claude Code，Opus 5.5，effort high。审查：Claude 审查员一轮 + 最后一轮对抗式（权限 / 路径穿越）。", "Claude 审查员一轮 + 最后一轮对抗式（权限 / 路径穿越）。"],
  ["T25", "- 执行者：agent-task-t25｜分支 `task/t25-relay-trust`，从最新 origin/main 开｜审查：Claude 审查员 → **对抗式最后一轮（安全）**", "Claude 审查员 → 对抗式最后一轮（安全）"],
  ["T2b-2", "- runtime：Claude Code，Opus 5.5，effort high。审查：Claude 审查员 → 对抗式最后一轮（凭据边界）。", "Claude 审查员 → 对抗式最后一轮（凭据边界）。"],
  ["T8g", "- runtime：Claude Code，Opus 5.5，effort high。审查：Claude 审查员一轮；涉及安全 / 并发 / 投递的，最后一轮对抗式。", "Claude 审查员一轮；涉及安全 / 并发 / 投递的，最后一轮对抗式。"],
];

describe("reviewPolicy / policyFromSpec：真实规格卡的写法", () => {
  for (const [id, line, want] of REAL_CARDS) {
    test(`${id}`, () => {
      const md = `# ${id}\n- 台账：i01\n${line}\n\n## 验收\n- 单测\n`;
      expect(reviewPolicy(md)).toBe(want);
      expect(policyFromSpec(md)).toContain("对抗");
    });
  }

  test("T38：只有「最后一轮对抗式审查，重点：…」= 不知道；「对抗式审查：」不当审查策略", () => {
    const t38 = "# T38\n- 最后一轮对抗式审查，重点：lab 模式能不能被绕到生产。\n";
    expect(reviewPolicy(t38)).toBeNull();
    expect(policyFromSpec(t38)).toBeUndefined();
    expect(reviewPolicy("- 对抗式审查：只查权限\n")).toBeNull();
  });

  test("粗体、半角冒号、多处出现取第一处；没提对抗式也没写 = null；没有正文 = undefined", () => {
    expect(reviewPolicy("- **审查**：常规一轮；最后一轮对抗式\n")).toBe("常规一轮；最后一轮对抗式");
    expect(reviewPolicy("- **审查：** 常规一轮\n")).toBe("常规一轮");
    expect(reviewPolicy("审查: 常规一轮｜分支 x\n- 审查：对抗式\n")).toBe("常规一轮");
    expect(reviewPolicy("## 审查\n审查员说过的话\n")).toBeNull();
    expect(policyFromSpec("# T\n常规\n")).toBeNull();
    expect(policyFromSpec(null)).toBeUndefined();
  });
});
