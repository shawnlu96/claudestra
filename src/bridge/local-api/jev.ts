/**
 * POST /api/v1/jev/test → 用一段固定英文样例打一次 Jev（lib/jev.ts），回模型 / 耗时 / 三个答案 / 用量，给设置页「测试连接」用。
 * 需要 manage grant（会消耗账户额度、也暴露 key 是否有效）；没配 key 回 501 not_configured。同时只跑一路。
 * 「通顺」判据在代码里：样例是明显紧急的 billing 投诉，is_urgent > 0.5 且 category = billing 才算 plausible。
 */
import { canManage } from "../../lib/devices.js";
import { choice, jevAsk, JevError, noul, score, type JevDeps } from "../../lib/jev.js";
import type { Principal } from "../../lib/principals.js";
import { apiJson, forbidden } from "../api-respond.js";

export const JEV_SAMPLE_STATE = "Help! Our payouts have been failing for three days and customers are getting angry. Please fix this today.";
export const JEV_SAMPLE_QUESTIONS = {
  is_urgent: noul("Does this message convey urgency?", { true: "Explicitly time-sensitive", false: "No urgency expressed" }),
  category: choice("What is this message about?", { billing: "Payments, payouts, charges, invoices", technical: "Bugs, outages, integration errors", other: null }),
  frustration: score("How frustrated is the writer?", ["Calm", "Frustrated", "Very angry"]),
};

type Ask = typeof jevAsk;
interface Deps { ask: Ask; jev: Partial<JevDeps> }
let deps: Deps = { ask: jevAsk, jev: {} };
let inflight = false;
/** 单测注入假 ask / 假 key；生产不调 */
export function setJevTestDepsForTest(d: Partial<Deps> | undefined): void {
  deps = d ? { ask: d.ask ?? jevAsk, jev: d.jev ?? {} } : { ask: jevAsk, jev: {} };
}

const STATUS: Record<JevError["code"], number> = {
  not_configured: 501, unauthorized: 502, invalid_request: 502, rate_limited: 429, overloaded: 503, timeout: 504, network: 502, bad_response: 502, http: 502,
};

export async function handleJev(req: Request, path: string, principal: Principal): Promise<Response | null> {
  if (path !== "/jev/test" || req.method !== "POST") return null;
  if (!canManage(principal)) return forbidden("jev test requires a credential with manage grant");
  if (inflight) return apiJson(429, { ok: false, error: "a Jev test is already running", code: "busy" });
  inflight = true;
  try {
    const r = await deps.ask(JEV_SAMPLE_STATE, JEV_SAMPLE_QUESTIONS, { timeoutMs: 15_000, retries: 1 }, deps.jev);
    const plausible = r.answers.is_urgent.noul > 0.5 && r.answers.category.choice === "billing";
    return apiJson(200, { ok: true, model: r.model, latencyMs: r.latencyMs, usage: r.usage, costUsd: r.costUsd, answers: r.answers, plausible, sample: JEV_SAMPLE_STATE });
  } catch (e) {
    if (e instanceof JevError) return apiJson(STATUS[e.code], { ok: false, error: e.message, code: e.code });
    return apiJson(502, { ok: false, error: `Jev test failed: ${(e as Error).message}`, code: "http" });
  } finally {
    inflight = false;
  }
}
