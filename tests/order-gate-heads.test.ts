/**
 * i28-GATE2: a peer order shortens this card's own full heads (current and earlier) in inputs to 12 chars before the T87 gate,
 * while any other long hex still refuses with the same error; the local report file is never touched; a refused id is aliased
 * out and mapped back on the verdict; a gate refusal on the scheduler's pool path leaves one alarm per card + reason.
 * Fixtures are this machine and peer A ("mate"); SHAs are random per run.
 */
import type { Database } from "bun:sqlite";
import { randomBytes } from "node:crypto";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { offerLendCore } from "../src/lib/ledger-lend.js";
import { holdWriteLease } from "../src/lib/ledger-lend-lease.js";
import { closeLedger, getTask, LedgerError, listEvents, openLedger } from "../src/lib/ledger-store.js";
import { insertEvent } from "../src/lib/ledger-tx.js";
import { createTask } from "../src/lib/ledger-write.js";
import { aliasFindings, cardHeads, recordGateRefused, shortenHeads, withOriginalIds } from "../src/lib/order-gate-heads.js";
import { parseOrderWire } from "../src/lib/order-wire.js";

const sha = (bytes = 20): string => randomBytes(bytes).toString("hex");
const BRANCH = "lend/T1-abcd";
const ctx = { actor: "scheduler", now: 1_000 };
const SENSITIVE = "credential-store.internal"; // the gate refuses it as an id (address shape) and it carries the word credential
let db: Database;
let H: string, OLD: string, OLDER: string;
const dir = mkdtempSync(join(tmpdir(), "gate-heads-"));
const task = () => getTask(db, "T1")!;
const add = (kind: "review" | "deliver" | "task", data: Record<string, unknown>) =>
  insertEvent(db, ctx, { project: "p", target: "T1", kind, text: kind, data }, true);
const offer = (report: string) => offerLendCore(db, ctx, {
  taskId: "T1", peer: "mate", family: "codex", repo: "o/r", pr: 7, spec: "规格：只改 src/lib/x.ts",
  borrow: { peer: "mate", projects: ["p"], roles: ["write"], maxOpen: 1 },
  write: { fp: "abcd-ef01-2345-6789", base: "main", baseSha: null, report },
});
const refusal = (report: string): LedgerError => {
  try { offer(report); } catch (e) { return e as LedgerError; }
  throw new Error("offer was not refused");
};

beforeEach(() => {
  H = sha(); OLD = sha(); OLDER = sha();
  db = openLedger(":memory:");
  createTask(db, { actor: "owner", now: 1 }, { project: "p", id: "T1", title: "T1", kind: "code" });
  db.run("UPDATE tasks SET stage='fix', round=1, headSHA=?, branch=? WHERE id='T1'", [H, BRANCH]);
  holdWriteLease(db, task(), { peer: "mate", fp: "abcd-ef01-2345-6789", branch: BRANCH, repo: "o/r" }, 1);
  add("deliver", { round: 0, headSHA: OLDER, evidence: null });
  add("task", { op: "set", patch: { headSHA: OLD }, rev: 3 });
  add("review", { round: 1, head: H, verdict: "changes", path: "reviews/T1-r1/report.md",
    findings: [{ findingId: "race-1", family: "race", severity: "P1", probe: "two concurrent writes" }] });
});
afterEach(() => closeLedger(":memory:"));

describe("card heads", () => {
  test("headSHA plus every head / headSHA its events recorded (deliver, task-set patch, review)", () => {
    add("review", { round: 0, head: "not-a-sha", findings: [] });
    expect([...cardHeads(db, task())].sort()).toEqual([H, OLD, OLDER].sort());
  });

  test("only whole 40 / 64 hex runs that are card heads are shortened", () => {
    const heads = new Set([H, OLD]);
    const long = sha(32);
    expect(shortenHeads(`now ${H}, was ${OLD.toUpperCase()}.`, heads)).toBe(`now ${H.slice(0, 12)}, was ${OLD.toUpperCase().slice(0, 12)}.`);
    expect(shortenHeads(`${H}aa ${H.slice(0, 39)} x${H} ${long}`, new Set([...heads, long.slice(0, 40)])))
      .toBe(`${H}aa ${H.slice(0, 39)} x${H} ${long}`);
    expect(shortenHeads(long, new Set([long]))).toBe(long.slice(0, 12));
  });
});

describe("peer orders (acceptance 1, 2, 4)", () => {
  test("current and earlier card heads in the report → order goes out with 12-char prefixes only; the local report file is unchanged", () => {
    const file = join(dir, `report-${sha(4)}.md`);
    writeFileSync(file, `# Review\n上一轮 head ${H} 上 P1 未修；\n更早在 ${OLD} 与 ${OLDER} 上已复现。\n`);
    const before = readFileSync(file);
    const o = offer(readFileSync(file, "utf8"));
    expect(readFileSync(file).equals(before)).toBe(true);
    expect(o.wire.head).toBe(H); // the head field must stay the ledger's full SHA (the gate checks it)
    const sent = JSON.stringify({ ...o.wire, head: null });
    for (const h of [H, OLD, OLDER]) {
      expect(sent).not.toContain(h);
      expect(sent).toContain(h.slice(0, 12));
    }
    expect(o.text.split("\n").filter((l) => l.includes(H))).toEqual([`head：${H}`]);
    expect(o.text).not.toContain(OLD);
    expect(o.text).not.toContain(OLDER);
    expect(parseOrderWire(JSON.parse(JSON.stringify(o.wire))).ok).toBe(true);
  });

  test("a 40-hex that is not this card's head (mixed case or in a path), or 32+ random hex other than a lowercase 40 / 64 run, still refuses with the same code and message", () => {
    // A bare lowercase 40-hex now goes out as 12 chars (i28-GATE3, tests/order-gate-heads-sha.test.ts); these shapes do not.
    const foreign = sha();
    for (const bad of [`Ab${foreign.slice(2)}`, `reviews/${foreign}/r.md`, sha(16), sha(24), sha(31), sha(33), sha(32).toUpperCase(), `${H}${sha(13)}`, `${H}${sha(1)}`]) {
      const e = refusal(`# Review\n在 ${H} 上复现，另见 ${bad}`);
      expect(e).toBeInstanceOf(LedgerError);
      expect(e.code).toBe("invalid");
      expect(e.message).toBe("派单没过外发闸（拒绝优先，留在本机做）：inputs[1] 疑似含密钥（长十六进制），peer 外发拒绝优先，留在本机审");
    }
    expect(listEvents(db, { target: "T1" }).filter((x) => x.data.op === "finding_alias")).toEqual([]);
  });

  test("a sensitive field name in inputs is still refused (the gate is not loosened)", () => {
    expect(refusal("# Review\ncredential: hunter2").message).toContain("inputs[1] 疑似含密钥（敏感字段名）");
  });
});

describe("finding id aliases (acceptance 4b)", () => {
  test("aliases skip ids already in the order; ordinary ids stay", () => {
    const f = (findingId: string) => ({ findingId, family: "x", severity: "P1" as const, probe: "p" });
    const r = aliasFindings([f(SENSITIVE), f("F1"), f("a@b.com"), f("race-1")]);
    expect(r.findings.map((x) => x.findingId)).toEqual(["F2", "F1", "F3", "race-1"]);
    expect(r.aliases).toEqual({ F2: SENSITIVE, F3: "a@b.com" });
  });

  test("a fix order with a sensitive findingId goes out as F1 and the map is kept locally by order id", () => {
    add("review", { round: 1, head: H, verdict: "changes", path: "reviews/T1-r1/report.md",
      findings: [{ findingId: SENSITIVE, family: "secrets", severity: "P1", probe: "token written to the log" }] });
    const o = offer("# Review\nP1 未修");
    expect(o.wire.findings.map((f) => f.findingId)).toEqual(["F1"]);
    expect(o.text).not.toContain(SENSITIVE);
    const req = { orderId: o.orderId, verdict: { findings: [{ findingId: "F1", family: "secrets" }, { findingId: "new-1", family: "x" }] } };
    expect(withOriginalIds(db, req).verdict.findings.map((f) => f.findingId)).toEqual([SENSITIVE, "new-1"]);
    expect(withOriginalIds(db, { ...req, orderId: "lend:T1:s1:r1:a9" })).toEqual({ ...req, orderId: "lend:T1:s1:r1:a9" });
  });
});

describe("gate refusal alarm (acceptance 3, unit)", () => {
  test("one event per card + reason; the same reason again is a duplicate; another reason is a new event", () => {
    const why = "出单被拒：派单没过外发闸（拒绝优先，留在本机做）：inputs[1] 疑似含密钥（长十六进制），peer 外发拒绝优先，留在本机审";
    const a = recordGateRefused(db, ctx, task(), why);
    expect(a.duplicate).toBe(false);
    expect(a.event).toMatchObject({ kind: "scheduler", target: "T1", data: { op: "gate_refused", waiting: expect.stringContaining("等本机执行者接手") } });
    expect(recordGateRefused(db, ctx, task(), why)).toMatchObject({ duplicate: true, event: { seq: a.event.seq } });
    expect(recordGateRefused(db, ctx, task(), why.replace("长十六进制", "敏感字段名")).duplicate).toBe(false);
    expect(listEvents(db, { target: "T1" }).filter((x) => x.data.op === "gate_refused")).toHaveLength(2);
  });
});
