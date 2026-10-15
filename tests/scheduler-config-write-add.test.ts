/** ONB-3 patchAddProject（lib/scheduler-config-write.ts）：只追加一段；已有段原样不动；改完过不了校验就不出文本。 */
import { describe, expect, test } from "bun:test";
import { LedgerError } from "../src/lib/ledger-store.js";
import { patchAddProject } from "../src/lib/scheduler-config-write.js";

const RAW = JSON.stringify({ enabled: true, x: 1, projects: { a: { maxActiveWorkers: 1, requiredChecks: ["ci"], repoDir: "/r/a" } } }, null, 2) + "\n";
const SEG = { maxActiveWorkers: 2, requiredChecks: ["cargo test"], repoDir: "/r/b", localMerge: true };

describe("patchAddProject", () => {
  test("追加新段：其它键原样、缩进与换行沿用", () => {
    const r = patchAddProject(RAW, "b", SEG);
    expect(r.changed).toBe(true);
    expect(r.from).toBeNull();
    const before = JSON.parse(RAW), after = JSON.parse(r.text);
    expect(after).toEqual({ ...before, projects: { ...before.projects, b: SEG } });
    expect(r.text.startsWith('{\n  "enabled"')).toBe(true);
    expect(r.text.endsWith("}\n")).toBe(true);
  });
  test("已有段：不动，返回文件里的值，文本逐字节不变", () => {
    const r = patchAddProject(RAW, "a", SEG);
    expect(r).toMatchObject({ changed: false, text: RAW, from: { maxActiveWorkers: 1 } });
  });
  test("改完过不了校验（localMerge 配 deploy）、项目 id 不合法：拒", () => {
    for (const [id, seg] of [["b", { ...SEG, deploy: { restartLabels: ["x"], timeoutMs: 1000 } }], ["b/../c", SEG]] as const) {
      expect(() => patchAddProject(RAW, id, seg)).toThrow(LedgerError);
    }
  });
});
