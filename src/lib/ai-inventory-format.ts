/**
 * AI 能力清单的人读输出与 doctor 摘要（纯函数，tests/ai-inventory-format.test.ts）。取数在 ai-inventory.ts。
 * 不知道的一律写「未知」，不写 0、不写空。
 */

import type { EndpointVerdict } from "./ai-endpoints.js";
import type { AiInventory, RuntimeInventory } from "./ai-inventory.js";
import type { InventoryQuota } from "./ai-quota.js";
import type { Check } from "./doctor.js";

const UNKNOWN = "未知";

export function endpointLabel(e: EndpointVerdict): string {
  if (e.kind === "official") return `官方（${e.provider ?? UNKNOWN}）`;
  if (e.kind === "third_party") return `第三方：${e.host ?? UNKNOWN}${e.provider && e.provider !== "anthropic" && e.provider !== "openai" ? `（${e.provider}）` : ""}`;
  return e.provider ? `接入商 ${e.provider}（官方与否${UNKNOWN}）` : UNKNOWN;
}

const LAYER: Record<string, string> = { live: "订阅接口", live_stale: "订阅接口（旧快照）", local_cache: "本机缓存", none: "无" };

const clock = (ms: number | null) => {
  if (ms === null) return UNKNOWN;
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getMonth() + 1}/${d.getDate()} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
};

export function quotaLabel(q: InventoryQuota): string {
  if (q.status === "unknown" && !q.windows.length) return `${UNKNOWN}（${q.reason ?? "没有数据"}）`;
  const wins = q.windows.map((w) => {
    if (w.resetPassed) return `${w.id} 应已重置（用量${UNKNOWN}）`;
    return w.usedPct === null ? `${w.id} ${UNKNOWN}` : `${w.id} 已用 ${w.usedPct}%（剩 ${100 - w.usedPct}%，${w.resetsAtMs === null ? `重置时间${UNKNOWN}` : `${clock(w.resetsAtMs)} 重置`}）`;
  });
  const src = `${LAYER[q.source ?? "none"] ?? q.source}，${clock(q.observedAt)} 观测`;
  return `${q.plan ? `${q.plan} · ` : ""}${wins.join("；")}  [${src}]`;
}

function runtimeLines(r: RuntimeInventory): string[] {
  if (!r.installed) return [`■ ${r.name}：未安装`];
  const lines = [`■ ${r.name} ${r.version ?? `版本${UNKNOWN}`}${r.install ? `（${r.install}）` : ""}  ${r.path ?? ""}`.trimEnd()];
  lines.push(`  接口：${endpointLabel(r.endpoint)}${r.endpoint.conflict ? "  ⚠ 来源之间不一致" : ""}`);
  for (const s of r.endpoint.sources) lines.push(`    · ${s.from}：${s.baseUrl ?? s.host ?? UNKNOWN}${s.note ? `（${s.note}）` : ""}`);
  if (r.endpoint.note) lines.push(`    · ${r.endpoint.note}`);
  const models = Object.entries(r.endpoint.models);
  lines.push(`  配置模型：${models.length ? models.map(([k, v]) => `${v}（${k}）`).join("，") : "没写（用运行时缺省）"}`);
  const ev = r.evidence;
  if (ev) {
    const what = ev.source === "request_model" ? "请求模型" : "响应模型";
    lines.push(ev.sample
      ? `  实际模型（最近 ${ev.sample} 次${what}）：${ev.models.map((m) => `${m.model} ${Math.round(m.share * 100)}%`).join("，")}`
      : `  实际模型：${UNKNOWN}（最近 14 天没有会话记录）`);
  }
  lines.push(`  额度：${quotaLabel(r.quota)}`);
  return lines;
}

export function formatAiInventory(inv: AiInventory): string {
  return [`本机 AI 能力清单（${clock(inv.generatedAt)}）`, "", ...inv.runtimes.flatMap((r) => [...runtimeLines(r), ""])].join("\n").trimEnd();
}

/** doctor 一行：各运行时的版本与接口；有来源冲突 / 判不出时 warn */
export function aiInventoryCheck(inv: AiInventory): Check {
  const installed = inv.runtimes.filter((r) => r.installed);
  const detail = inv.runtimes.map((r) => (r.installed ? `${r.name} ${r.version ?? ""} ${endpointLabel(r.endpoint)}`.replace(/\s+/g, " ") : `${r.name} 未安装`)).join(" · ");
  const odd = installed.filter((r) => r.id !== "pi" && (r.endpoint.conflict || r.endpoint.kind === "unknown"));
  return odd.length
    ? { group: "AI 能力清单", name: "运行时与接口", status: "warn", detail,
        fix: `${odd.map((r) => r.name).join("、")} 的接口来源不一致或判不出：bun src/manager.ts ai-inventory 看每条来源` }
    : { group: "AI 能力清单", name: "运行时与接口", status: installed.length ? "ok" : "warn", detail,
        ...(installed.length ? {} : { fix: "一个 agent 运行时都没找到：先装 Claude Code（npm i -g @anthropic-ai/claude-code）" }) };
}

/** doctor 入口：只探安装与接口，不扫会话记录、不读额度（doctor 要快） */
export async function checkAiInventory(): Promise<Check[]> {
  try {
    const { collectAiInventory } = await import("./ai-inventory.js");
    return [aiInventoryCheck(await collectAiInventory({ evidence: false, quota: false }))];
  } catch (e) {
    return [{ group: "AI 能力清单", name: "运行时与接口", status: "warn", detail: `清单生成失败：${(e as Error).message}` }];
  }
}
