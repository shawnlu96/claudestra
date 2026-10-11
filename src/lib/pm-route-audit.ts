import { classifyPmPush, type DigestInput } from "./pm-digest.js";
import { isPmReadyAuditItem, matchPmAuditRule, type PmAuditItem } from "./pm-route-rules.js";
import type { PmRoutePlan, PmRouteTag } from "./pm-route-types.js";

const HEAD = /^\[🔎 台账巡检\] 新发现 (\d+) 条可能漏了的事（只报新出现的，同一条不会重复推；不用回复）：$/;
/** 只接受现有单行 wire；序号、计数、尾行或任何行有歧义就整封沿用旧路。 */
function parse(body: string): { head: string; tail: string; items: PmAuditItem[] } | undefined {
  const lines = body.split("\n"), head = lines[0] ?? "", count = HEAD.exec(head)?.[1], tail = lines.at(-1) ?? "";
  if (!count || Number(count) < 1 || !/^全部未解决的：.+$/.test(tail) || lines.length !== Number(count) + 2) return;
  const items: PmAuditItem[] = [];
  for (const [index, raw] of lines.slice(1, -1).entries()) {
    const row = /^(\d+)\. (?:\[([a-z_]+)\] )?([A-Za-z0-9_.:-]+) · (.+?) — (.+)$/.exec(raw);
    if (!row || Number(row[1]) !== index + 1) return;
    items.push({ n: index + 1, declared: row[2], target: row[3]!, suggestion: row[4]!, detail: row[5]!, raw });
  }
  return { head, tail, items };
}

function tag(item: PmAuditItem, input: DigestInput): PmRouteTag {
  if (/需(?:要)?\s*owner|owner\s*(?:决策|拍板)/i.test(item.raw)) {
    return { route: "owner", rule: "protect.decision", reason: "巡检条目明确需要 owner 决策", item: item.n };
  }
  const rule = matchPmAuditRule(item);
  const body = isPmReadyAuditItem(item)
    ? item.raw.replace(` — ${item.detail}`, ` — ${item.detail.replace("；实际阻塞：", "；")}`) : item.raw;
  const important = classifyPmPush({ ...input, fromKind: "local", sender: "pm-route-protection", oneShot: true, body });
  if (important.send === "now" || /alarm|告警|报警|需(?:要)?回应/i.test(body)) return { route: "judge", rule: "protect.audit", reason: "巡检条目含要紧事或需要回应", item: item.n };
  return rule ? { route: "auto", rule: rule.id, reason: rule.reason, item: item.n, type: rule.type }
    : { route: "judge", rule: "audit.unknown", reason: "未核实为批准的巡检事实", item: item.n, ...(item.declared ? { type: item.declared } : {}) };
}

export function routePmAudit(input: DigestInput): PmRoutePlan | undefined {
  const parsed = parse(input.body);
  if (!parsed) return;
  const tags = parsed.items.map((i) => tag(i, input)), remaining = parsed.items.filter((_, i) => tags[i]!.route !== "auto");
  const body = remaining.length ? [parsed.head.replace(`新发现 ${parsed.items.length} 条`, `新发现 ${remaining.length} 条`),
    ...remaining.map((i, index) => i.raw.replace(/^\d+\./, `${index + 1}.`)), parsed.tail].join("\n") : "";
  return { tags, body, immediate: tags.some((t) => t.rule === "protect.audit" || t.route === "owner") };
}
