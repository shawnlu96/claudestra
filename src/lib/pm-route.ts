import { classifyPmPush, PM_DIGEST_LABEL, type DigestInput } from "./pm-digest.js";
import { matchPmLineRule, matchPmTrainRule, pmLineFixedText } from "./pm-route-rules.js";
import { routePmAudit } from "./pm-route-audit.js";
import type { PmRouteClass, PmRoutePlan, PmRouteTag } from "./pm-route-types.js";

const verdict = (route: PmRouteClass, rule: string, reason: string, immediate = false): PmRoutePlan =>
  ({ tags: [{ route, rule, reason }], ...(immediate ? { immediate } : {}) });

/** 复用 PMDIG3 的整段保护 helper，避免复制或渐渐分叉它的停单 / 重派规则。 */
function protectedBody(m: DigestInput): boolean {
  return classifyPmPush({ ...m, fromKind: "local", sender: "pm-route-protection", oneShot: true }).send === "now";
}

export function classifyPmRoute(m: DigestInput): PmRoutePlan {
  if (m.fromKind === "user" || m.fromKind === "api") return verdict("owner", "protect.owner", "人类或 peer 对话", true);
  if (m.triggerKind === "user_discord") return verdict("owner", "protect.human", "人类消息触发", true);
  if (m.triggerKind === "peer_http") return verdict("judge", "protect.peer", "peer 回程沿用投递", true);
  if (m.triggerKind === "ask_answer" || m.intent === "response") return verdict("judge", "protect.answer", "卡片答复或回程", true);
  if (m.fromKind === "bridge" && m.sender === PM_DIGEST_LABEL) return verdict("judge", "protect.digest", "摘要自身不分流");
  if (m.fromKind === "bridge" && m.sender === "ledger-audit") {
    return routePmAudit(m) ?? verdict("judge", "audit.unparsed", "巡检格式未核实，整封沿用旧路");
  }
  if (/需(?:要)?\s*owner|owner\s*(?:决策|拍板)/i.test(m.body)) return verdict("owner", "protect.decision", "明确需要 owner 决策", true);
  if (m.fromKind === "local" && m.sender === "scheduler" && m.oneShot) {
    const payload = /^\[合并列车\] 第 [1-9]\d* 辆车 [a-z0-9]+-[a-z0-9]+：([^\n]+)$/.exec(m.body)?.[1];
    if (payload && /alarm|告警|报警|异常|超时|时限|放行|拒绝/i.test(payload)) return verdict("judge", "protect.train", "列车异常、超时或放行需判断", true);
    const rule = (payload && matchPmTrainRule(payload)) || matchPmLineRule(m.body); // 后者：结构化 P2 入积压 / 观察期转正的一行摘要
    // 批准的 CI 红报告本来就含 failure 日志；其他停单、告警、提问保护仍看完整正文。
    const checked = rule && rule.id === "train.hold" ? { ...m, body: m.body.replace("再申请合并槽", "") }
      : rule && rule.id === "train.ci-red" ? { ...m, body: m.body.replace(/失败|fail/gi, "") }
      : rule && rule.wire === "line" ? { ...m, body: pmLineFixedText(rule, m.body) } : m; // 编号 / 路径是结构化字段，不当正文搜
    if (protectedBody(checked)) return verdict("judge", "protect.action", "正文含 PMDIG3 保护或需要回应", true);
    if (rule) {
      const tag: PmRouteTag = { route: rule.route, rule: rule.id, reason: rule.reason };
      return { tags: [tag], ...(rule.route === "auto" ? { body: "" } : {}), ...(rule.digest ? { digest: true } : {}) };
    }
    if (m.body.startsWith("[合并列车]")) return verdict("judge", "train.unknown", "列车模板未核实，沿用旧路");
  }
  if (protectedBody(m)) return verdict("judge", "protect.action", "正文含 PMDIG3 保护或需要回应", true);
  const base = classifyPmPush(m);
  return base.send === "digest" ? verdict("digest", "pmdig.digest", "沿用现有摘要选择") : verdict("judge", "unknown", "未匹配批准的受信规则");
}
