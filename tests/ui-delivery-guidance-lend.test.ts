/**
 * UIEVID2 [验收线 1]：ui 卡出借的开工单、普通修复单，结构化 wire 和发给 peer 的渲染正文（过外发闸后）都带出借截图指引；
 * code / security 卡不带，指引里没有本机路径 / source=local / ledger deliver。收敛单见 tests/fix-strategy-remote-ui-guidance.test.ts。
 */
import type { Database } from "bun:sqlite";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test } from "bun:test";
import type { BorrowEntry } from "../src/lib/lend-config.js";
import { listLendOrders } from "../src/lib/ledger-lend.js";
import { closeLedger, openLedger } from "../src/lib/ledger-store.js";
import { insertEvent } from "../src/lib/ledger-tx.js";
import { createTask, setMeta } from "../src/lib/ledger-write.js";
import type { RemoteHead } from "../src/lib/order-deliver.js";
import { UI_LEND_GUIDANCE } from "../src/lib/ui-delivery-guidance.js";
import { sanitizeForeign } from "../src/lib/order-wire-render.js";

/** 外发闸按 NFKC 折全角标点：peer 收到的就是这一行 */
const SENT = sanitizeForeign(UI_LEND_GUIDANCE);
import { runLedger } from "../src/manager/ledger.js";

const P = "claude-orchestrator", REPO = "shawnlu96/claudestra", FP = "abcd-ef01-2345-6789", BR = "lend/T9-abcd";
const BASE = "b".repeat(40), H2 = "c".repeat(40);
let db: Database, remote: Record<string, RemoteHead>;
const dir = mkdtempSync(join(tmpdir(), "uievid2-lend-"));
const borrow: BorrowEntry[] = [{ peer: "mate", projects: [P], roles: ["review", "write"], maxOpen: 2 }];

const deps = (actor: string) => ({
  db, actor, projectIds: [P], loadRegistry: async () => ({ socket: "", agents: {} }), saveRegistry: async () => {}, now: () => 1_000_000,
  lend: { borrow: async () => borrow, notifyPm: async () => {}, result: {
    reportDir: () => dir, writeReport: (p: string, b: string) => writeFileSync(p, b), sign: () => ({ key: "k", sig: "s" }),
    remoteHead: async (_r: string, branch: string): Promise<RemoteHead> => remote[branch] ?? { ok: false, error: "没有这个分支" },
    peerFp: async (peer: string) => (peer === "mate" ? FP : null) } },
});
const run = (args: string[], actor = "agent-pm") => runLedger(args, deps(actor)) as Promise<Record<string, any>>;

function card(template: string): void {
  const spec = join(dir, "T9.md");
  writeFileSync(spec, "规格：改设置页\n验收：截图对得上");
  createTask(db, { actor: "owner", now: 1 }, { project: P, id: "T9", title: "T9", kind: "code", spec, agent: "agent-dev" } as never);
  db.run("UPDATE tasks SET stage = 'build', round = 0 WHERE id = 'T9'");
  db.run(`INSERT INTO task_workflows (taskId, project, template, templateVersion, mode, authorFamily, fallback, specRev, createdAt, updatedAt)
    VALUES ('T9', ?, ?, 3, 'manual', 'codex', '', 1, 1, 1)`, [P, template]);
}

/** 开工单挂出去，再走到 fix（借出的分支、写租约在 mate、上一轮审查有一条 P1），挂普通修复单 */
async function writeThenFix(): Promise<void> {
  expect(await run(["lend-offer", "T9", "--peer", "mate", "--repo", REPO])).toMatchObject({ ok: true, step: "write" });
  db.run(`UPDATE tasks SET stage = 'fix', round = 1, branch = ?, headSHA = ?, pr = ? WHERE id = 'T9'`, [BR, H2, `https://github.com/${REPO}/pull/7`]);
  db.run("UPDATE lend_orders SET status = 'done' WHERE taskId = 'T9'");
  const path = join(dir, "T9-r0.md");
  writeFileSync(path, "## P1\n- race-1：并发写丢数据");
  insertEvent(db, { actor: "agent-rev", now: 2 }, { project: P, target: "T9", kind: "review", text: "changes", data: { round: 0, verdict: "changes", path,
    findings: [{ findingId: "race-1", family: "concurrency", severity: "P1", probe: "两进程同时写" }] } }, true);
  expect(await run(["lend-offer", "T9"])).toMatchObject({ ok: true, step: "fix" });
}

beforeEach(() => {
  db = openLedger(":memory:");
  remote = { main: { ok: true, head: BASE } };
  setMeta(db, { actor: "owner", now: 1 }, { project: P, key: "pms", value: ["agent-pm"] });
});
afterEach(() => closeLedger(":memory:"));

test("[验收线 1] ui 卡：开工单、普通修复单的 wire 验收与 peer 正文都带出借截图指引，各一次", async () => {
  card("ui");
  await writeThenFix();
  const orders = listLendOrders(db, "T9");
  expect(orders.map((o) => o.step)).toEqual(["write", "fix"]);
  for (const o of orders) {
    expect(o.wire.acceptance.filter((s) => s === SENT)).toHaveLength(1);
    expect(o.text).toContain(SENT);
  }
});

test.each(["code", "security"])("[验收线 1] %s 卡的出借写单不带截图指引", async (template) => {
  card(template);
  await writeThenFix();
  for (const o of listLendOrders(db, "T9")) {
    expect(o.wire.acceptance).not.toContain(SENT);
    expect(o.text).not.toContain("--ui-shots-file");
  }
});

test("出借指引只讲 peer 的上传方式：不带本机路径、source=local、ledger deliver", () => {
  for (const s of ["每轮交付", "初次写单", "普通修复", "收敛", "返借", "before", "after", "重拍", "lend submit", "--ui-shots-file"]) expect(UI_LEND_GUIDANCE).toContain(s);
  for (const s of ["source=local", "ledger deliver", "{LEDGER}", "ui-artifacts", "/"]) expect(UI_LEND_GUIDANCE).not.toContain(s);
});
