/**
 * i28-GATE3: a peer order also cuts any whole 40-char lowercase commit SHA in its inputs (not only this card's heads) to 12 chars
 * before the unchanged T87 gate, and notes how many it cut; the local report file is untouched; real secret shapes, 64-hex,
 * mixed case, UUIDs, short SHAs, hex in paths and any 40-hex on a line naming a secret are left alone (so secrets still refuse);
 * a text where a SHA is part of what the gate reads as a secret (after its folding) is not cut at all. SHAs are random per run.
 */
import type { Database } from "bun:sqlite";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { listLendOrders, offerLendCore } from "../src/lib/ledger-lend.js";
import { holdWriteLease } from "../src/lib/ledger-lend-lease.js";
import { closeLedger, getTask, LedgerError, listEvents, openLedger } from "../src/lib/ledger-store.js";
import { insertEvent } from "../src/lib/ledger-tx.js";
import { createTask } from "../src/lib/ledger-write.js";
import { shortenHeads, shortenShas } from "../src/lib/order-gate-heads.js";
import { peerSecretHit } from "../src/lib/peer-secret-gate.js";

const sha = (bytes = 20): string => randomBytes(bytes).toString("hex");
const BRANCH = "lend/T1-abcd";
const ctx = { actor: "scheduler", now: 1_000 };
const REFUSED = "派单没过外发闸（拒绝优先，留在本机做）：inputs[1] 疑似含密钥";
let db: Database;
let H: string;
const dir = mkdtempSync(join(tmpdir(), "gate-sha-"));
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

beforeEach(() => {
  H = sha();
  db = openLedger(":memory:");
  createTask(db, { actor: "owner", now: 1 }, { project: "p", id: "T1", title: "T1", kind: "code" });
  db.run("UPDATE tasks SET stage='fix', round=1, headSHA=?, branch=? WHERE id='T1'", [H, BRANCH]);
  holdWriteLease(db, task(), { peer: "mate", fp: "abcd-ef01-2345-6789", branch: BRANCH, repo: "o/r" }, 1);
  insertEvent(db, ctx, { project: "p", target: "T1", kind: "review", text: "review", data: { round: 1, head: H, verdict: "changes",
    path: "reviews/T1-r1/report.md", findings: [{ findingId: "race-1", family: "race", severity: "P1", probe: "two concurrent writes" }] } }, true);
});
afterEach(() => closeLedger(":memory:"));

describe("shortenShas", () => {
  test("whole lowercase 40-hex → 12 chars, card heads too; sentence punctuation and git ranges are boundaries", () => {
    const [a, b] = [sha(), sha()];
    expect(shortenShas(`base ${a}, head ${H}.`, new Set([H]))).toEqual({ text: `base ${a.slice(0, 12)}, head ${H.slice(0, 12)}.`, cut: 2 });
    expect(shortenShas(`(${a})：${b}。`, new Set())).toEqual({ text: `(${a.slice(0, 12)})：${b.slice(0, 12)}。`, cut: 2 });
    expect(shortenShas(`git log ${a}..${b} / ${a}...${b}`, new Set()).text)
      .toBe(`git log ${a.slice(0, 12)}..${b.slice(0, 12)} / ${a.slice(0, 12)}...${b.slice(0, 12)}`);
  });

  test("acceptance 3: UUIDs, short SHAs (7–12), hex directory / file names in paths are untouched", () => {
    const a = sha();
    for (const s of [randomUUID(), a.slice(0, 7), a.slice(0, 12), `reviews/${a}/report.md`, `C:\\work\\${a}\\x`, `.git/objects/${a}`,
      `${a}.md`, `x.${a}`, `${a}-suffix`, `pre_${a}`]) {
      expect(shortenShas(`见 ${s} 处`, new Set())).toEqual({ text: `见 ${s} 处`, cut: 0 });
    }
  });

  test("acceptance 2: secret shapes are never cut — 64-hex, 41+ hex, mixed / upper case 40, prefixed tokens", () => {
    const a = sha();
    const mixed = `Ab${a.slice(2)}`;
    for (const s of [sha(32), `${a}${sha(1)}`, mixed, a.toUpperCase(), `ghp_${a}`, `sk-${a}`, `tok_${a}`]) {
      const r = shortenShas(`粘来的 ${s} 一段`, new Set());
      expect(r).toEqual({ text: `粘来的 ${s} 一段`, cut: 0 });
      expect(peerSecretHit(r.text)).not.toBeNull();
    }
  });
});

describe("secret words on the line", () => {
  test("① a 40-hex on a head / commit / SHA line without a secret word → 12 chars", () => {
    const a = sha();
    for (const line of [`head ${a}`, `commit ${a}`, `SHA: ${a}`, `base=${a}`, `修复提交 ${a} 未覆盖`]) {
      expect(shortenShas(line, new Set())).toEqual({ text: line.replace(a, a.slice(0, 12)), cut: 1 });
    }
  });

  test("② a 40-hex on a line with a secret word (any case, bare or name=value / name: value) is not cut and the gate refuses it", () => {
    const a = sha();
    const lines = [`credential ${a}`, `token: ${a}`, `GITHUB_TOKEN=${a}`, `Secret ${a}`, `password ${a}`, `passwd=${a}`, `apikey ${a}`,
      `API key: ${a}`, `api_key=${a}`, `Auth ${a}`, `x-auth-value: ${a}`, `bearer ${a}`, `private key ${a}`, `commit ${a} (token)`];
    for (const line of lines) {
      expect(shortenShas(line, new Set())).toEqual({ text: line, cut: 0 });
      expect(peerSecretHit(line)).not.toBeNull();
    }
    // A text the gate refuses anyway is handed over whole: the commit SHA on the next line is not cut either.
    const b = sha();
    expect(shortenShas(`token: ${a}\ncommit ${b}`, new Set())).toEqual({ text: `token: ${a}\ncommit ${b}`, cut: 0 });
  });
});

describe("peer orders", () => {
  test("acceptance 1: a report with 2 full SHAs → both 12 chars in the order, local file unchanged, order passes the gate, one note", () => {
    const [base, prior] = [sha(), sha()];
    const file = join(dir, `report-${sha(4)}.md`);
    writeFileSync(file, `# Review\n对比基线 ${base}；\n上一轮修复提交 ${prior} 未覆盖并发写。\n`);
    const before = readFileSync(file);
    const o = offer(readFileSync(file, "utf8"));
    expect(readFileSync(file).equals(before)).toBe(true);
    const sent = JSON.stringify({ ...o.wire, head: null });
    for (const s of [base, prior]) {
      expect(sent).not.toContain(s);
      expect(o.text).not.toContain(s);
      expect(o.text).toContain(s.slice(0, 12));
    }
    expect(o.wire.head).toBe(H); // the order header's head field is GATE1's business and stays full
    expect(cutNotes()).toHaveLength(1);
    expect(cutNotes()[0]).toMatchObject({ kind: "note", text: expect.stringContaining("派单材料里 2 处完整 SHA 已截成 12 位"),
      data: { orderId: o.orderId, count: 2 } });
  });

  test("acceptance 2: real secret shapes beside a SHA still refuse the whole order; no note is left behind", () => {
    const a = sha();
    for (const bad of [sha(32), `Ab${sha().slice(2)}`, `ghp_${sha()}`, `${sha()}${sha(1)}`]) {
      const e = refusal(`# Review\n基线 ${a}，另见 ${bad}`);
      expect(e).toBeInstanceOf(LedgerError);
      expect(e.message).toContain(REFUSED);
    }
    expect(listLendOrders(db, "T1")).toEqual([]);
    expect(cutNotes()).toEqual([]);
  });

  test("② `credential <40hex>` / `token: <40hex>` in a report still refuse the whole order", () => {
    for (const line of [`credential ${sha()}`, `token: ${sha()}`]) {
      expect(refusal(`# Review\n基线 ${sha()}\n${line}`).message).toContain(REFUSED);
    }
    expect(listLendOrders(db, "T1")).toEqual([]);
    expect(cutNotes()).toEqual([]);
  });

  test("复现测试 (gate-context-1): a SHA the gate reads as part of a secret after its folding is not cut, so the order still refuses", () => {
    const h = "0123456789abcdef".repeat(2) + "01234567"; // fixture, not a real SHA; this card's head is a different random value
    const reports = [`sk- ${h}`, `ghp_\n${h}`, `${h}\n${"89abcdef".repeat(2)}`, `cred\u200bential ${h}`, `api key   ${h}`, `ＡＰＩ key ${h}`,
      `x\u200b${h}`, `${h}\n${sha()}`];
    for (const report of reports) {
      // The gate refused these before the cut existed; the round-1 head cut each SHA to 12 chars first and they went out pooled.
      expect(peerSecretHit(shortenHeads(report, new Set([H])).normalize("NFKC").replace(/\u200b/g, ""))).not.toBeNull();
      expect(shortenShas(report, new Set([H]), H)).toEqual({ text: report, cut: 0 });
      expect(refusal(`# Review\n${report}`).message).toContain(REFUSED);
    }
    expect(listLendOrders(db, "T1")).toEqual([]);
    expect(cutNotes()).toEqual([]);
  });

  test("a SHA next to short words or punctuation across blanks is still cut (only 8+ joined hex or a word char touching it holds it back)", () => {
    const a = sha();
    for (const line of [`head\n${a}`, `added in ${a} . fade`, `→ ${a} ←`, `a: ${a}\n- b`]) {
      expect(shortenShas(line, new Set(), H)).toEqual({ text: line.replace(a, a.slice(0, 12)), cut: 1 });
    }
  });

  test("acceptance 3: a foreign 40-hex inside a path is not cut, so it still refuses", () => {
    expect(refusal(`# Review\n产物在 reviews/${sha()}/report.md`).message).toContain(`${REFUSED}（长十六进制）`);
  });

  test("复现测试 (acceptance 4): TV1 round-1 report shape → refused before the fix, offered after", () => {
    const [base, fixCommit] = [sha(), sha()];
    // Shape of TV1's round-1 review (fixture, no real SHA): base and an earlier commit quoted in full, plus this card's head.
    const report = [
      "## 结论：changes（P1 1 / P2 1）",
      `审查范围：main@${base}..${H}（只看本 PR 净改动）`,
      `- P1 race-1：${fixCommit} 引入的写路径在并发下丢更新；复现见 tests/tv1.test.ts:42`,
      "- P2 doc-1：注释与实现不符",
    ].join("\n");
    // Before: GATE2 only cut this card's heads, so the base / earlier commit stayed whole and the gate refused the order.
    expect(peerSecretHit(shortenHeads(report, new Set([H])))).toBe("长十六进制");
    // After: every commit SHA is cut and the order goes out.
    expect(peerSecretHit(shortenShas(report, new Set([H])).text)).toBeNull();
    const o = offer(report);
    expect(o.status).toBe("pooled");
    for (const s of [base, fixCommit]) expect(o.text).not.toContain(s);
    expect(cutNotes()[0]!.data.count).toBe(3);
  });
});
