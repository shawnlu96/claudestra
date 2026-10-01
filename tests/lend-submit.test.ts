/** T94 `lend submit`：只收这张单的 worker 交的结论（src/lib/lend-submit.ts） */
import { describe, expect, test } from "bun:test";
import { linkSync, mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { advance, getOrder, openLendJournal, recordAsked } from "../src/lib/lend-journal.js";
import { ancestorsIn, commitLendResult, readReportIn, submitLendResult, type SubmitterDeps } from "../src/lib/lend-submit.js";

const HEAD = "a".repeat(40);
const root = mkdtempSync(join(tmpdir(), "lend-sub-"));
const DIR = join(root, "work", "o1");
mkdirSync(join(DIR, "src"), { recursive: true });

function started() {
  const db = openLendJournal(":memory:");
  recordAsked(db, { orderId: "o1", peer: "team-a", fp: null, family: "codex", preview: {} }, 0);
  advance(db, "o1", "asked", "claimed", { wire: { order: { orderId: "o1", head: HEAD, taskId: "T93" }, text: "x" }, leaseGen: 3 });
  advance(db, "o1", "claimed", "cloned", { dir: DIR });
  advance(db, "o1", "cloned", "started", { agent: "agent-lend-x", sessionId: "thr-1" });
  return db;
}

const deps = (over: Partial<SubmitterDeps> = {}): SubmitterDeps => ({
  cwd: join(DIR, "src"), pid: 500, agentSession: () => "thr-1", panePid: async () => 100, ancestors: async () => [400, 300, 100, 1], ...over,
});
const finding = { findingId: "F1", family: "correctness", severity: "P1", probe: "跑 x", description: "y 坏了" };
const input = { verdict: "changes", findings: [finding], report: "# 报告\n正文" };

describe("T94 lend submit 绑定", () => {
  test("这张单的 worker 在自己的工作副本里交：记成 result_pending，请求体带租约代数、会话、固定 reportPath", async () => {
    const db = started();
    const r = await submitLendResult(db, "o1", input, deps());
    expect(r).toMatchObject({ ok: true, duplicate: false });
    const row = getOrder(db, "o1")!;
    expect(row.state).toBe("result_pending");
    expect(row.payload).toMatchObject({ v: 1, orderId: "o1", gen: 3, session: { id: "thr-1", family: "codex" },
      verdict: { orderId: "o1", head: HEAD, verdict: "changes", p1: 1, reportPath: "report.md" } });
  });

  test("不在工作副本里 / 会话换了 / 不是从 worker 窗口里跑的：都拒，journal 不变", async () => {
    for (const over of [{ cwd: root }, { cwd: "/tmp" }, { agentSession: () => "thr-2" }, { ancestors: async () => [400, 1] }, { panePid: async () => null }]) {
      const db = started();
      const r = await submitLendResult(db, "o1", input, deps(over));
      expect(r.ok).toBe(false);
      expect(getOrder(db, "o1")!.state).toBe("started");
    }
  });

  test("同一份结论重交 = 幂等；换了内容 = 拒（不重复提交）", async () => {
    const db = started();
    const first = await submitLendResult(db, "o1", input, deps());
    expect(await submitLendResult(db, "o1", input, deps())).toEqual({ ok: true, duplicate: true, sha: (first as { sha: string }).sha });
    const other = await submitLendResult(db, "o1", { ...input, report: "改过的" }, deps());
    expect(other).toMatchObject({ ok: false });
  });

  test("还没起 worker / 已结束的单不收；结论格式不对不收（计数由 findings 算、pass 不能带 P1）", async () => {
    const db = started();
    expect(await submitLendResult(db, "nope", input, deps())).toMatchObject({ ok: false });
    expect(await submitLendResult(db, "o1", { ...input, verdict: "pass" }, deps())).toMatchObject({ ok: false });
    expect(await submitLendResult(db, "o1", { ...input, findings: "x" }, deps())).toMatchObject({ ok: false });
    expect(await submitLendResult(db, "o1", { ...input, report: "x".repeat(70 * 1024) }, deps())).toMatchObject({ ok: false });
    advance(db, "o1", "started", "stopped", { reason: "t" });
    expect(await submitLendResult(db, "o1", input, deps())).toMatchObject({ ok: false });
  });

  test("ps 输出 → 祖先链：由近到远，断链 / 成环就停", () => {
    const ps = "  500   400\n  400   300\n  300   100\n  100     1\n  7   8\n  8   7\n";
    expect(ancestorsIn(ps, 500)).toEqual([400, 300, 100]);
    expect(ancestorsIn(ps, 7)).toEqual([8, 7]);
    expect(ancestorsIn(ps, 999)).toEqual([]);
  });
});

describe("i28-W4 公共提交核心与报告读取", () => {
  test("commitLendResult：首交落 result_pending；同正文重交幂等、不再写；换了正文拒", () => {
    const db = started();
    const first = commitLendResult(db, getOrder(db, "o1")!, input);
    expect(first).toMatchObject({ ok: true, duplicate: false });
    const at = getOrder(db, "o1")!.updatedAt;
    expect(commitLendResult(db, getOrder(db, "o1")!, input, at + 10)).toEqual({ ok: true, duplicate: true, sha: (first as { sha: string }).sha });
    expect(getOrder(db, "o1")!.updatedAt).toBe(at); // 幂等那次没写 journal
    expect(commitLendResult(db, getOrder(db, "o1")!, { ...input, report: "别的" })).toMatchObject({ ok: false });
  });

  test("commitLendResult：拿着旧的 started 行、另一边已经交了（CAS 输了）→ 按重读的行判，同正文幂等、不写两次", () => {
    const db = started();
    const stale = getOrder(db, "o1")!;
    commitLendResult(db, stale, input);
    expect(commitLendResult(db, stale, input)).toMatchObject({ ok: true, duplicate: true });
    expect(commitLendResult(db, stale, { ...input, report: "别的" })).toMatchObject({ ok: false });
  });

  const copy = join(root, "work", "rp");
  mkdirSync(join(copy, "sub"), { recursive: true });
  const outside = join(root, "secret.txt");
  writeFileSync(outside, "SECRET");
  writeFileSync(join(copy, "report.md"), "# 报告");
  writeFileSync(join(copy, "sub", "r2.md"), "二");
  symlinkSync(outside, join(copy, "link.md"));
  symlinkSync(join(copy, "report.md"), join(copy, "inner-link.md"));
  symlinkSync(root, join(copy, "dirlink"));
  linkSync(outside, join(copy, "hard.md"));
  writeFileSync(join(copy, "big.md"), "x".repeat(64 * 1024 + 1));
  writeFileSync(join(copy, "edge.md"), "x".repeat(64 * 1024));

  test("readReportIn：副本里的普通文件读得到（相对路径 / 副本内绝对路径 / 子目录）", () => {
    expect(readReportIn(copy, "report.md")).toEqual({ ok: true, text: "# 报告" });
    expect(readReportIn(copy, join(copy, "sub", "r2.md"))).toEqual({ ok: true, text: "二" });
    expect(readReportIn(copy, "edge.md")).toMatchObject({ ok: true });
  });

  test("readReportIn：软链（指出去 / 指回副本里都不收）、经软链目录出副本、硬链、..、副本外绝对路径、目录、超过 64 KiB 一律拒", () => {
    for (const p of ["link.md", "inner-link.md", "dirlink/secret.txt", "hard.md", "../../secret.txt", outside, "sub", "big.md", "nope.md", ""]) {
      const r = readReportIn(copy, p);
      expect(r.ok).toBe(false);
      expect(JSON.stringify(r)).not.toContain("SECRET");
    }
  });
});
