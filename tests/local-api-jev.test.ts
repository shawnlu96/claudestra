/** 本地 API：POST /api/v1/jev/test（设置页「测试连接」）——鉴权、未配置、成功 / 失败映射；不打真网络 */
import { afterAll, describe, expect, test } from "bun:test";
import { handleLocalApi } from "../src/bridge/local-api/index.js";
import { JEV_SAMPLE_QUESTIONS, JEV_SAMPLE_STATE, setJevTestDepsForTest } from "../src/bridge/local-api/jev.js";
import { JevError } from "../src/lib/jev.js";
import type { Principal } from "../src/lib/principals.js";

const OWNER: Principal = { id: "owner:self", role: "owner", agents: ["*", "master"], createdAt: "2026-01-01T00:00:00Z", manage: true, credential: "dev_o1" };
const GUEST: Principal = { id: "guest:1234", role: "external", name: "friend", agents: ["worker"], createdAt: "2026-01-01T00:00:00Z", manage: false, credential: "dev_g1" };
const call = (p: Principal) => handleLocalApi(new Request("http://bridge/api/v1/jev/test", { method: "POST" }), new URL("http://bridge/api/v1/jev/test"), p);
const good = { model: "jev-1.13.0", latencyMs: 210, usage: { input_tokens: 320, output_tokens: 30 }, costUsd: 0.00001344, answers: {
  is_urgent: { type: "noul", noul: 0.91 }, category: { type: "choice", choice: "billing", probabilities: { billing: 0.9, technical: 0.08, other: 0.02 }, confidence: 0.86 },
  frustration: { type: "score", score: 1.4, legend: { "0": "Calm", "1": "Frustrated", "2": "Very angry" }, probabilities: { "0": 0.05, "1": 0.5, "2": 0.45 }, confidence: 0.6 } } };
afterAll(() => setJevTestDepsForTest(undefined));

describe("POST /api/v1/jev/test", () => {
  test("guest 没有 manage → 403，不会打 Jev", async () => {
    let asked = false;
    setJevTestDepsForTest({ ask: (async () => { asked = true; return good; }) as never });
    const r = await call(GUEST);
    expect(r?.status).toBe(403); expect(asked).toBe(false);
  });
  test("成功：回模型 / 耗时 / 答案，样例为紧急 billing → plausible；用的是固定样例", async () => {
    const seen: { state?: unknown; q?: unknown } = {};
    setJevTestDepsForTest({ ask: (async (state: unknown, q: unknown) => { seen.state = state; seen.q = q; return good; }) as never });
    const r = await call(OWNER);
    const j = (await r!.json()) as Record<string, unknown>;
    expect(r!.status).toBe(200);
    expect(j).toMatchObject({ ok: true, model: "jev-1.13.0", plausible: true, latencyMs: 210 });
    expect(seen).toEqual({ state: JEV_SAMPLE_STATE, q: JEV_SAMPLE_QUESTIONS });
  });
  test("答案不合理 → plausible=false；JevError 按 code 映射状态（not_configured 501、rate_limited 429、unauthorized 502）", async () => {
    setJevTestDepsForTest({ ask: (async () => ({ ...good, answers: { ...good.answers, category: { ...good.answers.category, choice: "other" } } })) as never });
    expect(((await (await call(OWNER))!.json()) as { plausible: boolean }).plausible).toBe(false);
    for (const [code, status] of [["not_configured", 501], ["rate_limited", 429], ["unauthorized", 502]] as const) {
      setJevTestDepsForTest({ ask: (async () => { throw new JevError(code, `boom ${code}`); }) as never });
      const r = await call(OWNER);
      expect(r!.status).toBe(status);
      expect(await r!.json()).toMatchObject({ ok: false, code, error: `boom ${code}` });
    }
  });
});
