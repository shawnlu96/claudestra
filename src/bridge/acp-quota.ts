/**
 * ACP 额度卡的 bridge 一侧（acp-link.ts 的额度分支只调这里）：凑齐「谁到顶、原文、几点重置、哪些 provider 也到顶、备用链怎么走」，
 * 交给 lib/acp/quota-fallback.ts 出正文和选项。已知到顶的 provider 有两个来源（docs/architecture/acp-quota.md）：
 * - Codex 额度快照（lib/ai-quota.ts readInventoryQuota，和网页额度看板同一份）：提供方说已撞限，或有窗口用到 100% 且没过重置时刻 → openai-codex；
 * - 本 bridge 进程里最近撞过墙的 provider（ACP agent 报过额度失败、且当前模型带 provider 前缀就记一笔），到重置时刻失效；解析不出重置时间按 UNKNOWN_RESET_TTL_MS。
 * tests/acp-quota-plan.test.ts。
 */
import { parseResetAt } from "../lib/autopilot-run.js";
import { readInventoryQuota, type InventoryQuota } from "../lib/ai-quota.js";
import { quotaCardChoices, type ConfigOption, type QuotaChoice } from "../lib/acp/config.js";
import type { AcpFailure } from "../lib/acp/failures.js";
import {
  CODEX_PROVIDER, fallbackTarget, providerOf, quotaCardText, resolveFallback, switchedCardText, usableModels, whenText,
  type QuotaCardFacts, type WalledProvider,
} from "../lib/acp/quota-fallback.js";
import { readConfigSync } from "../lib/config-store.js";
import { readRegistryAgents, type RegistryAgent } from "../lib/registry.js";

// ponytail: 原文里没有重置时间时按 3 小时当它还到顶；provider 给出可读的重置时间就用它的
const UNKNOWN_RESET_TTL_MS = 3 * 3_600_000;

export interface AcpQuotaPort {
  now(): number;
  codexQuota(): Promise<InventoryQuota | null>;
  fallbackConfig(): unknown;
  agentOf(channelId: string): Promise<Pick<RegistryAgent, "name" | "role" | "projectId"> | undefined>;
}

const PRODUCTION: AcpQuotaPort = {
  now: () => Date.now(),
  codexQuota: async () => (await readInventoryQuota()).codex,
  fallbackConfig: () => readConfigSync().quotaFallback,
  agentOf: async (channelId) => (await readRegistryAgents()).find((a) => a.channelId === channelId),
};
let port = PRODUCTION;
/** 仅测试：换掉时钟 / 额度快照 / 配置 / 项目查询，同时清空撞墙记录（不传 = 换回生产的） */
export function useAcpQuotaPort(p?: Partial<AcpQuotaPort>): void {
  port = { ...PRODUCTION, ...p };
  hits.clear();
}

/** provider → 本进程里最近一次撞墙 */
const hits = new Map<string, { at: number; resetAt: number | null }>();

/** Codex 额度快照说到顶了 → openai-codex 的到顶记录（重置时间取到顶窗口里最晚的那个） */
export function codexWalled(q: InventoryQuota | null): WalledProvider | null {
  if (!q) return null;
  const full = q.windows.filter((w) => w.usedPct !== null && w.usedPct >= 100 && !w.resetPassed);
  if (q.limitReached !== true && !full.length) return null;
  const resets = full.map((w) => w.resetsAtMs).filter((x): x is number => x !== null);
  return { provider: CODEX_PROVIDER, resetAt: resets.length ? Math.max(...resets) : null, source: "Codex 额度快照" };
}

function walledProviders(now: number, codex: WalledProvider | null): WalledProvider[] {
  const out: WalledProvider[] = codex ? [codex] : [];
  for (const [provider, h] of hits) {
    if ((h.resetAt ?? h.at + UNKNOWN_RESET_TTL_MS) <= now) hits.delete(provider);
    else if (provider !== codex?.provider) out.push({ provider, resetAt: h.resetAt, source: `本机 ${whenText(h.at, now)} 撞墙` });
  }
  return out;
}

/** on 档也不自动换模型的会话：审查员（换了模型可能悄悄变成同族审查）和出借 worker（会拿本机别家的额度去干 peer 的活） */
function noAutoReason(agentName: string, a: Pick<RegistryAgent, "role"> | undefined): string | undefined {
  if (a?.role === "reviewer" || /^agent-(rv|cv)-/.test(agentName)) return "审查会话不自动切";
  if (/^agent-lend-/.test(agentName)) return "出借会话不自动切";
  return undefined;
}

export interface AcpQuotaPlan {
  /** 出卡要的事实；acp-link 切换失败时带上 switchError 重出正文 */
  facts: QuotaCardFacts;
  context: string;
  choices: QuotaChoice[];
  /** 备用链 on 档且有能切的：bridge 直接切过去 */
  autoSwitch: string | null;
  /** 切成了以后那张通知卡 */
  switched: { title: string; context: string; choices: QuotaChoice[] } | null;
}

export async function planAcpQuota(channelId: string, agentName: string, f: AcpFailure, opts: readonly ConfigOption[], label: string): Promise<AcpQuotaPlan> {
  const now = port.now();
  const model = opts.find((o) => o.id === "model");
  const current = model?.currentValue ?? "";
  // 不带前缀的模型 id（Codex）认不出是哪家：适配器的 model_provider 可能是第三方。不记撞墙、不套 Codex 快照的重置时间
  const confirmed = current.includes("/");
  const provider = confirmed ? providerOf(current) : CODEX_PROVIDER;
  const shown = confirmed ? provider : `${label} 当前账号`;
  const codex = codexWalled(await port.codexQuota().catch((e) => (console.warn(`⚠️ 额度卡读 Codex 额度快照失败：${(e as Error).message}`), null)));
  const resetAt = parseResetAt(f.message, now) ?? (confirmed && provider === CODEX_PROVIDER ? codex?.resetAt ?? null : null);
  if (confirmed) hits.set(provider, { at: now, resetAt });
  const walled = walledProviders(now, codex).filter((w) => w.provider !== provider);
  const { usable, sameProvider, recommended } = usableModels(current, model?.choices ?? [], walled.map((w) => w.provider));
  const agent = await port.agentOf(channelId).catch(() => undefined); // 查不到 = 只用全局配置、按普通会话处理
  const cfg = resolveFallback(port.fallbackConfig(), agent?.projectId);
  const target = cfg.mode === "off" ? null : fallbackTarget(cfg.chain, usable);
  const noAuto = cfg.mode === "on" ? noAutoReason(agentName, agent) : undefined;
  const facts: QuotaCardFacts = {
    label, current: current || "未知", provider: shown, message: f.message, resetAt, now, sameProvider,
    walled: walled.filter((w) => model?.choices.some((c) => c.value !== current && providerOf(c.value) === w.provider)),
    usable: usable.map((c) => c.value), recommended, fallback: cfg.mode, chain: cfg.chain, target, ...(noAuto ? { noAuto } : {}),
  };
  const choices = quotaCardChoices(opts, resetAt === null ? "时间未知" : whenText(resetAt, now), walled.map((w) => w.provider));
  return {
    facts, context: quotaCardText(facts), choices, autoSwitch: cfg.mode === "on" && !noAuto ? target : null,
    switched: target && current ? {
      title: `${label} 额度到顶，已切到 ${target}`,
      context: switchedCardText({ ...facts, target }),
      choices: [{ value: current, label: `切回 ${current}` }, { value: null, label: "知道了" }],
    } : null,
  };
}
