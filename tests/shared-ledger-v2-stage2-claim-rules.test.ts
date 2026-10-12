/** S2F5 验收线 4–7：S2C 的意图口径 — 已认领的意图反复核验不改状态、终态不可核、id 即 operationId、第一次结果为准、取消权限。
 * 只用合成 fake center（tests/helpers/shared-ledger-v2-fake-center*），不读生产、不连网络。
 */
import { describe, expect, test } from "bun:test";
import { v2ObjectDigest, type V2Actor } from "../src/lib/shared-ledger-contract-v2.js";
import {
  ACTORS, approvedAsk, code, EXEC_TASK, HOME_MEMBER, HOME_SCHEDULER, kit, service,
} from "./helpers/shared-ledger-v2-fake-center-kit.js";

const { owner, member } = ACTORS;
const H = "b".repeat(40), D = "a".repeat(64), OP = "op-1";
const resources = [{ teamId: "team", projectId: "project", repository: "team/repository", kind: "file", path: "src/example.ts" }];
type Status = "pending" | "submitted" | "done" | "cancelled" | "unknown";

/** A leased `task-exec` with one intent created under the owner's approval `ask-exec`, moved to `status` by real commands. */
function setup(status: Status = "pending") {
  const k = kit(), bindOf = (askId: string) => v2ObjectDigest(k.center.rows().asks.get(askId)!.bind);
  expect(k.post(owner, k.command("lease.acquire", { ...EXEC_TASK, homeInstanceId: "local" })).status).toBe(200);
  const created = k.post(owner, k.command("intent.create", { ...EXEC_TASK, action: "dispatch", node: "write", operationId: OP, head: H,
    round: 0, dependencyDigest: D, authorizationAskId: "ask-exec", authorizationDigest: bindOf("ask-exec"), resources }));
  expect(created.status).toBe(200);
  const check = (patch: Record<string, unknown> = {}, extra: Parameters<typeof k.command>[2] = {}) => k.command("intent.check",
    { ...EXEC_TASK, intentId: OP, operationId: OP, authorizationAskId: "ask-exec", authorizationDigest: bindOf("ask-exec"), ...patch }, extra);
  const result = (patch: Record<string, unknown> = {}, requestId?: string) => k.command("operation.result", { result: {
    teamId: "team", projectId: "project", operationId: OP, intentId: OP, taskId: "task-exec", serviceGeneration: 1, epoch: 1,
    bootId: "boot-local", state: "succeeded", head: H, approvalAskId: "ask-exec", summary: "第一次", artifactIds: [], observedAt: 10_000,
    ...patch } }, requestId ? { requestId } : {});
  const cancel = (patch: Record<string, unknown> = {}) =>
    k.command("intent.cancel", { ...EXEC_TASK, intentId: OP, operationId: OP, reason: "停止", ...patch });
  const intent = () => k.center.rows().intents.get(OP)!;
  if (status !== "pending") expect(k.post(owner, check()).status).toBe(200);
  if (status === "done" || status === "unknown") expect(k.post(owner, result({ state: status === "done" ? "succeeded" : "unknown" })).status).toBe(200);
  if (status === "cancelled") expect(k.post(owner, cancel()).status).toBe(200);
  expect(intent().status).toBe(status);
  return { k, created, bindOf, check, result, cancel, intent };
}
type S = ReturnType<typeof setup>;

describe("S2F5：intent.check 在 pending 与 submitted 上检查项相同，被拒时什么都不写", () => {
  const refusals: [string, string, (s: S) => () => ReturnType<S["k"]["post"]>][] = [
    ["任务改版后请求带新版本（与意图冻结值不符）", "conflict", s => {
      expect(s.k.post(member, s.k.command("task.set", { taskId: "task-exec", expectedRev: 1, expectedSpecRev: 1, patch: { title: "改版" } })).status).toBe(200);
      return () => s.k.post(owner, s.check({ expectedRev: 2 }));
    }],
    ["换成另一份已批准的授权", "authorization_mismatch", s => {
      s.k.center.seed({ asks: [approvedAsk("ask-other", "feature-exec", "task-exec")] });
      return () => s.k.post(owner, s.check({ authorizationAskId: "ask-other", authorizationDigest: s.bindOf("ask-other") }));
    }],
    ["旧 epoch", "stale_epoch", s => {
      expect(s.k.post(owner, s.k.command("home.change", { featureId: "feature-exec", expectedRev: 1, nextHomeInstanceId: "peer-b", nextEpoch: 2,
        authorizationAskId: "ask-exec", oldHomeStopped: true, workersSettled: true, lendSettled: true, unknownReconciled: true })).status).toBe(200);
      return () => s.k.post(owner, s.check());
    }],
    ["别的实例", "wrong_home", s => () => s.k.post(member, s.check())],
  ];
  for (const status of ["submitted", "pending"] as const) for (const [name, expected, arrange] of refusals) {
    test(`[验收线 4] ${status} 上 check：${name} → ${expected}，意图仍 ${status}`, () => {
      const s = setup(status), attempt = arrange(s), before = s.k.center.rows();
      expect(code(attempt())).toBe(expected);
      expect(s.k.center.rows()).toEqual(before);
      expect(s.intent()).toMatchObject({ status, attempts: status === "submitted" ? 1 : 0 });
      expect(before.resources).toMatchObject([{ intentId: OP, state: "held" }]);
    });
  }
  test("[验收线 4] submitted 上通过的 check 只核验：状态、attempts、资源、更新时间都不动，回执照常", () => {
    const s = setup("submitted"), strip = (rows: ReturnType<S["k"]["center"]["rows"]>) => ({ ...rows, receipts: null, serverSeq: null });
    s.k.center.advance(1_000);
    const before = s.k.center.rows(), command = s.check(), res = s.k.post(owner, command);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ requestId: command.requestId, commandDigest: v2ObjectDigest(command), command: "intent.check",
      result: { entityId: OP, operationId: OP } });
    expect(strip(s.k.center.rows())).toEqual(strip(before));
    expect(s.intent()).toMatchObject({ status: "submitted", attempts: 1, updatedAt: 10_000 });
  });
  test("[验收线 4] 认领时用的授权后来过期：submitted 上 check 报 authorization_expired，意图仍 submitted", () => {
    const s = setup("submitted");
    s.k.center.advance(50_000);
    expect(s.k.post(owner, s.k.command("lease.renew", { taskId: "task-exec", homeInstanceId: "local" })).status).toBe(200);
    s.k.center.advance(40_000); // the ask's own expiry (100000) is reached while the renewed lease still lives
    expect(code(s.k.post(owner, s.check()))).toBe("authorization_expired");
    expect(s.intent()).toMatchObject({ status: "submitted", attempts: 1 });
  });
});

describe("S2F5：终态、id 与结果", () => {
  for (const status of ["done", "cancelled", "unknown"] as const) {
    test(`[验收线 5] ${status} 上 check → unknown_operation`, () => {
      const s = setup(status), before = s.k.center.rows();
      expect(code(s.k.post(owner, s.check()))).toBe("unknown_operation");
      expect(s.k.center.rows()).toEqual(before);
    });
  }
  test("[验收线 6] 意图 id 等于 operationId；payload 的 intentId 不符 → conflict（check / cancel / result）", () => {
    const s = setup("submitted");
    expect((s.created.body as { result: { entityId: string; operationId: string } }).result).toMatchObject({ entityId: OP, operationId: OP });
    expect([...s.k.center.rows().intents.keys()]).toEqual([OP]);
    expect(s.intent()).toMatchObject({ id: OP, operationId: OP });
    expect(s.k.center.rows().resources).toMatchObject([{ intentId: OP, operationId: OP }]);
    expect(code(s.k.post(owner, s.check({ intentId: "intent-2" })))).toBe("conflict");
    expect(code(s.k.post(owner, s.cancel({ intentId: "intent-2" })))).toBe("conflict");
    expect(code(s.k.post(owner, s.result({ intentId: "intent-2" })))).toBe("conflict");
    expect(code(s.k.post(owner, s.check({ operationId: "op-none" })))).toBe("not_found");
    expect(s.intent()).toMatchObject({ status: "submitted", attempts: 1 });
  });
  test("[验收线 6] pending 上 operation.result → conflict，意图仍 pending、不存结果", () => {
    const s = setup("pending"), before = s.k.center.rows();
    expect(code(s.k.post(owner, s.result()))).toBe("conflict");
    expect(s.k.center.rows()).toEqual(before);
    expect(before.operationResults.size).toBe(0);
  });
  test("[验收线 6] 第二次 operation.result（新 requestId、不同内容）：回执对本次请求，保存的仍是第一次；同 requestId 重放回同一回执", () => {
    const s = setup("submitted"), first = s.result({}, "result-first"), sent = s.k.post(owner, first);
    expect(sent.status).toBe(200);
    expect(s.intent()).toMatchObject({ status: "done", attempts: 1 });
    const second = s.result({ state: "failed", summary: "第二次", observedAt: 10_500 }, "result-second"), again = s.k.post(owner, second);
    expect(again.status).toBe(200);
    expect(again.body).toMatchObject({ requestId: "result-second", commandDigest: v2ObjectDigest(second), command: "operation.result",
      result: { entityId: OP, operationId: OP } });
    expect(v2ObjectDigest(second)).not.toBe(v2ObjectDigest(first));
    expect(s.k.center.rows().operationResults.get(OP)).toEqual(first.payload.result);
    expect(s.intent()).toMatchObject({ status: "done", attempts: 1 });
    expect(s.k.post(owner, first)).toEqual(sent);
    expect(s.k.post(owner, second)).toEqual(again);
  });
  test("[验收线 6] 结果不明的意图再报结果 → unknown_operation，保存的结果与锁不变", () => {
    const s = setup("unknown"), before = s.k.center.rows();
    expect(code(s.k.post(owner, s.result({ summary: "补报" }, "result-late")))).toBe("unknown_operation");
    expect(s.k.center.rows()).toEqual(before);
    expect(before.resources).toMatchObject([{ intentId: OP, state: "unknown" }]);
  });
});

describe("S2F5：intent.cancel 的权限", () => {
  const scheduler = service(HOME_SCHEDULER);
  const cancelled = (s: S, actor: V2Actor) => {
    expect(s.k.post(actor, s.cancel()).status).toBe(200);
    expect(s.intent()).toMatchObject({ status: "cancelled", reason: "停止" });
    expect(s.k.center.rows().resources).toEqual([]);
  };
  test("[验收线 7] 主场调度服务：取消 pending 成功；取消 submitted → forbidden", () => {
    cancelled(setup("pending"), scheduler);
    const s = setup("submitted"), before = s.k.center.rows();
    expect(code(s.k.post(scheduler, s.cancel()))).toBe("forbidden");
    expect(s.k.center.rows()).toEqual(before);
  });
  test("[验收线 7] 主场调度服务照常核租约任期：失租后取消 pending → lease_expired；没登记的 serviceId → forbidden", () => {
    const s = setup("pending");
    expect(code(s.k.post(service("other-service"), s.cancel()))).toBe("forbidden");
    s.k.center.advance(60_001);
    expect(code(s.k.post(scheduler, s.cancel()))).toBe("lease_expired");
    expect(s.intent().status).toBe("pending");
  });
  test("[验收线 7] owner 本人：取消 submitted、取消 unknown 都成功", () => {
    cancelled(setup("submitted"), owner);
    cancelled(setup("unknown"), owner);
  });
  test("[验收线 7] owner 本人：已失租、换了任期的 submitted 意图也能取消；版本不对 → conflict", () => {
    const s = setup("submitted");
    s.k.center.advance(60_001);
    expect(code(s.k.post(owner, s.check()))).toBe("lease_expired");
    expect(code(s.k.post(owner, s.cancel({ expectedRev: 2 })))).toBe("conflict");
    cancelled(s, owner);
    const next = setup("submitted");
    next.k.center.restart();
    expect(next.k.post(owner, next.k.command("lease.acquire", { ...EXEC_TASK, homeInstanceId: "local" }, { bootId: "boot-next" })).status).toBe(200);
    expect(next.k.post(owner, next.k.command("intent.cancel", { ...EXEC_TASK, intentId: OP, operationId: OP, reason: "停止" },
      { bootId: "boot-next" })).status).toBe(200);
    expect(next.intent().status).toBe("cancelled");
  });
  test("[验收线 7] 带 orderId 的服务身份、非 owner 的 person 取消 pending → forbidden；别的实例 → wrong_home", () => {
    const s = setup("pending"), before = s.k.center.rows();
    expect(code(s.k.post(service(HOME_SCHEDULER, "order-1"), s.cancel()))).toBe("forbidden");
    expect(code(s.k.post(HOME_MEMBER, s.cancel()))).toBe("forbidden");
    expect(code(s.k.post(member, s.cancel()))).toBe("wrong_home");
    expect(s.k.center.rows()).toEqual(before);
  });
  test("[验收线 7] 已 cancelled 再用新 requestId 取消 → 幂等成功（谁来都一样）；done 取消 → conflict", () => {
    const s = setup("cancelled"), strip = (rows: ReturnType<S["k"]["center"]["rows"]>) => ({ ...rows, receipts: null, serverSeq: null });
    const before = s.k.center.rows(), again = s.cancel({ reason: "再取消一次" }), res = s.k.post(owner, again);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ requestId: again.requestId, commandDigest: v2ObjectDigest(again), result: { entityId: OP, operationId: OP } });
    expect(s.k.post(scheduler, s.cancel()).status).toBe(200);
    expect(strip(s.k.center.rows())).toEqual(strip(before));
    expect(s.intent()).toMatchObject({ status: "cancelled", reason: "停止" });
    const done = setup("done"), kept = done.k.center.rows();
    expect(code(done.k.post(owner, done.cancel()))).toBe("conflict");
    expect(done.k.center.rows()).toEqual(kept);
  });
});
