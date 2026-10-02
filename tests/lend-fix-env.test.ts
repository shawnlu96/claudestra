import { expect, test } from "bun:test";
import { lendFixEnv, lendFixMaterials } from "../src/lib/lend-fix-env.js";
import { writeOrderWire } from "../src/lib/ledger-lend-lease.js";
import type { LedgerTask } from "../src/lib/ledger-stages.js";
import { renderOrderWire } from "../src/lib/order-wire-render.js";
import { bounceWork } from "../src/lib/scheduler-merge-conflict.js";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeLedger, getTask, openLedger } from "../src/lib/ledger-store.js";
import { createTask } from "../src/lib/ledger-write.js";
import { insertEvent } from "../src/lib/ledger-tx.js";
import { writeMaterials } from "../src/lib/lend-write-materials.js";

const H = "a".repeat(40), BASE = "b".repeat(40), ERROR_SHA = H;
const task = { id: "T1", specRev: 1, round: 1 } as LedgerTask;
for (const cause of ["conflict", "update_fail"] as const) {
  test(`${cause}: verified baseline instructions replace fetch and worker push`, async () => {
    const material = await lendFixMaterials("abcd", { repo: "o/r", base: "main" }, {
      peerFp: async () => "abcd", remoteHead: async () => ({ ok: true, head: BASE }),
    });
    const wire = writeOrderWire(task, { orderId: "fix:T1", step: "fix", head: H, branch: "lend/T1-abcd", base: "main", spec: "规格",
      report: material.report, findings: [], repo: "o/r", pr: 7,
      bounce: bounceWork({ cause, prHead: H.slice(0, 12), mainHead: BASE.slice(0, 12), checks: [], error: `GitHub rejected commit ${ERROR_SHA}` }) });
    const text = renderOrderWire(wire, { audience: "peer", ledgerHead: H });
    expect(text).not.toContain("git fetch");
    expect(text).not.toContain("推送后报新 head");
    expect(text).toContain("refs/remotes/origin/HEAD");
    expect(text).toContain("git rev-parse");
    expect(text).toContain(BASE.slice(0, 12));
    expect(text).toContain("SHA 前 12 位");
    expect(text).toContain("基线 ref 缺失或 SHA 不符就停止");
    expect(text).toContain("禁止改 git 配置");
    expect(text).toContain("deliver 报新 head");
    if (cause === "update_fail") {
      expect(text).toContain("更新分支失败");
      expect(text).toContain(`GitHub rejected commit ${ERROR_SHA.slice(0, 12)}`);
      expect(text).toContain("SHA 已缩为 12 位");
      expect(wire.inputs.join("\n")).not.toContain(ERROR_SHA);
    }
  });
}

test("missing or invalid baseline SHA instructs a stop, never assumes default branch is main", async () => {
  for (const result of [{ ok: false as const, error: "unavailable" }, { ok: true as const, head: "invalid" }]) {
    const w = await lendFixMaterials("abcd", { repo: "o/r", base: "main" }, { peerFp: async () => "abcd", remoteHead: async () => result });
    expect(w.report).toContain("未能核定基线 SHA，停止");
    expect(w.report).not.toContain("最新 main");
  }
});

test("ordinary fix is unchanged; embedded secret-like tokens are still refused", () => {
  const wire = writeOrderWire(task, { orderId: "fix:T1", step: "fix", head: H, branch: "lend/T1-abcd", base: "main", spec: "规格",
    report: "P1 原文", findings: [], repo: "o/r", pr: 7 });
  expect(lendFixEnv(wire, null, null)).toBe(wire);
  const bounce = bounceWork({ cause: "update_fail", prHead: H.slice(0, 12), mainHead: null, checks: [], error: `token_${"c".repeat(40)}_suffix` });
  const unsafe = lendFixEnv({ ...wire, inputs: bounce.inputs }, bounce, null);
  expect(() => renderOrderWire(unsafe, { audience: "peer", ledgerHead: H })).toThrow(/疑似含密钥/);
});

test("ordinary fix reads the exact report file and preserves every byte without querying a baseline", async () => {
  const dir = mkdtempSync(join(tmpdir(), "lend-fix-env-")), path = join(dir, "ledger.sqlite");
  const db = openLedger(path), reportPath = join(dir, "review.md"), original = "# 审查原文\r\n  P1: 保留空白  \n";
  try {
    writeFileSync(reportPath, original);
    createTask(db, { actor: "owner", now: 1 }, { project: "p", id: "T1", title: "修复", kind: "code" });
    db.run("UPDATE tasks SET stage='fix' WHERE id='T1'");
    insertEvent(db, { actor: "owner", now: 2 }, { project: "p", target: "T1", kind: "review", text: "审查",
      data: { path: reportPath, findings: [] } }, true);
    const material = await writeMaterials(db, getTask(db, "T1")!, { peer: "mate", repo: "o/r", base: "main" }, {
      peerFp: async () => "abcd", remoteHead: async () => { throw new Error("ordinary fix must not query a baseline"); },
    });
    expect(material).toEqual({ fp: "abcd", base: "main", baseSha: null, report: original });
  } finally { closeLedger(path); rmSync(dir, { recursive: true, force: true }); }
});
