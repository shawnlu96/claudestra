import { expect, test } from "bun:test";
import { holdWriteLease, writeOrderWire } from "../src/lib/ledger-lend-lease.js";
import { offerLendCore, listLendOrders } from "../src/lib/ledger-lend.js";
import { closeLedger, getTask, openLedger } from "../src/lib/ledger-store.js";
import { createTask } from "../src/lib/ledger-write.js";
import { insertEvent } from "../src/lib/ledger-tx.js";
import { writeMaterials } from "../src/lib/lend-write-materials.js";
import { bounceWork } from "../src/lib/scheduler-merge-conflict.js";

const H = "a".repeat(40), BASE = "b".repeat(40), SHA = "c".repeat(40), branch = "lend/T1-abcd";

async function fixture(error: string) {
  const db = openLedger(":memory:");
  createTask(db, { actor: "owner", now: 1 }, { project: "p", id: "T1", title: "修复", kind: "code" });
  db.run("UPDATE tasks SET stage='fix',round=1,headSHA=?,branch=? WHERE id='T1'", [H, branch]);
  const task = getTask(db, "T1")!;
  holdWriteLease(db, task, { peer: "mate", fp: "abcd-ef01-2345-6789", branch, repo: "o/r" }, 1);
  const bounce = { cause: "update_fail" as const, prHead: H, mainHead: null, checks: [], error };
  insertEvent(db, { actor: "scheduler", now: 2 }, { project: "p", target: "T1", kind: "stage", text: "bounce",
    data: { from: "merge", to: "fix", round: 1, mergeBounce: bounce } }, true);
  const write = (await writeMaterials(db, task, { peer: "mate", repo: "o/r", base: "main" }, {
    peerFp: async () => "abcd-ef01-2345-6789", remoteHead: async () => ({ ok: true, head: BASE }),
  }))!;
  const input = { taskId: "T1", peer: "mate", family: "codex" as const, repo: "o/r", pr: 7, spec: "规格",
    borrow: { peer: "mate", projects: ["p"], roles: ["write" as const], maxOpen: 1 }, write };
  const wire = writeOrderWire(task, { orderId: "fix:T1", step: "fix", head: H, branch, base: "main", spec: "规格",
    report: write.report, findings: [], repo: "o/r", pr: 7, bounce: bounceWork({ ...bounce, prHead: H.slice(0, 12) }) });
  return { wire, offer: () => offerLendCore(db, { actor: "scheduler", now: 3 }, input),
    orders: () => listLendOrders(db, "T1"), close: () => closeLedger(":memory:") };
}

for (const token of [`sk-${SHA}`, `opaque-${SHA}-suffix`, ...["_", ".", "/", "+", "="].flatMap((c) => [`x${c}${SHA}`, `${SHA}${c}x`])]) {
  test(`embedded token ${token.slice(0, 8)} remains intact and real offer refuses`, async () => {
    const f = await fixture(token);
    try {
      expect(f.wire.inputs.join("\n")).toContain(token);
      expect(f.wire.inputs.join("\n")).not.toContain("SHA 已缩为 12 位");
      expect(f.offer).toThrow(/疑似含密钥/);
      expect(f.orders()).toEqual([]);
    } finally { f.close(); }
  });
}

for (const error of [SHA, `commit ${SHA} refused`, `(${SHA})`, `commit:${SHA}, refused`, `"${SHA}"`, `‘${SHA}’`]) {
  test(`independent SHA in ${error.slice(0, 8)} still passes a real offer`, async () => {
    const f = await fixture(error);
    try {
      expect(f.wire.inputs.join("\n")).not.toContain(SHA);
      expect(f.wire.inputs.join("\n")).toContain(`${SHA.slice(0, 12)}（SHA 已缩为 12 位）`);
      expect(f.offer().status).toBe("pooled");
    } finally { f.close(); }
  });
}
