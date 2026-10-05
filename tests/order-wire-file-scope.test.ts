import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { listLendOrders } from "../src/lib/ledger-lend.js";
import { holdWriteLease, writeOrderWire } from "../src/lib/ledger-lend-lease.js";
import { closeLedger, getTask, openLedger } from "../src/lib/ledger-store.js";
import { createTask, setMeta } from "../src/lib/ledger-write.js";
import { insertEvent } from "../src/lib/ledger-tx.js";
import { lendRequest } from "../src/lib/lend-remote.js";
import { wholeInputs } from "../src/lib/order-wire-chunks.js";
import { redactOrderForPeer, renderOrderWire } from "../src/lib/order-wire-render.js";
import { WIRE_LIMITS, type OrderWire } from "../src/lib/order-wire.js";
import { runLedger } from "../src/manager/ledger.js";

const P = "scope-test", REPO = "example/repo", HEAD = "b".repeat(40), FP = "abcd-ef01-2345-6789", BRANCH = "lend/T9-abcd";
const LABEL = "本单文件范围";
const GLOBS = ["tests/Z*.test.ts", "src/lib/**", "src/one.ts", "tests/Z*.test.ts"];
const parts = (o: OrderWire) => o.inputs.filter((s) => s.startsWith(LABEL));
const scope = (o: OrderWire): unknown => JSON.parse(parts(o).map((s) => s.slice(s.indexOf("\n") + 1)).join(""));
let db: Database, dir: string, dbPath: string, specPath: string;

// Real ledger CLI handlers, with every remote dependency replaced and all files under a disposable ledger directory.
const run = (args: string[], actor = "pm") => runLedger(args, {
  db, actor, projectIds: [P], now: () => 1_000_000,
  loadRegistry: async () => ({ socket: "", agents: {} }), saveRegistry: async () => {},
  lend: {
    borrow: async () => [{ peer: "mate", projects: [P], roles: ["write" as const], maxOpen: 2 }], notifyPm: async () => {},
    result: {
      reportDir: () => dir, writeReport: (p: string, b: string) => writeFileSync(p, b), sign: () => ({ key: "KEY", sig: "SIG" }),
      remoteHead: async () => ({ ok: true as const, head: HEAD }), peerFp: async () => FP,
    },
  },
}) as Promise<Record<string, any>>;
const offer = () => run(["lend-offer", "T9", "--peer", "mate", "--repo", REPO]);
const setScope = (value: unknown) => db.run("UPDATE tasks SET extra = ? WHERE id = 'T9'", [JSON.stringify({ fileGlobs: value })]);
function fix(): void {
  const path = join(dir, "review.md");
  writeFileSync(path, "Review: fix the missing scope; old suggestion src/feedback.ts is not a grant.");
  insertEvent(db, { actor: "reviewer", now: 2 }, { project: P, target: "T9", kind: "review", text: "changes",
    data: { round: 0, verdict: "changes", path, findings: [] } }, true);
  db.run("UPDATE tasks SET stage = 'fix', headSHA = ?, branch = ?, round = 1 WHERE id = 'T9'", [HEAD, BRANCH]);
  holdWriteLease(db, getTask(db, "T9")!, { peer: "mate", fp: FP, branch: BRANCH, repo: REPO }, 1_000_000);
}
async function receive(orderId: string) {
  const got = await lendRequest(async (_peer, op, body) => {
    const { ok, notified: _notified, ...rest } = await run([`lend-${op}`, "--", "mate", JSON.stringify(body)], "owner");
    return { status: 200, body: JSON.parse(JSON.stringify({ ok, ...rest })) };
  }, "borrower", "claim", { orderId, worker: "scope-worker" });
  if (!got.ok) throw new Error(JSON.stringify(got));
  return got.value;
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "order-file-scope-"));
  dbPath = join(dir, "ledger.db");
  db = openLedger(dbPath);
  specPath = join(dir, "spec.md");
  writeFileSync(specPath, "Implement the requested behavior; verify the result.");
  setMeta(db, { actor: "owner", now: 1 }, { project: P, key: "pms", value: ["pm"] });
  createTask(db, { actor: "owner", now: 1 }, { project: P, id: "T9", title: "scope", kind: "code", spec: specPath });
  db.run("UPDATE tasks SET stage = 'build' WHERE id = 'T9'");
});
afterEach(() => { closeLedger(dbPath); rmSync(dir, { recursive: true, force: true }); });

describe("canonical scope through formal write/fix orders", () => {
  for (const step of ["write", "fix"] as const) {
    for (const spec of ["No file list here.", "Old scope: src/obsolete.ts"]) {
      test(`${step}: CLI offer and fake peer claim carry card scope despite spec: ${spec}`, async () => {
        writeFileSync(specPath, spec);
        setScope(GLOBS);
        if (step === "fix") fix();
        const offered = await offer();
        expect(offered).toMatchObject({ ok: true, step });
        const received = await receive(offered.orderId);
        expect(scope(received.order)).toEqual(GLOBS);
        expect(received.order.inputs[0]).toContain(spec);
        if (step === "fix") expect(received.order.inputs.join("\n")).toContain("src/feedback.ts is not a grant");
        expect(received.order).toMatchObject({ taskId: "T9", specRev: 1, head: HEAD, step, round: step === "fix" ? 1 : 0 });
        for (const glob of GLOBS) expect(received.text).toContain(glob);
        expect(received.sha256).toBe(createHash("sha256").update(received.text).digest("hex"));
        expect(listLendOrders(db, "T9")[0]).toMatchObject({ wire: received.order, text: received.text, sha256: received.sha256 });
        expect(getTask(db, "T9")!.extra.fileGlobs).toEqual(GLOBS);
      });
    }

    test(`${step}: a multi-chunk list arrives complete and ordered`, async () => {
      const globs = Array.from({ length: 150 }, (_, i) => `src/path-${i}/${"subdir/".repeat(16)}*.ts`);
      setScope(globs);
      if (step === "fix") fix();
      const offered = await offer();
      expect(offered.ok).toBe(true);
      const received = await receive(offered.orderId);
      expect(parts(received.order).length).toBeGreaterThan(1);
      expect(scope(received.order)).toEqual(globs);
      for (const p of parts(received.order)) expect(Buffer.byteLength(p)).toBeLessThanOrEqual(WIRE_LIMITS.input);
      for (const g of globs) expect(received.text).toContain(g);
    });

    test(`${step}: old cards are explicitly unregistered, never an empty grant`, async () => {
      if (step === "fix") fix();
      const offered = await offer();
      expect(offered.ok).toBe(true);
      const received = await receive(offered.orderId);
      expect(parts(received.order)).toEqual([]);
      expect(received.text).toContain("未登记文件范围");
      expect(received.text).toContain("不代表全仓授权");
    });
  }

  test.each([null, [], "src/**", [1], ["src/x.ts", null], ["bad path"], ["../escape"], ["src//x"], [""]].map((bad) => ({ bad })))(
    "malformed registered scope refuses without creating an order: %j", async ({ bad }) => {
      setScope(bad);
      expect(await offer()).toMatchObject({ ok: false, code: "invalid" });
      expect(listLendOrders(db, "T9")).toEqual([]);
    },
  );

  test("existing order and digest remain fixed; next formal offer reads the new registered scope", async () => {
    setScope(GLOBS);
    const first = await offer();
    const original = listLendOrders(db, "T9")[0]!;
    setScope(["src/new*.ts"]);
    const received = await receive(first.orderId);
    expect(scope(received.order)).toEqual(GLOBS);
    expect(received.sha256).toBe(original.sha256);
    expect(await run(["lend-cancel", "T9", "--reason", "new registered scope"])).toMatchObject({ ok: true });
    const next = await offer();
    expect(next).toMatchObject({ ok: true });
    const fresh = await receive(next.orderId);
    expect(scope(fresh.order)).toEqual(["src/new*.ts"]);
    expect(fresh.sha256).not.toBe(original.sha256);
    const old = listLendOrders(db, "T9").find((o) => o.orderId === first.orderId)!;
    expect({ wire: old.wire, text: old.text, sha256: old.sha256 }).toEqual({ wire: original.wire, text: original.text, sha256: original.sha256 });
  });

  test("over-budget list refuses the whole offer without truncation", async () => {
    setScope(Array.from({ length: 200 }, (_, i) => `src/path-${i}/${"subdir/".repeat(25)}*.ts`));
    const refused = await offer();
    expect(refused).toMatchObject({ ok: false, code: "invalid" });
    expect(refused.error).toContain("32768");
    expect(listLendOrders(db, "T9")).toEqual([]);
  });

  test.each(["src/ghp_" + "x".repeat(24), "src/10.0.0.1/*.ts"])("sensitive scope cannot be masked into a different grant: %s", async (glob) => {
    setScope([glob]);
    expect(await offer()).toMatchObject({ ok: false, code: "invalid" });
    expect(listLendOrders(db, "T9")).toEqual([]);
  });

  test("scope participates in whole-source scanning; all other free text still traverses the same gate", () => {
    setScope(GLOBS);
    const task = getTask(db, "T9")!;
    const input = { orderId: "lend:T9:s1:r0:a0", step: "fix" as const, head: HEAD, branch: BRANCH, base: "main",
      spec: "spec", report: "review report retained", findings: [], repo: REPO, pr: null };
    const wire = writeOrderWire(task, input);
    expect(scope(wire)).toEqual(GLOBS);
    expect(scope(writeOrderWire(task, input, wholeInputs))).toEqual(GLOBS);
    expect(wire.inputs.join("\n")).toContain(input.report);
    const secret = "ghp_" + "x".repeat(24);
    for (const field of ["inputs", "acceptance", "writeBack"] as const) {
      const tainted = { ...wire, [field]: field === "writeBack" ? secret : [...wire[field], secret] };
      expect(() => redactOrderForPeer(tainted, HEAD)).toThrow(/外发拒绝/);
    }
    expect(renderOrderWire(wire, { audience: "peer", ledgerHead: HEAD })).toContain("review report retained");
  });
});
