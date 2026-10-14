/**
 * LENDUI2 写单尾注（src/lib/lend-deps.ts writeFooter）：lendUiUpload 不是 off 才多两行「怎么交截图」（含 before 怎么拍），off 时和改动前逐字相同。
 * 开关读本机 projects.json / recovery-policy.json：测试进程的状态目录是 test-guard 换过的临时目录，写完即删。
 */
import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { lendDeps } from "../src/lib/lend-deps.js";
import { advance, openLendJournal, recordAsked } from "../src/lib/lend-journal.js";
import { PROJECTS_PATH } from "../src/lib/projects.js";
import { RECOVERY_POLICY_PATH } from "../src/lib/recovery-policy.js";
import { REPO_ROOT } from "../src/lib/repo-root.js";

const kept = [PROJECTS_PATH, RECOVERY_POLICY_PATH].map((p) => [p, existsSync(p) ? readFileSync(p, "utf8") : null] as const);
afterAll(() => { for (const [p, text] of kept) { if (text === null) rmSync(p, { force: true }); else writeFileSync(p, text); } });

function footerFor(mode: string | null): string {
  writeFileSync(PROJECTS_PATH, JSON.stringify({ projects: [{ id: "claude-orchestrator", name: "c", dirs: [REPO_ROOT] }] }));
  if (mode === null) rmSync(RECOVERY_POLICY_PATH, { force: true });
  else writeFileSync(RECOVERY_POLICY_PATH, JSON.stringify({ projects: { "claude-orchestrator": { keys: { lendUiUpload: mode } } } }));
  const db = openLendJournal(":memory:");
  recordAsked(db, { orderId: "o1", peer: "team-a", fp: null, family: "codex", preview: {} }, 0);
  const row = advance(db, "o1", "asked", "claimed", { wire: { order: { orderId: "o1", head: "a".repeat(40), taskId: "T93", step: "write" }, text: "x",
    write: { branch: "lend/T93-abcd", base: "dev" } }, leaseGen: 1 });
  return lendDeps(db, { get: () => undefined } as never, () => {}, undefined).footer(row);
}

describe("[验收线 1] 写单尾注", () => {
  test("off（没配 / 显式 off）尾注不变；observe / on 多两行：ui-shots/、before 在 origin/<base> 上拍、成对命名、--ui-shots-file", () => {
    const off = footerFor(null);
    expect(footerFor("off")).toBe(off);
    expect(off).not.toContain("ui-shots");
    for (const mode of ["observe", "on"]) {
      const f = footerFor(mode);
      expect(f.startsWith(off)).toBe(true);
      const extra = f.slice(off.length).split("\n").filter(Boolean);
      expect(extra).toHaveLength(2);
      expect(extra[0]).toContain("ui-shots/");
      expect(extra[0]).toContain("origin/dev");
      expect(extra[0]).toContain("git stash");
      expect(extra[0]).toContain("before-<状态>-<尺寸>.png");
      expect(extra[1]).toContain("--ui-shots-file ui-shots/manifest.json");
      expect(extra[1]).toContain("去掉这个参数");
    }
  });
});
