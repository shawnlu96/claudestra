/**
 * dispatch-recovery-MODELXP2 · 出借方 release 带结构化类别（lend-drive settleOrder）与 wire 严格解析（lend-wire parseLease）。
 * - 确认属于本单当前回合的回合失败 → release stopped 带 failure；判不了不带。
 * - 旧借入方严格解析不认 failure、明确回 invalid → 去掉 failure 重发一次；超时 / 网络错 / 别的拒绝不重发（不能重复 release）。
 * - parseLease：failure 合格才收；畸形的整条 invalid（借入方不会入账，自然不会撤单 / 换家族）。
 * lend-harness 的假依赖（不连 bridge / peer / 真实模型）。
 */
import { expect, test } from "bun:test";
import type { LendWorkerFailure } from "../src/lib/lend-health.js";
import { parseLendRequest } from "../src/lib/lend-wire.js";
import { getOrder } from "../src/lib/lend-journal.js";
import { harness, toStarted } from "./lend-harness.js";

const CYBER = "This request has been flagged for possible cybersecurity risk";
const FAILED = 1_234_567;
const confirmed: LendWorkerFailure = { kind: "error", askId: "ask_1", message: CYBER, sessionId: "thr-1", failedAt: FAILED };
const releases = (h: ReturnType<typeof harness>) => h.calls.filter((c) => c.op === "lease" && c.body.action === "release").map((c) => c.body);

async function stopped(reply?: (b: Record<string, unknown>) => ReturnType<ReturnType<typeof harness>["A"]["lease"]>, failure: LendWorkerFailure = confirmed) {
  const h = harness();
  await toStarted(h);
  if (reply) h.A.lease = (b) => (b.action === "release" ? reply(b) : { status: 200, body: { ok: true, v: 1, lease: { gen: 1, expiresAt: 0, ms: 600_000 } } });
  h.failures.set(getOrder(h.db, "o1")!.agent!, failure as never);
  await h.tick();
  return h;
}

test("确认属于本单当前回合 → release stopped 带 failure（provider_policy + 会话 + 失败时刻），原因文本照旧", async () => {
  const h = await stopped();
  const [r] = releases(h);
  expect(r).toMatchObject({ orderId: "o1", reason: "stopped", failure: { class: "provider_policy", sessionId: "thr-1", failedAt: FAILED } });
  expect(String(r.detail)).toContain("内容策略拦截");
  expect(releases(h)).toHaveLength(1);
  expect(getOrder(h.db, "o1")!.state).toBe("stopped");
});

test("判不了（卡上没有会话 / 失败时刻）→ 不带 failure", async () => {
  const h = await stopped(undefined, { kind: "error", askId: "ask_1", message: CYBER });
  expect(releases(h)).toHaveLength(1);
  expect("failure" in releases(h)[0]).toBe(false);
});

test("旧借入方明确回 invalid（不认识的字段 failure）→ 去掉 failure 重发一次", async () => {
  const h = await stopped((b) => "failure" in b ? { status: 400, body: { ok: false, code: "invalid", error: "$: 不认识的字段 failure" } }
    : { status: 200, body: { ok: true, v: 1, lease: null } });
  const rs = releases(h);
  expect(rs).toHaveLength(2);
  expect(rs[0].failure).toBeDefined();
  expect("failure" in rs[1]).toBe(false);
  expect(rs[1]).toMatchObject({ orderId: "o1", reason: "stopped", detail: rs[0].detail });
});

test("超时 / 网络错 / 结果不明 / 别的拒绝 → 不重发（不能重复 release）", async () => {
  for (const reply of [() => "throw" as const, () => ({ status: 502, body: "x" }),
    () => ({ status: 409, body: { ok: false, code: "conflict", error: "这一单的结论已入账" } })]) {
    const h = await stopped(reply as never);
    expect(releases(h)).toHaveLength(1);
    await h.tick(); // 下一轮也不补发（告诉 A 只试一次）
    expect(releases(h)).toHaveLength(1);
  }
});

const lease = (over: Record<string, unknown> = {}) => ({ v: 1, orderId: "lend:T1:s1:r2:a0", gen: 1, action: "release", reason: "stopped", detail: "x", ...over });
const failure = { class: "provider_policy", sessionId: "thr-1", failedAt: FAILED };

test("parseLease：不带 failure 照旧；带合格的 failure 收下", () => {
  const old = parseLendRequest("lease", lease());
  expect(old.ok && "failure" in old.value).toBe(false);
  expect(parseLendRequest("lease", lease({ failure }))).toMatchObject({ ok: true, value: { failure } });
  for (const cls of ["usage", "auth", "network", "other"]) expect(parseLendRequest("lease", lease({ failure: { ...failure, class: cls } })).ok).toBe(true);
});

test("parseLease：畸形 failure 整条 invalid（类别不认识、缺字段、多字段、类型错、非 stopped 带它）", () => {
  const bad: unknown[] = [null, "provider_policy", [], { ...failure, class: "cyber_policy" }, { class: "provider_policy", sessionId: "s" },
    { ...failure, extra: 1 }, { ...failure, sessionId: "" }, { ...failure, sessionId: "a b/c" }, { ...failure, failedAt: "1" },
    { ...failure, failedAt: 1.5 }, { ...failure, failedAt: 0 }];
  for (const f of bad) expect(parseLendRequest("lease", lease({ failure: f })).ok).toBe(false);
  expect(parseLendRequest("lease", lease({ reason: "not_started", failure })).ok).toBe(false);
  expect(parseLendRequest("lease", { ...lease({ action: "renew", reason: null, detail: null }), failure }).ok).toBe(false);
});
