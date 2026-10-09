/**
 * RVHEX1：每种审查单（本机常规、本机对抗式、出借池）都经 convergeOrderLines 带同一句「哈希只写前 16 位」，
 * 这一句本身过外发闸、不超行宽；submit_verdict 的 probe / description 字段说明带简写。反例（闸不放宽）见 review-hash-line-materials.test.ts。
 */
import type { Database } from "bun:sqlite";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import { listLendOrders, offerLendCore } from "../src/lib/ledger-lend.js";
import { closeLedger, getTask, openLedger } from "../src/lib/ledger-store.js";
import { createTask } from "../src/lib/ledger-write.js";
import { ORDER_TOOLS } from "../src/lib/order-tools.js";
import { fold, peerTextRefusal, redactOrderForPeer, renderOrderWire } from "../src/lib/order-wire-render.js";
import { parseOrderWire, WIRE_LIMITS, WIRE_MAX_BYTES, type OrderWire } from "../src/lib/order-wire.js";
import { HASH_LINE } from "../src/lib/review-converge-order.js";
import { reviewOrderOf } from "../src/lib/review-order.js";

const P = "claude-orchestrator";
const H = "b".repeat(40);
const dir = mkdtempSync(join(tmpdir(), "review-hash-line-"));
let db: Database;

function localOrder(node: string): OrderWire {
  const r = reviewOrderOf(db, { task: getTask(db, "T9")!, orderId: `T9:${node}:r1`, node, head: H, auto: false }, dir);
  if (!r.ok) throw new Error(r.error);
  return r.order;
}
function poolOrder(): { wire: OrderWire; text: string } {
  offerLendCore(db, { actor: "scheduler", now: 1_000 }, { taskId: "T9", peer: "mate", family: "codex", repo: "shawnlu96/claudestra", pr: 12,
    spec: "规格", borrow: { peer: "mate", projects: [P], roles: ["review"], maxOpen: 1 } });
  const o = listLendOrders(db, "T9")[0]!;
  return { wire: o.wire, text: o.text };
}

beforeEach(() => {
  db = openLedger(":memory:");
  const spec = join(dir, "T9.md");
  writeFileSync(spec, "# T9\n\n## 验收线\n1. 不误判\n");
  createTask(db, { actor: "owner", now: 1_000 }, { project: P, id: "T9", title: "T9", kind: "code", spec });
  db.run(`UPDATE tasks SET stage = 'review', headSHA = '${H}', round = 1 WHERE id = 'T9'`);
});
afterEach(() => closeLedger(":memory:"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe("RVHEX1 审查单都带短哈希这一句", () => {
  test("这一句本身：行宽内、外发闸不拦、意思齐全", () => {
    expect(Buffer.byteLength(HASH_LINE)).toBeLessThanOrEqual(WIRE_LIMITS.line);
    expect(peerTextRefusal(HASH_LINE)).toBeNull();
    for (const part of ["probe", "前 16 位", "12–16 位短号", "head", "本机", "外发闸整单拒收"]) expect(HASH_LINE).toContain(part);
    for (const part of ["description", "<scratchpad>/相对路径", "前8位", "本机原始工件", "用户名", "主机名", "系统临时绝对前缀",
      "head/orderId/sessionId", "身份", "签名", "reportPath", "真实完整绝对路径"]) expect(HASH_LINE).toContain(part);
  });

  test("本机常规审查、本机对抗式审查：派单文本含这一句，整单合规且仍过外发闸", () => {
    for (const node of ["review", "adversarial_review"]) {
      const o = localOrder(node);
      expect(o.inputs).toContain(HASH_LINE);
      expect(renderOrderWire(o, { audience: "local" })).toContain(HASH_LINE);
      expect(renderOrderWire(o, { audience: "peer", ledgerHead: H })).toContain(fold(HASH_LINE));
      expect(parseOrderWire(JSON.parse(JSON.stringify(o))).ok).toBe(true);
      expect(Buffer.byteLength(JSON.stringify(o))).toBeLessThanOrEqual(WIRE_MAX_BYTES);
      expect(() => redactOrderForPeer(o, H)).not.toThrow();
    }
  });

  test("出借池审查单：offer 过了外发闸，acceptance 与 offer 文本含这一句（闸折叠后）", () => {
    const { wire, text } = poolOrder();
    expect(wire.acceptance).toContain(fold(HASH_LINE));
    expect(text).toContain(fold(HASH_LINE));
    expect(parseOrderWire(JSON.parse(JSON.stringify(wire))).ok).toBe(true);
    expect(() => redactOrderForPeer(wire, H)).not.toThrow();
  });

  test("submit_verdict 的 probe / description 字段说明带简写", () => {
    const tool = ORDER_TOOLS.find((t) => t.name === "submit_verdict") as any;
    const props = tool.inputSchema.properties.findings.items.properties;
    for (const key of ["probe", "description"]) {
      expect(props[key].description).toContain("只写前 16 位");
      expect(props[key].description).toContain(HASH_LINE);
      expect(props[key].description).toContain("<scratchpad>/相对路径");
      expect(props[key].description).toContain("前8位");
    }
  });
});
