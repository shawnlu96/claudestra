/**
 * dispatch-recovery-GATE4: each commit SHA (40) and SHA-256 digest (64 lowercase hex) in an order's inputs is judged and cut to 12
 * chars on its own; one 64-hex digest no longer leaves the whole text uncut and the order refused. Real secret shapes, secret lines,
 * paths / file names, cross-blank joins, other lengths and non-hex look-alikes still reach the gate whole and refuse. Fixtures are
 * synthetic and random per run (same shape as the CFG r6 report: head / 父提交 / merge-base / SHA256 lines plus a bare hex run).
 */
import type { Database } from "bun:sqlite";
import { createHash, randomBytes } from "node:crypto";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { listLendOrders, offerLendCore } from "../src/lib/ledger-lend.js";
import { holdWriteLease } from "../src/lib/ledger-lend-lease.js";
import { closeLedger, getTask, LedgerError, listEvents, openLedger } from "../src/lib/ledger-store.js";
import { insertEvent } from "../src/lib/ledger-tx.js";
import { createTask } from "../src/lib/ledger-write.js";
import { shortenShas } from "../src/lib/order-gate-heads.js";
import { fold } from "../src/lib/order-wire-render.js";
import { peerSecretHit } from "../src/lib/peer-secret-gate.js";

const sha = (bytes = 20): string => randomBytes(bytes).toString("hex");
const BRANCH = "lend/T1-abcd";
const ctx = { actor: "scheduler", now: 1_000 };
const REFUSED = "派单没过外发闸（拒绝优先，留在本机做）：inputs[1] 疑似含密钥";
const SENSITIVE = "credential-store.internal";
let db: Database;
let H: string;
const dir = mkdtempSync(join(tmpdir(), "gate4-"));
const task = () => getTask(db, "T1")!;
const offer = (report: string) => offerLendCore(db, ctx, {
  taskId: "T1", peer: "mate", family: "codex", repo: "o/r", pr: 7, spec: "规格：只改 src/lib/x.ts",
  borrow: { peer: "mate", projects: ["p"], roles: ["write"], maxOpen: 1 },
  write: { fp: "abcd-ef01-2345-6789", base: "main", baseSha: null, report },
});
const refusal = (report: string): LedgerError => {
  try { offer(report); } catch (e) { return e as LedgerError; }
  throw new Error("offer was not refused");
};
const cutNotes = () => listEvents(db, { target: "T1" }).filter((e) => e.data.op === "sha_cut");
/** CFG r6 shape: head / parent / merge-base / SHA256 lines and a bare digest (synthetic values). */
const r6 = (head: string, parent: string, base: string, digest: string, bare: string): string => [
  "## 结论：changes（P1 1）",
  `head: ${head}`,
  `父提交: ${parent}`,
  `merge-base: ${base}`,
  `SHA256: ${digest}`,
  `产物摘要 ${bare}`,
  "- P1 race-1：并发写丢更新；复现见 tests/x.test.ts:42",
].join("\n");

beforeEach(() => {
  H = sha();
  db = openLedger(":memory:");
  createTask(db, { actor: "owner", now: 1 }, { project: "p", id: "T1", title: "T1", kind: "code" });
  db.run("UPDATE tasks SET stage='fix', round=1, headSHA=?, branch=? WHERE id='T1'", [H, BRANCH]);
  holdWriteLease(db, task(), { peer: "mate", fp: "abcd-ef01-2345-6789", branch: BRANCH, repo: "o/r" }, 1);
  insertEvent(db, ctx, { project: "p", target: "T1", kind: "review", text: "review", data: { round: 1, head: H, verdict: "changes",
    path: "reviews/T1-r1/report.md", findings: [{ findingId: SENSITIVE, family: "race", severity: "P1", probe: "two concurrent writes" }] } }, true);
});
afterEach(() => closeLedger(":memory:"));

describe("shortenShas: each SHA on its own", () => {
  test("复现测试 (CFG r6 shape): 40-hex head / parent / merge-base and 64-hex digests → 12 chars each; was all uncut and refused", () => {
    const [p, b, d, x] = [sha(), sha(), sha(32), sha(32)];
    const report = r6(H, p, b, d, x);
    // Before GATE4 a 64-hex digest was never cut, so the gate read 长十六进制 in the text and refused it whole.
    expect(peerSecretHit(fold(report), H)).toBe("长十六进制");
    const r = shortenShas(report, new Set([H]), H);
    expect(r).toEqual({ text: r6(H.slice(0, 12), p.slice(0, 12), b.slice(0, 12), d.slice(0, 12), x.slice(0, 12)), cut: 5 });
    expect(peerSecretHit(fold(r.text), H)).toBeNull();
    // Idempotent: a 12-char prefix is never a candidate again.
    expect(shortenShas(r.text, new Set([H]), H)).toEqual({ text: r.text, cut: 0 });
  });

  test("a SHA the gate would read as a secret stays whole; the other SHAs in the same text are still cut (and the gate still refuses)", () => {
    const [a, d] = [sha(), sha(32)];
    for (const bad of [`ghp_\n${sha()}`, `${sha(32)}\n${"89abcdef".repeat(2)}`, `x​${sha(32)}`, `see ${sha(32)} 89abcd ${sha()}`,
      `${sha(32)}\n${sha()}`]) {
      const text = `base ${a} 处\n${bad}\n见 SHA256: ${d}`;
      const r = shortenShas(text, new Set([H]), H);
      expect(r).toEqual({ text: text.replace(a, a.slice(0, 12)).replace(d, d.slice(0, 12)), cut: 2 });
      expect(r.text).toContain(bad);
      expect(peerSecretHit(fold(r.text), H)).not.toBeNull();
    }
  });

  test("hex the gate refuses on its own (in a path / file name, other length, upper case: not a SHA) → the text reaches the gate whole", () => {
    const [a, d] = [sha(), sha(32)];
    for (const bad of [`reviews/${sha(32)}/r.md`, `${sha(32)}.json`, sha(31), sha(32).toUpperCase()]) {
      const text = `base ${a} 处\n${bad}\n见 SHA256: ${d}`;
      expect(shortenShas(text, new Set([H]), H)).toEqual({ text, cut: 0 });
      expect(peerSecretHit(fold(text), H)).toBe("长十六进制");
    }
  });

  test("secret line, secret field or secret prefix with a 64-hex → nothing in that text is cut, the gate refuses as before", () => {
    const d = sha(32);
    for (const bad of [`token: ${sha(32)}`, `GITHUB_TOKEN=${sha(32)}`, `private key ${sha(32)}`, `sha256 secret ${sha(32)}`,
      `sk- ${sha(32)}`, `api key   ${sha(32)}`, `ＡＰＩ key ${sha(32)}`, `cred\u200bential ${sha(32)}`]) {
      const text = `SHA256: ${d}\n${bad}`;
      const r = shortenShas(text, new Set([H]), H);
      expect(r.text).toContain(bad);
      expect(peerSecretHit(fold(r.text), H)).not.toBeNull();
    }
  });

  test("other lengths, upper / mixed case, non-hex look-alikes and 64-hex in paths / names are never cut", () => {
    const d = sha(32);
    const fake = `${d.slice(0, 63)}g`;
    for (const s of [sha(24), sha(28), sha(31), sha(33), sha(64), `${d}${sha(1)}`, d.toUpperCase(), `Ab${d.slice(2)}`, fake,
      `reviews/${d}/report.md`, `C:\\work\\${d}\\x`, `${d}.md`, `x.${d}`, `${d}-suffix`, `sha256-${d}`, `pre_${d}`]) {
      expect(shortenShas(`见 ${s} 处`, new Set([H]), H)).toEqual({ text: `见 ${s} 处`, cut: 0 });
    }
    // A non-hex look-alike is the gate's business; with no SHA to cut the text is unchanged.
    expect(shortenShas(`摘要 ${fake}`, new Set(), H)).toEqual({ text: `摘要 ${fake}`, cut: 0 });
  });
});

describe("peer orders (offerLendCore, the real offer entry)", () => {
  test("CFG r6 shape → order goes out with each SHA cut, one note, local file / order head / finding alias unchanged", () => {
    const [p, b, d, x] = [sha(), sha(), sha(32), sha(32)];
    const file = join(dir, `report-${sha(4)}.md`);
    writeFileSync(file, r6(H, p, b, d, x));
    const before = createHash("sha256").update(readFileSync(file)).digest("hex");
    const o = offer(readFileSync(file, "utf8"));
    expect(createHash("sha256").update(readFileSync(file)).digest("hex")).toBe(before);
    expect(o.status).toBe("pooled");
    expect(o.wire.head).toBe(H);
    const sent = JSON.stringify({ ...o.wire, head: null });
    for (const s of [p, b, d, x]) {
      expect(sent).not.toContain(s);
      expect(o.text).toContain(s.slice(0, 12));
    }
    expect(o.wire.findings.map((f) => f.findingId)).toEqual(["F1"]);
    expect(cutNotes()).toHaveLength(1);
    expect(cutNotes()[0]!.data).toMatchObject({ orderId: o.orderId, count: 5 });
  });

  test("a real secret beside cut digests still refuses the whole order; no note or order is left behind", () => {
    for (const bad of [`token: ${sha(32)}`, `ghp_${sha()}`, `sk-${sha(32)}`, sha(32).toUpperCase(), sha(31), `${sha(32)}\n${"89abcdef".repeat(2)}`,
      `reviews/${sha(32)}/r.md`]) {
      const e = refusal(`# Review\nSHA256: ${sha(32)}\nmerge-base: ${sha()}\n${bad}`);
      expect(e).toBeInstanceOf(LedgerError);
      expect(e.message).toContain(REFUSED);
    }
    expect(listLendOrders(db, "T1")).toEqual([]);
    expect(cutNotes()).toEqual([]);
  });
});
