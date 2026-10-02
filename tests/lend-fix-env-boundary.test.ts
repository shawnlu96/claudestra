import { expect, test } from "bun:test";
import { holdWriteLease, writeOrderWire } from "../src/lib/ledger-lend-lease.js";
import { offerLendCore, listLendOrders } from "../src/lib/ledger-lend.js";
import { closeLedger, getTask, openLedger } from "../src/lib/ledger-store.js";
import { createTask } from "../src/lib/ledger-write.js";
import { insertEvent } from "../src/lib/ledger-tx.js";
import { writeMaterials } from "../src/lib/lend-write-materials.js";
import { bounceWork } from "../src/lib/scheduler-merge-conflict.js";

const H = "a".repeat(40), BASE = "b".repeat(40), SHA = "c".repeat(40), PR = "d".repeat(40), MAIN = "e".repeat(40), branch = "lend/T1-abcd";

async function fixture(error: string) {
  const db = openLedger(":memory:");
  createTask(db, { actor: "owner", now: 1 }, { project: "p", id: "T1", title: "修复", kind: "code" });
  db.run("UPDATE tasks SET stage='fix',round=1,headSHA=?,branch=? WHERE id='T1'", [H, branch]);
  const task = getTask(db, "T1")!;
  holdWriteLease(db, task, { peer: "mate", fp: "abcd-ef01-2345-6789", branch, repo: "o/r" }, 1);
  const bounce = { cause: "update_fail" as const, prHead: PR, mainHead: MAIN, checks: [], error };
  insertEvent(db, { actor: "scheduler", now: 2 }, { project: "p", target: "T1", kind: "stage", text: "bounce",
    data: { from: "merge", to: "fix", round: 1, mergeBounce: bounce } }, true);
  const write = (await writeMaterials(db, task, { peer: "mate", repo: "o/r", base: "main" }, {
    peerFp: async () => "abcd-ef01-2345-6789", remoteHead: async () => ({ ok: true, head: BASE }),
  }))!;
  const input = { taskId: "T1", peer: "mate", family: "codex" as const, repo: "o/r", pr: 7, spec: "规格",
    borrow: { peer: "mate", projects: ["p"], roles: ["write" as const], maxOpen: 1 }, write };
  const wire = writeOrderWire(task, { orderId: "fix:T1", step: "fix", head: H, branch, base: "main", spec: "规格",
    report: write.report, findings: [], repo: "o/r", pr: 7, bounce: bounceWork({ ...bounce, prHead: PR.slice(0, 12) }) });
  return { db, wire, offer: () => offerLendCore(db, { actor: "scheduler", now: 3 }, input),
    orders: () => listLendOrders(db, "T1"), close: () => closeLedger(":memory:") };
}

const cases = [
  `sk-${SHA}`, `opaque-${SHA}-suffix`, `Cookie: sid=opaque!${SHA}!suffix`, `Cookie: sid=opaque:${SHA}:suffix`,
  `sk- ${SHA}`, `sk-\t${SHA}`, `sk-${BASE}`, `sk-g${BASE}Z`, `opaque-${BASE}-suffix`, `Cookie: sid=opaque!${BASE}!suffix`,
  ...["_", ".", "/", "+", "="].flatMap((c) => [`x${c}${SHA}`, `${SHA}${c}x`]),
  ...[H, BASE, PR, MAIN].flatMap((sha) => [sha, `commit ${sha} refused`, `(${sha})`, `commit:${sha}, refused`, `"${sha}"`]),
];
for (const error of cases) {
  test(`hex-bearing error ${error.slice(0, 8)} is withheld whole and real offer pools`, async () => {
    const f = await fixture(error);
    try {
      const inputs = f.wire.inputs.join("\n");
      expect(inputs).not.toContain(error);
      expect(inputs).not.toContain("SHA 已缩为 12 位");
      expect(inputs).toContain("update_fail");
      expect(inputs).toContain("原文含提交号，留在发起方台账");
      expect(inputs).toMatch(/本机事件 #\d+/);
      const order = f.offer();
      expect(order.status).toBe("pooled");
      if (error !== H) expect(order.text).not.toContain(error);
      const event = f.db.query("SELECT seq,data FROM events WHERE kind='stage'").get() as { seq: number; data: string };
      expect(JSON.parse(event.data).mergeBounce.error).toBe(error);
      expect(inputs).toContain(`本机事件 #${event.seq}`);
    } finally { f.close(); }
  });
}

test("non-hex error reaches the order byte for byte", async () => {
  const error = "HTTP 422: GitHub refused update (permission denied)";
  const f = await fixture(error);
  try {
    expect(f.wire.inputs.join("\n")).toContain(error);
    expect(f.offer().status).toBe("pooled");
  } finally { f.close(); }
});

for (const code of ["missing_field", "1234", SHA, `prefix${SHA}suffix`, `sk-${"Q".repeat(20)}`]) {
  test(`safe status/code summary ${code.slice(0, 8)} contains no original hex-bearing text`, async () => {
    const error = `HTTP 422 GitHub code: ${code}; commit ${SHA} refused`;
    const f = await fixture(error);
    try {
      const inputs = f.wire.inputs.join("\n");
      expect(inputs).toContain("HTTP 422");
      expect(inputs).not.toContain(error);
      expect(inputs).not.toContain(SHA);
      if (["missing_field", "1234"].includes(code)) expect(inputs).toContain(`GitHub 错误码 ${code}`);
      else expect(inputs).not.toContain("GitHub 错误码");
      expect(f.offer().status).toBe("pooled");
    } finally { f.close(); }
  });
}
