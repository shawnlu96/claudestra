/**
 * GB1：本机自产的出借分支（lend/<卡号>-<指纹前 4 位>）只在结构化字段里（lend_orders.branch / 写租约 / claim.write），
 * 验收自由文本写「本出借单已登记的分支」。长卡号 + 非单词形指纹拼出的分支名，旧写法被外发闸当随机串整单拒掉；
 * 外来原文里同样的字样照旧拒，外发闸本身不加任何豁免。
 */
import type { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { BorrowEntry } from "../src/lib/lend-config.js";
import { getLendOrder, offerLendCore } from "../src/lib/ledger-lend.js";
import { getWriteLease, holdWriteLease, LEND_BRANCH_TEXT, writeOrderWire, type WriteOrderInput } from "../src/lib/ledger-lend-lease.js";
import { closeLedger, getTask, openLedger } from "../src/lib/ledger-store.js";
import { insertEvent } from "../src/lib/ledger-tx.js";
import { createTask } from "../src/lib/ledger-write.js";
import { lendBranch } from "../src/lib/lend-git.js";
import { peerSecretHit } from "../src/lib/peer-secret-gate.js";
import { fold, redactOrderForPeer, renderOrderWire } from "../src/lib/order-wire-render.js";
import { parseOrderWire, type OrderWire } from "../src/lib/order-wire.js";

const LONG = "dispatch-recovery-PCAP6Extra"; // 合成长卡号：含大写节点，本身是单词形标识，过 taskId 闸
const SHORT = "T1";
const FP = "b1a2-0c0c-1d1d-2e2e"; // 合成指纹：前 4 位不是单词形
const BASE = "b".repeat(40), H = "a".repeat(40);
const ctx = { actor: "scheduler", now: 1_000 };
const borrow: BorrowEntry = { peer: "mate", projects: ["p"], roles: ["write"], maxOpen: 1 };
let db: Database;

/** 改动前 writeOrderWire 的两句验收：完整分支名重复进自由文本（只用来证明旧单过不了同一道闸） */
function oldShape(w: OrderWire, branch: string): OrderWire {
  const back = (s: string) => s.replace(`切出${LEND_BRANCH_TEXT}（`, `切出分支 ${branch}（`).replace(`在${LEND_BRANCH_TEXT}上接着改`, `在分支 ${branch} 上接着改`)
    .replace(`只推${LEND_BRANCH_TEXT}，`, `只推 ${branch}，`);
  return { ...w, acceptance: w.acceptance.map(back) };
}

function card(id: string, stage: "build" | "fix"): void {
  createTask(db, { actor: "owner", now: 1 }, { project: "p", id, title: id, kind: "code" });
  if (stage === "fix") {
    const branch = lendBranch(id, FP)!;
    db.run("UPDATE tasks SET stage='fix', round=1, headSHA=?, branch=? WHERE id=?", [H, branch, id]);
    holdWriteLease(db, getTask(db, id)!, { peer: "mate", fp: FP, branch, repo: "o/r" }, 1);
    insertEvent(db, ctx, { project: "p", target: id, kind: "review", text: "review", data: { round: 0, head: H, verdict: "changes", path: "r.md",
      findings: [{ findingId: "race-1", family: "race", severity: "P1", probe: "two concurrent writes" }] } }, true);
  } else db.run("UPDATE tasks SET stage='build', round=0 WHERE id=?", [id]);
}

const input = (id: string, step: "write" | "fix", over: Partial<WriteOrderInput> = {}): WriteOrderInput => ({
  orderId: `lend:${id}:s1:r0:a0`, step, head: step === "write" ? BASE : H, branch: lendBranch(id, FP)!, base: "main", spec: "规格：只改 x", report: null,
  findings: [], repo: "o/r", pr: step === "fix" ? 7 : null, ...over,
});

/** 真实外发链：redactOrderForPeer → renderOrderWire → parseOrderWire（同 offerLendCore） */
function ship(w: OrderWire): { text: string; wire: OrderWire } {
  const wire = redactOrderForPeer(w, w.head).order;
  const text = renderOrderWire(wire, { audience: "peer", ledgerHead: w.head });
  const parsed = parseOrderWire(JSON.parse(JSON.stringify(wire)));
  if (!parsed.ok) throw new Error(parsed.error);
  return { text, wire: parsed.value };
}

beforeEach(() => { db = openLedger(":memory:"); });
afterEach(() => closeLedger(":memory:"));

describe("GB1 验收提示不重复自产分支", () => {
  const cases = [
    { name: "开工单", step: "write" as const, over: {} },
    { name: "修复单", step: "fix" as const, over: {} },
    { name: "恢复单（接着改）", step: "write" as const, over: { resume: true } },
  ];
  for (const id of [LONG, SHORT]) {
    for (const c of cases) {
      test(`${id.length > 10 ? "长" : "短"}卡号 ${c.name}：新单过外发闸且不含分支名；旧写法长卡号拒「随机串」`, () => {
        card(id, c.step === "fix" ? "fix" : "build");
        const branch = lendBranch(id, FP)!;
        const w = writeOrderWire(getTask(db, id)!, input(id, c.step, c.over));
        const { text, wire } = ship(w);
        expect(text).not.toContain(branch);
        expect(wire.acceptance[0]).toContain(LEND_BRANCH_TEXT);
        expect(wire.acceptance[0]).toContain(c.step === "write" && !("resume" in c.over) ? "从基线 main 切出" : "上接着改");
        expect(wire.acceptance[0]).toContain("起点是标题里的 head");
        expect(w.acceptance[1]).toBe(`只动这一个分支：推送由出借服务做，只推${LEND_BRANCH_TEXT}，不推 main、不改别的分支`);
        expect(wire.acceptance[1]).toBe(fold(w.acceptance[1]));
        const old = oldShape(w, branch);
        expect(old.acceptance[0]).toContain(branch);
        if (id === LONG) expect(() => redactOrderForPeer(old, w.head)).toThrow(/acceptance\[0\] 疑似含密钥（随机串）/);
        else expect(() => redactOrderForPeer(old, w.head)).not.toThrow();
      });
    }
  }

  test("提示 diff 只在两句验收：其余字段与分支名无关，换分支整单逐字相同", () => {
    card(LONG, "build");
    const t = getTask(db, LONG)!;
    const a = writeOrderWire(t, input(LONG, "write"));
    const b = writeOrderWire(t, input(LONG, "write", { branch: "lend/other-ffff" }));
    expect(b).toEqual(a);
    const old = oldShape(a, lendBranch(LONG, FP)!);
    expect({ ...old, acceptance: old.acceptance.slice(2) }).toEqual({ ...a, acceptance: a.acceptance.slice(2) });
    expect(old.acceptance.slice(0, 2)).not.toEqual(a.acceptance.slice(0, 2));
  });
});

describe("GB1 真实挂单：分支仍完整在结构化字段", () => {
  for (const stage of ["build", "fix"] as const) {
    test(`长卡号 ${stage}：offerLendCore 过闸，lend_orders.branch / 写租约 = lendBranch 原值，正文与 wire 不含分支名`, () => {
      card(LONG, stage);
      const o = offerLendCore(db, ctx, { taskId: LONG, peer: "mate", family: "codex", repo: "o/r", pr: stage === "fix" ? 7 : null, spec: "规格：只改 x",
        borrow, write: { fp: FP, base: "main", baseSha: stage === "build" ? BASE : null, report: null } });
      const branch = lendBranch(LONG, FP)!;
      expect(branch).toBe(`lend/${LONG}-b1a2`);
      expect(getLendOrder(db, o.orderId)).toMatchObject({ branch, base: "main", step: stage === "build" ? "write" : "fix" });
      expect(getWriteLease(db, LONG)).toMatchObject({ peer: "mate", fp: FP, branch, state: "held" });
      expect(o.text).not.toContain(branch);
      expect(JSON.stringify(o.wire)).not.toContain(branch);
    });
  }
});

describe("GB1 外来原文不豁免", () => {
  const offer = (spec: string) => offerLendCore(db, ctx, { taskId: LONG, peer: "mate", family: "codex", repo: "o/r", pr: null, spec, borrow,
    write: { fp: FP, base: "main", baseSha: BASE, report: null } });

  test("规格原文里同样的长分支字样 / 随机串仍拒「随机串」，不建单不留租约", () => {
    card(LONG, "build");
    const branch = lendBranch(LONG, FP)!;
    expect(peerSecretHit(fold(branch))).toBe("随机串");
    expect(() => offer(`请推到 ${branch}`)).toThrow(/inputs\[0\] 疑似含密钥（随机串）/);
    expect(() => offer("token Zq8xLmN3pR7vKt2YwB9cHd4FgJ6sUe1A")).toThrow(/随机串/);
    expect(getWriteLease(db, LONG)).toBeNull();
  });

  test("合成密钥令牌与未登记完整 SHA 照旧拒；登记的 head 原值在自由文本里照旧放行", () => {
    card(LONG, "build");
    expect(() => offer(`key ghp_${"A1b2C3d4".repeat(4)}`)).toThrow(/密钥前缀/);
    const w = writeOrderWire(getTask(db, LONG)!, input(LONG, "write"));
    expect(() => redactOrderForPeer({ ...w, inputs: [...w.inputs, `对比 ${"c".repeat(40)}`] }, BASE)).toThrow(/长十六进制/);
    expect(() => redactOrderForPeer({ ...w, inputs: [...w.inputs, `起点 ${BASE}`] }, BASE)).not.toThrow();
  });
});
