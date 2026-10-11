/** team-project-N8B8（收 N8B7 第 3 轮 P2）：openMirrorKeys 只把「表不存在」当作没有旧发现；别的读取错误照样返回空，但打一行固定诊断。 */
import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readMirrorPush } from "../src/lib/ledger-audit-mirror.js";

const dirs: string[] = [];
const emptyStateDir = () => { const d = mkdtempSync(join(tmpdir(), "n8b8-audit-mirror-")); dirs.push(d); return d; };
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

describe("PM 追加验收线：读旧发现失败时的降级", () => {
  test("缺表：返回空，不打诊断", () => {
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    const db = new Database(":memory:");
    try {
      expect(readMirrorPush(db, "p", emptyStateDir())).toEqual({ facts: [], open: [] });
      expect(warn).not.toHaveBeenCalled();
    } finally { db.close(); warn.mockRestore(); }
  });

  test("表在、能读：照旧返回本规则开着的 key，不打诊断", () => {
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    const db = new Database(":memory:");
    try {
      db.run("CREATE TABLE audit_findings (key TEXT, project TEXT, rule TEXT, resolvedAt INTEGER)");
      db.run("INSERT INTO audit_findings VALUES ('p|mirror_push_failing|f1|dag|x|3', 'p', 'mirror_push_failing', NULL), ('p|mirror_push_failing|f2|dag|x|3', 'p', 'mirror_push_failing', 5)");
      expect(readMirrorPush(db, "p", emptyStateDir())).toEqual({ facts: [], open: ["f1|dag|x|3"] });
      expect(warn).not.toHaveBeenCalled();
    } finally { db.close(); warn.mockRestore(); }
  });

  test("别的读取错误：返回空，打一行诊断（规则名 + 错误类别，不带库路径和错误原文）", () => {
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    const dir = emptyStateDir(), path = join(dir, "ledger-secret-name.sqlite"), db = new Database(path);
    try {
      db.run("CREATE TABLE audit_findings (key TEXT, project TEXT)"); // 表在，但缺本规则要读的列
      expect(readMirrorPush(db, "p", dir)).toEqual({ facts: [], open: [] });
      expect(warn).toHaveBeenCalledTimes(1);
      const line = String(warn.mock.calls[0]![0]);
      expect(warn.mock.calls[0]).toHaveLength(1);
      expect(line).toMatch(/^mirror_push_failing：读旧发现失败（[A-Za-z_]+），本轮按没有旧发现处理$/);
      expect(line).not.toContain(path);
      expect(line).not.toContain("ledger-secret-name");
      expect(line).not.toContain("resolvedAt");
    } finally { db.close(); warn.mockRestore(); }
  });
});
