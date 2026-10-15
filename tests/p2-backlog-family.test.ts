/**
 * agents-P2FAM1 普通分类白名单补界面 / 键盘 / 效率 / 规范类（lib/p2-backlog.ts ORDINARY_TOKENS）。合成台账，只看 classifyP2 的归类。
 * 验收线 1：layout / keyboard / efficiency / standards / a11y / perf 等无 basis 的 P2 归普通；
 * 验收线 2：受保护组合、白名单外的 state / spec-copy、带 basis 的 layout 照旧交 PM，原因文案不变。
 */
import type { Database } from "bun:sqlite";
import { beforeEach, describe, expect, test } from "bun:test";
import { getTask, openLedger } from "../src/lib/ledger-store.js";
import { createTask, setMeta } from "../src/lib/ledger-write.js";
import { classifyP2 } from "../src/lib/p2-backlog.js";
import { tempLedgerPath } from "./ledger-test-helpers.js";

const HEAD = "a".repeat(40);
let db: Database;
type F = { findingId: string; family: string; severity: string; probe: string; basis?: string };
const p2 = (findingId: string, family: string): F => ({ findingId, family, severity: "P2", probe: `src/x.ts:${findingId} 小问题` });

function review(findings: F[]): void {
  db.prepare("INSERT INTO events (ts, actor, project, target, kind, text, data, dedupKey) VALUES (500, 'scheduler', 'p', 'T1', 'review', '', ?, NULL)")
    .run(JSON.stringify({ round: 2, head: HEAD, verdict: "pass", reviewer: "agent-rv", reviewerSessionId: "sess-1", reviewerFamily: "codex",
      path: "/reports/T1-r2.md", p0: 0, p1: 0, p2: findings.length, findings }));
}
function classes(findings: F[]): { ordinary: string[]; judge: [string, string][] } {
  review(findings);
  const r = classifyP2(db, getTask(db, "T1")!);
  if (r.kind !== "facts") throw new Error(`unreliable: ${r.why}`);
  return { ordinary: r.classes.ordinary.map((f) => f.findingId), judge: r.classes.judge.map((j) => [j.findingId, j.why]) };
}

beforeEach(() => {
  db = openLedger(tempLedgerPath("p2-family-db-"));
  setMeta(db, { actor: "owner", now: 1 }, { project: "p", key: "pms", value: ["agent-pm"] });
  createTask(db, { actor: "owner", now: 2 }, { project: "p", id: "T1", title: "卡", kind: "code", agent: "agent-exec", pm: "agent-pm" });
  db.prepare("UPDATE tasks SET stage = 'merge', round = 2, headSHA = ? WHERE id = 'T1'").run(HEAD);
});

describe("[验收线 1] 界面 / 键盘 / 效率 / 规范类 P2 归普通、进积压", () => {
  test("验收线点名的六类和规格列的其余新词元都归普通，不推 PM", () => {
    const families = ["layout", "keyboard", "efficiency", "standards", "a11y", "perf", "i18n", "l10n", "translation", "locale", "spacing", "visual",
      "ui", "ux", "overlap", "shortcut", "focus", "accessibility", "performance", "standard", "convention", "conventions", "ui-layout", "keyboard.shortcut"];
    const findings = families.map((f, i) => p2(`F${i}`, f));
    expect(classes(findings)).toEqual({ ordinary: findings.map((f) => f.findingId), judge: [] });
  });
});

describe("[验收线 2] 可能是正确性 / 越界的照旧交 PM，原因文案不变", () => {
  test("layout-auth、ui-scope 受保护先判；state、spec-copy 不在白名单；带 basis 的 layout 要 PM 看判级", () => {
    expect(classes([p2("L1", "layout-auth"), p2("U1", "ui-scope"), p2("S1", "state"), p2("C1", "spec-copy"), { ...p2("B1", "layout"), basis: "acceptance:2" }]))
      .toEqual({ ordinary: [], judge: [
        ["L1", "family layout-auth 属于范围 / 权限 / 审批 / 安全类"], ["U1", "family ui-scope 属于范围 / 权限 / 审批 / 安全类"],
        ["S1", "family state 不在普通分类白名单里，归不了类"], ["C1", "family spec-copy 不在普通分类白名单里，归不了类"],
        ["B1", "标了 acceptance:2 却定为 P2，判级要 PM 看"]] });
  });

  test("正确性类词元没混进白名单：race / correctness / data / behavior 及其与界面词的组合都交 PM", () => {
    const fams = ["race", "correctness", "data", "behavior", "spec", "layout-state", "perf-race"];
    const r = classes(fams.map((f, i) => p2(`R${i}`, f)));
    expect([r.ordinary, r.judge.map(([id]) => id)]).toEqual([[], fams.map((_, i) => `R${i}`)]);
  });
});
