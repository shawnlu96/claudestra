/** RDO1 操作摘要与结果证据纯合同（src/lib/operation-record-contract.ts）。
 * 全部是合成对象 + 假 ReceiptAuthority：这里没有、也不能证明生产持久化/事务的原子性，RD3 接线时必须补真实 CLI/事务验证。
 */
import { describe, expect, test } from "bun:test";
import {
  admitOperation, applyReceipt, mergeOperationSnapshots, observeWithoutProof, readOperationRecord, serializeOperationRecord,
  type OperationDecision, type OperationReceipt, type OperationRecord, type OperationRequest, type ReceiptAuthority,
} from "../src/lib/operation-record-contract.js";
import { v2ObjectDigest } from "../src/lib/shared-ledger-contract-v2.js";

const D = (c: string) => c.repeat(64);
const REQ: OperationRequest = {
  operationId: "op-1", identity: { teamId: "team-a", projectId: "proj-a", principal: "agent-x" },
  method: "POST", path: "/v1/teams/team-a/commands", requestDigest: D("a"),
};
const BODY = { ok: true, artifact: "art-1" };
/** 假权威：只认 proof === "trusted:<receiptId>"，模拟 RD3 注入的现有签名校验。 */
const AUTH: ReceiptAuthority = { isAuthentic: r => r.proof === `trusted:${r.receiptId}` };

function receipt(outcome: OperationReceipt["outcome"], over: Partial<OperationReceipt> = {}): OperationReceipt {
  const receiptId = over.receiptId ?? `rc-${outcome}`;
  return {
    ...REQ, receiptId, outcome, observedAt: 1_000, proof: `trusted:${receiptId}`,
    payloadDigest: outcome === "succeeded" ? v2ObjectDigest(BODY) : null, ...over,
  };
}
function okRecord(d: OperationDecision): OperationRecord {
  if (!d.ok) throw new Error(`expected ok, got ${d.reason}`);
  return d.record;
}
const fresh = () => okRecord(admitOperation(null, REQ));
const settle = (r: OperationRecord, rc: OperationReceipt, body: unknown = BODY) => applyReceipt(r, { receipt: rc, body }, AUTH);

describe("admitOperation：同 ID 去重", () => {
  test("首次记 pending；完全相同的重复返回既有记录、不变更", () => {
    const r = fresh();
    expect(r).toMatchObject({ state: "pending", receipt: null, operationId: "op-1" });
    expect(admitOperation(r, REQ)).toEqual({ ok: true, record: r, changed: false });
  });

  test.each([
    ["不同摘要", { requestDigest: D("b") }],
    ["不同身份", { identity: { ...REQ.identity, principal: "agent-y" } }],
    ["不同 scope", { identity: { ...REQ.identity, projectId: "proj-b" } }],
    ["不同 method", { method: "PUT" }],
    ["不同 path", { path: "/v1/teams/team-a/imports" }],
  ] as const)("同 ID %s → dedup_mismatch", (_n, over) => {
    expect(admitOperation(fresh(), { ...REQ, ...over })).toEqual({ ok: false, reason: "dedup_mismatch" });
  });

  test("已确认后再来同请求：只返回确认记录，不当新请求、不重放", () => {
    const done = okRecord(settle(fresh(), receipt("succeeded")));
    expect(admitOperation(done, REQ)).toEqual({ ok: true, record: done, changed: false });
  });

  test("非法请求/快照、快照 ID 与请求不符 → invalid", () => {
    expect(admitOperation(null, { ...REQ, method: "TRACE" })).toEqual({ ok: false, reason: "invalid" });
    expect(admitOperation(null, { ...REQ, path: "relative" })).toEqual({ ok: false, reason: "invalid" });
    expect(admitOperation(null, { ...REQ, extra: 1 })).toEqual({ ok: false, reason: "invalid" });
    expect(admitOperation({ ...fresh(), operationId: "op-2" }, REQ)).toEqual({ ok: false, reason: "invalid" });
    expect(admitOperation({ ...fresh(), state: "succeeded" }, REQ)).toEqual({ ok: false, reason: "invalid" });
  });
});

describe("observeWithoutProof：超时/重发/重启不推断结果", () => {
  test("pending → unknown；unknown 保持；已确认不变（超时不是撤单成功，也不降级）", () => {
    const unknown = okRecord(observeWithoutProof(fresh()));
    expect(unknown.state).toBe("unknown");
    expect(observeWithoutProof(unknown)).toEqual({ ok: true, record: unknown, changed: false });
    const cancelled = okRecord(settle(fresh(), receipt("cancelled")));
    expect(observeWithoutProof(cancelled)).toEqual({ ok: true, record: cancelled, changed: false });
  });
});

describe("applyReceipt：只有经权威验证的匹配回执能转移状态", () => {
  const transitions: [string, () => OperationRecord, OperationReceipt["outcome"], OperationRecord["state"]][] = [
    ["pending+succeeded", fresh, "succeeded", "succeeded"],
    ["pending+failed", fresh, "failed", "failed"],
    ["pending+cancelled", fresh, "cancelled", "cancelled"],
    ["pending+unknown", fresh, "unknown", "unknown"],
    ["unknown+succeeded", () => okRecord(observeWithoutProof(fresh())), "succeeded", "succeeded"],
    ["unknown+failed", () => okRecord(observeWithoutProof(fresh())), "failed", "failed"],
    ["unknown+unknown", () => okRecord(observeWithoutProof(fresh())), "unknown", "unknown"],
  ];
  test.each(transitions)("%s", (_n, start, outcome, expected) => {
    const r = okRecord(settle(start(), receipt(outcome)));
    expect(r.state).toBe(expected);
    expect(r.receipt === null).toBe(outcome === "unknown");
  });

  test("确认后的 unknown 回执不降级；相同证据再交一次幂等", () => {
    const done = okRecord(settle(fresh(), receipt("succeeded")));
    expect(settle(done, receipt("unknown"))).toEqual({ ok: true, record: done, changed: false });
    expect(settle(done, receipt("succeeded"))).toEqual({ ok: true, record: done, changed: false });
    expect(settle(done, receipt("succeeded", { receiptId: "rc-other" }))).toEqual({ ok: true, record: done, changed: false });
  });

  test.each([
    ["succeeded 后 failed", "succeeded", receipt("failed")],
    ["failed 后 succeeded", "failed", receipt("succeeded")],
    ["cancelled 后 succeeded", "cancelled", receipt("succeeded")],
    ["succeeded 后不同 payload", "succeeded", receipt("succeeded", { payloadDigest: v2ObjectDigest({ ok: false }) })],
  ] as const)("确认结果不一致 → conflict：%s", (_n, first, second) => {
    const done = okRecord(applyReceipt(fresh(), { receipt: receipt(first), body: BODY }, AUTH));
    const body = second.payloadDigest === v2ObjectDigest(BODY) ? BODY : { ok: false };
    expect(settle(done, second, body)).toEqual({ ok: false, reason: "conflict" });
  });

  test.each([
    ["错误身份", { identity: { ...REQ.identity, principal: "agent-y" } }],
    ["不同摘要", { requestDigest: D("c") }],
    ["别的操作", { operationId: "op-2" }],
    ["不同 path", { path: "/v1/teams/team-a/imports" }],
  ] as const)("回执与原操作绑定不符 → conflict：%s", (_n, over) => {
    expect(settle(fresh(), receipt("succeeded", over))).toEqual({ ok: false, reason: "conflict" });
  });

  test("无可信 proof → unverified，权威抛错也按未验证；状态原样不动", () => {
    const pending = fresh();
    expect(settle(pending, receipt("succeeded", { proof: "forged" }))).toEqual({ ok: false, reason: "unverified" });
    const boom: ReceiptAuthority = { isAuthentic: () => { throw new Error("verifier down"); } };
    expect(applyReceipt(pending, { receipt: receipt("cancelled"), body: BODY }, boom)).toEqual({ ok: false, reason: "unverified" });
    const truthy = { isAuthentic: () => 1 } as unknown as ReceiptAuthority;
    expect(applyReceipt(pending, { receipt: receipt("failed") }, truthy)).toEqual({ ok: false, reason: "unverified" });
    expect(pending.state).toBe("pending");
  });

  test("不完整回执 → incomplete：成功无 payload 摘要、缺 body、body 与摘要不符", () => {
    expect(settle(fresh(), receipt("succeeded", { payloadDigest: null }))).toEqual({ ok: false, reason: "incomplete" });
    expect(applyReceipt(fresh(), { receipt: receipt("succeeded") }, AUTH)).toEqual({ ok: false, reason: "incomplete" });
    expect(settle(fresh(), receipt("succeeded"), { ok: true, artifact: "tampered" })).toEqual({ ok: false, reason: "incomplete" });
    const failedWithBody = receipt("failed", { payloadDigest: v2ObjectDigest({ error: "x" }) });
    expect(settle(fresh(), failedWithBody, { error: "y" })).toEqual({ ok: false, reason: "incomplete" });
    expect(okRecord(settle(fresh(), failedWithBody, { error: "x" })).state).toBe("failed");
  });

  test("畸形回执 → invalid：unknown 带 payload、缺 proof、多余字段", () => {
    expect(settle(fresh(), receipt("unknown", { payloadDigest: D("d") }))).toEqual({ ok: false, reason: "invalid" });
    expect(settle(fresh(), receipt("succeeded", { proof: "" }))).toEqual({ ok: false, reason: "invalid" });
    expect(settle(fresh(), { ...receipt("succeeded"), extra: 1 } as OperationReceipt)).toEqual({ ok: false, reason: "invalid" });
  });
});

describe("mergeOperationSnapshots：乱序并发快照", () => {
  const pending = fresh(), unknown = okRecord(observeWithoutProof(fresh()));
  const done = okRecord(settle(fresh(), receipt("succeeded")));
  const doneAlt = okRecord(settle(fresh(), receipt("succeeded", { receiptId: "rc-alt" })));

  test.each([
    ["pending+pending", pending, pending, "pending"],
    ["pending+unknown", pending, unknown, "unknown"],
    ["unknown+succeeded", unknown, done, "succeeded"],
    ["pending+succeeded", pending, done, "succeeded"],
    ["succeeded+succeeded(另一张等价回执)", done, doneAlt, "succeeded"],
  ] as const)("%s：两种顺序结果相同、确认不被抹掉", (_n, a, b, expected) => {
    const ab = okRecord(mergeOperationSnapshots(a, b, AUTH)), ba = okRecord(mergeOperationSnapshots(b, a, AUTH));
    expect(ab.state).toBe(expected);
    expect(serializeOperationRecord(ab)).toBe(serializeOperationRecord(ba));
  });

  test("两份确认结论不同 → conflict；请求绑定不同 → dedup_mismatch", () => {
    const failed = okRecord(settle(fresh(), receipt("failed")));
    expect(mergeOperationSnapshots(done, failed, AUTH)).toEqual({ ok: false, reason: "conflict" });
    const other = okRecord(admitOperation(null, { ...REQ, requestDigest: D("e") }));
    expect(mergeOperationSnapshots(pending, other, AUTH)).toEqual({ ok: false, reason: "dedup_mismatch" });
  });

  test("快照里的确认回执重新核验：伪造的确认拒绝优先，不能借合并洗白", () => {
    const forged = { ...done, receipt: { ...done.receipt!, proof: "forged" } };
    expect(mergeOperationSnapshots(pending, forged, AUTH)).toEqual({ ok: false, reason: "unverified" });
    expect(mergeOperationSnapshots(forged, done, AUTH)).toEqual({ ok: false, reason: "unverified" });
  });

  test("与自己合并幂等（changed=false）", () => {
    for (const r of [pending, unknown, done]) expect(mergeOperationSnapshots(r, r, AUTH)).toEqual({ ok: true, record: r, changed: false });
  });
});

describe("重启：保存后读回相同 JSON", () => {
  test.each(["pending", "unknown", "succeeded", "cancelled"] as const)("%s 记录序列化→读回→再序列化逐字节一致", state => {
    const start = fresh();
    const r = state === "pending" ? start : state === "unknown" ? okRecord(observeWithoutProof(start)) : okRecord(settle(start, receipt(state)));
    const saved = serializeOperationRecord(r);
    const back = readOperationRecord(saved);
    expect(back).toEqual(r);
    expect(serializeOperationRecord(back)).toBe(saved);
    expect(admitOperation(back, REQ)).toEqual({ ok: true, record: back, changed: false });
  });

  test("损坏/半截/被篡改的落盘内容读回直接拒绝，不当成新操作", () => {
    const saved = serializeOperationRecord(okRecord(settle(fresh(), receipt("succeeded"))));
    expect(() => readOperationRecord(saved.slice(0, -5))).toThrow();
    expect(() => readOperationRecord(saved.replace('"state":"succeeded"', '"state":"failed"'))).toThrow();
    expect(() => readOperationRecord(saved.replace('"principal":"agent-x"', '"principal":"agent-y"'))).toThrow();
  });
});

describe("性质：乱序回执序列收敛", () => {
  /** 确定性伪随机（mulberry32），每次跑同一组排列。 */
  function rng(seed: number): () => number {
    return () => {
      seed = (seed + 0x6d2b79f5) | 0;
      let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  const noise: OperationReceipt[] = [
    receipt("unknown"), receipt("unknown", { receiptId: "rc-u2" }), receipt("succeeded", { proof: "forged" }),
    receipt("failed", { identity: { ...REQ.identity, principal: "agent-y" } }), receipt("succeeded", { payloadDigest: null }),
  ];

  test("同一确认结果 + 噪声（unknown/伪造/错身份/不完整）任意顺序、重复投递：终态都是 succeeded 且字节一致", () => {
    const next = rng(42), finals = new Set<string>();
    for (let round = 0; round < 200; round++) {
      const pool = [...noise, receipt("succeeded"), receipt("succeeded")];
      for (let i = pool.length - 1; i > 0; i--) { const j = Math.floor(next() * (i + 1)); [pool[i], pool[j]] = [pool[j]!, pool[i]!]; }
      let r = round % 2 ? okRecord(observeWithoutProof(fresh())) : fresh();
      for (const rc of pool) {
        const d = settle(r, rc);
        if (d.ok) r = d.record;
        else expect(["unverified", "conflict", "incomplete"]).toContain(d.reason);
        if (r.state === "succeeded") expect(r.receipt).not.toBeNull();
      }
      expect(r.state).toBe("succeeded");
      finals.add(serializeOperationRecord(r));
    }
    expect(finals.size).toBe(1);
  });

  test("只有噪声时绝不出现确认态：结果不明保留 unknown/pending", () => {
    const next = rng(7);
    for (let round = 0; round < 100; round++) {
      let r = fresh();
      for (let k = 0; k < 8; k++) {
        const d = settle(r, noise[Math.floor(next() * noise.length)]!);
        if (d.ok) r = d.record;
        r = next() < 0.3 ? okRecord(observeWithoutProof(r)) : r;
      }
      expect(["pending", "unknown"]).toContain(r.state);
    }
  });

  test("合并满足交换/结合律且单调：任一输入已确认，结果必确认", () => {
    const states = [fresh(), okRecord(observeWithoutProof(fresh())), okRecord(settle(fresh(), receipt("succeeded"))),
      okRecord(settle(fresh(), receipt("succeeded", { receiptId: "rc-alt" })))];
    const merge = (a: OperationRecord, b: OperationRecord) => okRecord(mergeOperationSnapshots(a, b, AUTH));
    for (const a of states) for (const b of states) {
      expect(serializeOperationRecord(merge(a, b))).toBe(serializeOperationRecord(merge(b, a)));
      if (a.receipt || b.receipt) expect(merge(a, b).state).toBe("succeeded");
      for (const c of states) {
        expect(serializeOperationRecord(merge(merge(a, b), c))).toBe(serializeOperationRecord(merge(a, merge(b, c))));
      }
    }
  });
});
