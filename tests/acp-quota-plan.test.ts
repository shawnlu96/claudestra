import { afterEach, describe, expect, test } from "bun:test";
import { codexWalled, planAcpQuota, useAcpQuotaPort } from "../src/bridge/acp-quota.ts";
import { parseConfigOptions } from "../src/lib/acp/config.ts";
import type { InventoryQuota } from "../src/lib/ai-quota.ts";

const GO = "cc-switch-open-code-go";
const CURRENT = `${GO}/deepseek-v4.1-flash`;
const opts = (current = CURRENT) => parseConfigOptions([{
  id: "model", currentValue: current,
  options: [CURRENT, `${GO}/glm-5.3-flash`, "openai-codex/gpt-5.6-sol", "cc-switch-deep-seek/deepseek-v4-flash", "zai/glm-5.3"].map((value) => ({ value })),
}]);
const GO_LIMIT = { kind: "quota" as const, key: "quota:t1", message: '429 {"type":"GoUsageLimitError","message":"Go usage limit exceeded"}' };
const NOW = new Date(2026, 9, 17, 9, 0).getTime();
const WEEK_RESET = new Date(2026, 9, 22, 8, 0).getTime();
const codexFull: InventoryQuota = {
  status: "known", source: "live", observedAt: NOW, plan: "pro", reason: null,
  windows: [{ id: "weekly", kind: "weekly", usedPct: 100, resetsAtMs: WEEK_RESET, resetPassed: false }],
};
const port = (fallback: unknown, codex: InventoryQuota | null = codexFull) => useAcpQuotaPort({
  now: () => NOW, codexQuota: async () => codex, fallbackConfig: () => fallback, projectOf: async () => "claudestra",
});

afterEach(() => useAcpQuotaPort());

describe("planAcpQuota：卡上的原文、过滤和备用链", () => {
  test("原文进正文；Codex 额度快照到顶 → openai-codex 不列；同系列排第一标推荐", async () => {
    port(undefined);
    const p = await planAcpQuota("ch", GO_LIMIT, opts(), "Pi");
    expect(p.context).toContain("原文：GoUsageLimitError: Go usage limit exceeded");
    expect(p.context).toContain("重置时间：未知");
    expect(p.context).toContain("没列：openai-codex 也到顶了（Codex 额度快照");
    expect(p.choices.map((c) => c.value)).toEqual([null, "cc-switch-deep-seek/deepseek-v4-flash", "zai/glm-5.3"]);
    expect(p.choices[0]!.label).toBe("等重置（时间未知）");
    expect(p.choices[1]!.label).toContain("（推荐）");
  });

  test("observe（缺省）：卡上写会切到谁，不自动切", async () => {
    port({ chain: ["zai"] });
    const p = await planAcpQuota("ch", GO_LIMIT, opts(), "Pi");
    expect(p.autoSwitch).toBeNull();
    expect(p.context).toContain("按备用链会切到 zai/glm-5.3");
  });

  test("on：给出要切的模型和通知卡（附切回原模型）；off：什么都不提", async () => {
    port({ mode: "on", chain: ["openai-codex", "cc-switch-deep-seek"] });
    const on = await planAcpQuota("ch", GO_LIMIT, opts(), "Pi");
    expect(on.autoSwitch).toBe("cc-switch-deep-seek/deepseek-v4-flash");
    expect(on.switched?.context).toContain(`从 ${CURRENT} 切到 cc-switch-deep-seek/deepseek-v4-flash`);
    expect(on.switched?.choices[0]).toEqual({ value: CURRENT, label: `切回 ${CURRENT}` });

    port({ mode: "on", chain: ["zai"], projects: { claudestra: { mode: "off" } } });
    const off = await planAcpQuota("ch", GO_LIMIT, opts(), "Pi");
    expect(off.autoSwitch).toBeNull();
    expect(off.context).not.toContain("备用链");
  });

  test("本机刚撞过墙的 provider：别的 agent 的卡上也不列，到重置时刻失效；解析不出重置时间按 3 小时", async () => {
    let t = NOW;
    useAcpQuotaPort({ now: () => t, codexQuota: async () => null, fallbackConfig: () => undefined, projectOf: async () => undefined });
    const zai = () => planAcpQuota("b", GO_LIMIT, opts(), "Pi").then((p) => p.choices.some((c) => c.value === "zai/glm-5.3"));
    await planAcpQuota("a", { ...GO_LIMIT, message: "zai: usage limit, try again in 2 hours" }, opts("zai/glm-5.3"), "Pi");
    const p = await planAcpQuota("b", GO_LIMIT, opts(), "Pi");
    expect(p.context).toContain("没列：zai 也到顶了（本机 09:00 撞墙，重置 11:00）");
    expect(await zai()).toBe(false);
    t = NOW + 2 * 3_600_000;
    expect(await zai()).toBe(true);

    await planAcpQuota("a", GO_LIMIT, opts("zai/glm-5.3"), "Pi"); // 原文里没有重置时间
    t += 3 * 3_600_000 - 1;
    expect(await zai()).toBe(false);
    t += 1;
    expect(await zai()).toBe(true);
  });

  test("Codex：几个模型都是同一个账号 → 只给等重置；重置时间取额度快照", async () => {
    port(undefined);
    const codex = parseConfigOptions([{ id: "model", currentValue: "gpt-5.6-sol", options: [{ value: "gpt-5.6-sol" }, { value: "gpt-5.6-luna" }] }]);
    const p = await planAcpQuota("ch", { kind: "quota", key: "air:x", message: "You've hit your usage limit." }, codex, "Codex");
    expect(p.choices).toHaveLength(1);
    expect(p.choices[0]!.label).toBe("等重置（10月22日 08:00）");
    expect(p.context).toContain("没列：openai-codex 的另外 1 个模型（同一个账号 / 套餐");
    expect(p.context).toContain("没有别的能用的模型，只能等重置。");
  });

  test("额度快照读挂了：当不知道，照样出卡", async () => {
    useAcpQuotaPort({ now: () => NOW, codexQuota: async () => { throw new Error("boom"); }, fallbackConfig: () => undefined, projectOf: async () => undefined });
    const p = await planAcpQuota("ch", GO_LIMIT, opts(), "Pi");
    expect(p.choices.map((c) => c.value)).toContain("openai-codex/gpt-5.6-sol");
  });
});

describe("codexWalled", () => {
  test("提供方说撞限，或窗口满了且没过重置时刻才算", () => {
    expect(codexWalled(codexFull)).toEqual({ provider: "openai-codex", resetAt: WEEK_RESET, source: "Codex 额度快照" });
    expect(codexWalled({ ...codexFull, windows: [{ ...codexFull.windows[0]!, usedPct: 80 }] })).toBeNull();
    expect(codexWalled({ ...codexFull, windows: [{ ...codexFull.windows[0]!, resetPassed: true }] })).toBeNull();
    expect(codexWalled({ ...codexFull, windows: [], limitReached: true })?.resetAt).toBeNull();
    expect(codexWalled(null)).toBeNull();
  });
});

describe("ask-runtime quotaText：只有 ACP 额度卡换卡面，tmux 版 Codex 额度卡逐字照旧", () => {
  test("不给 quotaText = 改之前的 codexQuotaText；给了只换卡面，extra.raw / 过期时间 / 指纹都按原文", async () => {
    const { openRuntimeAsk, resetRuntimeAsksForTest } = await import("../src/bridge/ask-runtime.ts");
    const { setAsksForTest } = await import("../src/bridge/asks.ts");
    const { codexExpiry, codexQuotaText } = await import("../src/lib/ask-fingerprint.ts");
    const { listAsks } = await import("../src/lib/ledger-asks.ts");
    const { closeLedger, openLedger } = await import("../src/lib/ledger-store.ts");
    const { tempLedgerPath } = await import("./ledger-test-helpers.ts");
    const path = tempLedgerPath("acp-quota-text-");
    openLedger(path);
    const registry = ["tmux", "acp"].map((n) => ({ name: `agent-${n}`, channelId: `ch-${n}`, status: "active", projectId: "p" }));
    setAsksForTest({ path, registry: registry as never, ownerChats: [] });
    resetRuntimeAsksForTest();
    try {
      const raw = "You've hit your usage limit. Try again at 11:58 PM.";
      const base = { source: "codex" as const, kind: "decide" as const, title: "Codex 额度用完了", context: raw, options: [], quota: true as const };
      await openRuntimeAsk({ ...base, channelId: "ch-tmux", agentName: "agent-tmux" });
      await openRuntimeAsk({ ...base, channelId: "ch-acp", agentName: "agent-acp", acp: true, quotaText: "go 的额度到顶了\n原文：…" });
      const [tmux, acp] = ["ch-tmux", "ch-acp"].map((ch) => listAsks(openLedger(path), { project: "p" }).find((a) => a.fromChannelId === ch)!);
      expect(tmux.context).toBe(codexQuotaText(codexExpiry(raw, tmux.createdAt), tmux.createdAt));
      expect(acp.context).toBe("go 的额度到顶了\n原文：…");
      for (const a of [tmux, acp]) expect(a.extra).toMatchObject({ quota: true, raw });
      expect(acp.expiresAt).toBe(tmux.expiresAt);
      expect(acp.extra.fp).not.toBe(tmux.extra.fp); // 指纹带 agent / 频道，不同；同一张卡的指纹只看原文，见 tests/ask-dismiss.test.ts
    } finally {
      setAsksForTest(undefined);
      closeLedger(path);
    }
  });
});
