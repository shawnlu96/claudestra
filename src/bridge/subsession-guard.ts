/**
 * 收编前的子会话闸（POST /api/v1/agents/resume）：Codex 的 subagent / 自动审查线程是主会话派生出来的，
 * 单独收编成 agent 基本都是误操作（owner 就这么把一条自动审查线程收编过）。没带 confirmSubSession:true 就 409，
 * 带回归属信息让前端说清「这是谁的子会话」；前端二次确认后带上标记重发即可。单测 tests/subsession-guard.test.ts。
 */
import { codexSubSessionOf } from "../lib/codex-session.js";
import type { SubSessionInfo } from "../lib/runtimes/types.js";
import { apiJson } from "./api-respond.js";

type Lookup = (sessionId: string) => Promise<SubSessionInfo | null>;

export async function refuseUnconfirmedSubSession(
  body: { confirmSubSession?: unknown } | null | undefined,
  sessionId: string,
  runtime: string,
  lookup: Lookup = codexSubSessionOf,
): Promise<Response | null> {
  if (runtime !== "codex" || body?.confirmSubSession === true) return null;
  const sub = await lookup(sessionId).catch(() => null); // 读不到 rollout 就按普通会话放行：闸是防误操作，不是权限边界
  if (!sub) return null;
  const what = sub.kind === "guardian_review" ? "自动审查线程" : "子会话（subagent）";
  return apiJson(409, {
    ok: false,
    subSession: sub,
    error: `这是另一个 Codex 会话派生出的${what}，通常不需要单独收编。确实要收编，请在界面上确认后再试。`,
  });
}
