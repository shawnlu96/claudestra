import { afterEach, describe, expect, spyOn, test } from "bun:test";
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
  now: () => NOW, codexQuota: async () => codex, fallbackConfig: () => fallback, agentOf: async () => ({ name: "agent-x", projectId: "claudestra" }),
});

afterEach(() => useAcpQuotaPort());

describe("planAcpQuota：卡上的原文、过滤和备用链", () => {
  test("原文进正文；Codex 额度快照到顶 → openai-codex 不列；同系列排第一标推荐", async () => {
    port(undefined);
    const p = await planAcpQuota("ch", "agent-x", GO_LIMIT, opts(), "Pi");
    expect(p.context.split("\n").slice(0, 2)).toEqual([
      `${GO} 额度到顶：GoUsageLimitError: Go usage limit exceeded；重置 未知`, "推荐切到 cc-switch-deep-seek/deepseek-v4-flash",
    ]);
    expect(p.context).toContain("没列：openai-codex 也到顶了（Codex 额度快照");
    expect(p.choices.map((c) => c.value)).toEqual([null, "cc-switch-deep-seek/deepseek-v4-flash", "zai/glm-5.3"]);
    expect(p.choices[0]!.label).toBe("等重置（时间未知）");
    expect(p.choices[1]!.label).toContain("（推荐）");
  });

  test("observe（缺省）：卡上写会切到谁，不自动切", async () => {
    port({ chain: ["zai"] });
    const p = await planAcpQuota("ch", "agent-x", GO_LIMIT, opts(), "Pi");
    expect(p.autoSwitch).toBeNull();
    expect(p.context).toContain("按备用链会切到 zai/glm-5.3");
  });

  test("on：给出要切的模型和通知卡（附切回原模型）；off：什么都不提", async () => {
    port({ mode: "on", chain: ["openai-codex", "cc-switch-deep-seek"] });
    const on = await planAcpQuota("ch", "agent-x", GO_LIMIT, opts(), "Pi");
    expect(on.autoSwitch).toBe("cc-switch-deep-seek/deepseek-v4-flash");
    expect(on.switched?.context).toContain(`从 ${CURRENT} 切到 cc-switch-deep-seek/deepseek-v4-flash`);
    expect(on.switched?.choices[0]).toEqual({ value: CURRENT, label: `切回 ${CURRENT}` });

    port({ mode: "on", chain: ["zai"], projects: { claudestra: { mode: "off" } } });
    const off = await planAcpQuota("ch", "agent-x", GO_LIMIT, opts(), "Pi");
    expect(off.autoSwitch).toBeNull();
    expect(off.context).not.toContain("备用链");
  });

  test("本机刚撞过墙的 provider：别的 agent 的卡上也不列，到重置时刻失效；解析不出重置时间按 3 小时", async () => {
    let t = NOW;
    useAcpQuotaPort({ now: () => t, codexQuota: async () => null, fallbackConfig: () => undefined, agentOf: async () => undefined });
    const zai = () => planAcpQuota("b", "agent-x", GO_LIMIT, opts(), "Pi").then((p) => p.choices.some((c) => c.value === "zai/glm-5.3"));
    await planAcpQuota("a", "agent-x", { ...GO_LIMIT, message: "zai: usage limit, try again in 2 hours" }, opts("zai/glm-5.3"), "Pi");
    const p = await planAcpQuota("b", "agent-x", GO_LIMIT, opts(), "Pi");
    expect(p.context).toContain("没列：zai 也到顶了（本机 09:00 撞墙，重置 11:00）");
    expect(await zai()).toBe(false);
    t = NOW + 2 * 3_600_000;
    expect(await zai()).toBe(true);

    await planAcpQuota("a", "agent-x", GO_LIMIT, opts("zai/glm-5.3"), "Pi"); // 原文里没有重置时间
    t += 3 * 3_600_000 - 1;
    expect(await zai()).toBe(false);
    t += 1;
    expect(await zai()).toBe(true);
  });

  test("Codex：几个模型都是同一个账号 → 只给等重置并写明原因；id 不带前缀认不出是哪家，不套 Codex 快照的重置时间、不记撞墙", async () => {
    port(undefined);
    const codex = parseConfigOptions([{ id: "model", currentValue: "gpt-5.6-sol", options: [{ value: "gpt-5.6-sol" }, { value: "gpt-5.6-luna" }] }]);
    const p = await planAcpQuota("ch", "agent-x", { kind: "quota", key: "air:x", message: "You've hit your usage limit." }, codex, "Codex");
    expect(p.choices).toEqual([{ value: null, label: "等重置（时间未知）" }]);
    expect(p.context.split("\n").slice(0, 2)).toEqual([
      "Codex 当前账号 额度到顶：You've hit your usage limit.；重置 未知", "只能等重置（同一个账号的另外 1 个模型也用不了）",
    ]);
    // 没记 openai-codex 的撞墙：快照没说到顶时，Pi 会话照样能列 openai-codex 的模型
    useAcpQuotaPort({ now: () => NOW, codexQuota: async () => null, fallbackConfig: () => undefined, agentOf: async () => undefined });
    await planAcpQuota("c", "agent-x", { kind: "quota", key: "air:y", message: "429 GoUsageLimitError" }, codex, "Codex");
    expect((await planAcpQuota("ch", "agent-x", GO_LIMIT, opts(), "Pi")).choices.map((c) => c.value)).toContain("openai-codex/gpt-5.6-sol");
  });

  test("Pi 上明写 openai-codex/… 的模型：确认是 Codex 账号，重置时间取额度快照", async () => {
    port(undefined);
    const p = await planAcpQuota("ch", "agent-x", { kind: "quota", key: "q", message: "usage limit" }, opts("openai-codex/gpt-5.6-sol"), "Pi");
    expect(p.context.split("\n")[0]).toBe("openai-codex 额度到顶：usage limit；重置 10月22日 08:00");
  });

  test("on 档不对审查员 / 出借会话自动切：只出普通额度卡，第 3 行写原因", async () => {
    for (const [name, role, why] of [["agent-rv-qwc-1", undefined, "审查会话"], ["agent-x", "reviewer", "审查会话"], ["agent-lend-abc", undefined, "出借会话"]] as const) {
      useAcpQuotaPort({ now: () => NOW, codexQuota: async () => null, fallbackConfig: () => ({ mode: "on", chain: ["zai"] }), agentOf: async () => ({ name, role }) });
      const p = await planAcpQuota("ch", name, GO_LIMIT, opts(), "Pi");
      expect(p.autoSwitch).toBeNull();
      expect(p.context.split("\n")[2]).toBe(`按备用链该切到 zai/glm-5.3，但${why}不自动切`);
    }
  });

  test("身份无记录或查询异常：全局 on 不能绕过项目 off / reviewer 禁切，并记录查询异常", async () => {
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    try {
      for (const throws of [false, true]) {
        useAcpQuotaPort({
          now: () => NOW, codexQuota: async () => null,
          fallbackConfig: () => ({ mode: "on", chain: ["zai"], projects: { claudestra: { mode: "off" } } }),
          agentOf: async () => { if (throws) throw new Error("registry unavailable"); return undefined; },
        });
        for (const name of ["agent-x", "agent-rv-qwc-2"]) {
          const p = await planAcpQuota("ch", name, GO_LIMIT, opts(), "Pi");
          expect(p.autoSwitch).toBeNull();
          expect(p.context.split("\n")[2]).toContain("无法核对项目");
          expect(p.switched).toBeNull();
        }
      }
      expect(warn).toHaveBeenCalledTimes(2);
      expect(warn.mock.calls[0]![0]).toContain("registry unavailable");
    } finally {
      warn.mockRestore();
    }
  });

  test("身份确认但没有项目：仍继承全局 on", async () => {
    useAcpQuotaPort({
      now: () => NOW, codexQuota: async () => null,
      fallbackConfig: () => ({ mode: "on", chain: ["zai"] }), agentOf: async () => ({ name: "agent-x" }),
    });
    expect((await planAcpQuota("ch", "agent-x", GO_LIMIT, opts(), "Pi")).autoSwitch).toBe("zai/glm-5.3");
  });

  test("额度快照读挂了：当不知道，照样出卡", async () => {
    useAcpQuotaPort({ now: () => NOW, codexQuota: async () => { throw new Error("boom"); }, fallbackConfig: () => undefined, agentOf: async () => undefined });
    const p = await planAcpQuota("ch", "agent-x", GO_LIMIT, opts(), "Pi");
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
