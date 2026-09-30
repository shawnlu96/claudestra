/** ACP 的网页清上下文端点：宿主引导新线程并换 registry 后才返回成功。 */
import { recordMetric } from "../lib/metrics.js";
import { acpClear } from "./acp-link.js";
import { apiJson } from "./api-respond.js";

export async function handleAcpClear(agent: { name: string; channelId: string; sessionId?: string }): Promise<Response> {
  const r = await acpClear(agent.channelId);
  if (!r.ok) return apiJson(r.uncertain ? 504 : 409, { ok: false, code: r.uncertain ? "clear_result_unknown" : undefined, error: r.error, sessionId: r.sessionId });
  recordMetric("agent_clear", { channelId: agent.channelId, agent: agent.name, meta: { trigger: "api", transport: "acp" } });
  return apiJson(200, { ok: true, agent: agent.name, sessionId: r.sessionId, previousSessionId: agent.sessionId });
}
