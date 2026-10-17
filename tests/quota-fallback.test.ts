import { describe, expect, test } from "bun:test";
import { quotaCardChoices, parseConfigOptions } from "../src/lib/acp/config.ts";
import {
  fallbackTarget, providerOf, quotaCardText, rawQuotaText, resolveFallback, seriesOf, switchedCardText, usableModels, whenText, type QuotaCardFacts,
} from "../src/lib/acp/quota-fallback.ts";

// dn-go-pi3 10-16 撞 Go 套餐时下拉里的样子（节选）
const GO = "cc-switch-open-code-go";
const CURRENT = `${GO}/deepseek-v4.1-flash`;
const CHOICES = [
  CURRENT, `${GO}/glm-5.3-flash`, `${GO}/muse-spark`,
  "openai-codex/gpt-5.6-sol", "openai-codex/gpt-5.5-codex",
  "deepseek-api/deepseek-flash", "cc-switch-deep-seek/deepseek-v4-flash", "zai/glm-5.3",
].map((value) => ({ value, name: value }));
const OPTS = parseConfigOptions([{ id: "model", name: "Model", currentValue: CURRENT, options: CHOICES }]);

describe("usableModels：只留真能走通的", () => {
  test("同 provider 的一律不列（同一个套餐）", () => {
    const r = usableModels(CURRENT, CHOICES, []);
    expect(r.usable.some((c) => providerOf(c.value) === GO)).toBe(false);
    expect(r.sameProvider).toBe(2);
  });

  test("已知到顶的 provider 不列，计数单独报", () => {
    const r = usableModels(CURRENT, CHOICES, ["openai-codex"]);
    expect(r.usable.map((c) => c.value)).not.toContain("openai-codex/gpt-5.6-sol");
    expect(r.walled).toBe(2);
  });

  test("同系列优先、版本近的在前，第一个标推荐", () => {
    const r = usableModels(CURRENT, CHOICES, ["openai-codex"]);
    expect(r.usable.map((c) => c.value)).toEqual(["cc-switch-deep-seek/deepseek-v4-flash", "deepseek-api/deepseek-flash", "zai/glm-5.3"]);
    expect(r.recommended).toBe(true);
    const labels = quotaCardChoices(OPTS, "08:00", ["openai-codex"]).map((c) => c.label);
    expect(labels[0]).toBe("等重置（08:00）");
    expect(labels[1]).toBe("切到 cc-switch-deep-seek/deepseek-v4-flash（推荐）");
    expect(labels.filter((l) => l.includes("推荐"))).toHaveLength(1);
  });

  test("剩下的都不同系列：不标推荐", () => {
    const r = usableModels(CURRENT, [{ value: CURRENT, name: CURRENT }, { value: "zai/glm-5.3", name: "glm" }], []);
    expect(r.usable).toHaveLength(1);
    expect(r.recommended).toBe(false);
  });

  test("一个能用的都没有：只给等重置", () => {
    const only = parseConfigOptions([{ id: "model", currentValue: CURRENT, options: CHOICES.filter((c) => [GO, "openai-codex"].includes(providerOf(c.value))) }]);
    expect(quotaCardChoices(only, undefined, ["openai-codex"])).toEqual([{ value: null, label: "等重置" }]);
  });

  test("Codex 的模型值不带前缀：都算 openai-codex 一家", () => {
    expect(providerOf("gpt-5.6-sol")).toBe("openai-codex");
    const codex = parseConfigOptions([{ id: "model", currentValue: "gpt-5.6-sol", options: [{ value: "gpt-5.6-sol" }, { value: "gpt-5.6-luna" }] }]);
    expect(quotaCardChoices(codex)).toEqual([{ value: null, label: "等重置" }]);
  });

  test("系列解析：去掉版本号，版本按大小比远近", () => {
    expect(seriesOf("go/deepseek-v4.1-flash")).toEqual({ base: "deepseek-flash", vendor: "deepseek", version: 4001 });
    expect(seriesOf("deepseek-flash").version).toBeNull();
  });
});

describe("备用链", () => {
  const usable = usableModels(CURRENT, CHOICES, ["openai-codex"]).usable;
  test("按链的顺序取第一个能落地的；provider 项取这家排最前的模型；只写 id 也认", () => {
    expect(fallbackTarget(["openai-codex", "zai", "cc-switch-deep-seek"], usable)).toBe("zai/glm-5.3");
    expect(fallbackTarget(["deepseek-flash"], usable)).toBe("deepseek-api/deepseek-flash");
    expect(fallbackTarget(["openai-codex"], usable)).toBeNull();
    expect(fallbackTarget([], usable)).toBeNull();
  });

  test("配置：缺省 observe、空链；项目覆盖全局；写坏的字段当没写", () => {
    expect(resolveFallback(undefined, "p")).toEqual({ mode: "observe", chain: [] });
    const raw = { mode: "on", chain: ["a", 3, " "], projects: { p: { mode: "off" }, q: { chain: ["b"] }, r: { mode: "bogus" } } };
    expect(resolveFallback(raw, undefined)).toEqual({ mode: "on", chain: ["a"] });
    expect(resolveFallback(raw, "p")).toEqual({ mode: "off", chain: ["a"] });
    expect(resolveFallback(raw, "q")).toEqual({ mode: "on", chain: ["b"] });
    expect(resolveFallback(raw, "r").mode).toBe("on");
  });
});

describe("卡片正文", () => {
  const now = new Date(2026, 9, 17, 9, 0).getTime();
  const facts: QuotaCardFacts = {
    label: "Pi", current: CURRENT, provider: GO, now, resetAt: null, sameProvider: 2, usable: 3,
    message: '429 {"type":"GoUsageLimitError","message":"Go usage limit exceeded"}',
    walled: [{ provider: "openai-codex", resetAt: new Date(2026, 9, 22, 8, 0).getTime(), source: "Codex 额度快照" }],
    fallback: "observe", chain: ["cc-switch-deep-seek"], target: "cc-switch-deep-seek/deepseek-v4-flash",
  };

  test("原文、到顶的 provider、重置时间（未知）、没列的原因、observe 会切到谁、怎么切回", () => {
    const text = quotaCardText(facts);
    expect(text).toContain(`${GO} 的额度到顶了`);
    expect(text).toContain("原文：GoUsageLimitError: Go usage limit exceeded");
    expect(text).toContain("重置时间：未知");
    expect(text).toContain(`没列：${GO} 的另外 2 个模型`);
    expect(text).toContain("没列：openai-codex 也到顶了（Codex 额度快照，重置 10月22日 08:00）");
    expect(text).toContain("按备用链会切到 cc-switch-deep-seek/deepseek-v4-flash（现在是 observe 档");
    expect(text).toContain(`模型下拉里选 ${CURRENT}`);
    expect(text).not.toContain("没有别的能用的模型");
  });

  test("off 档不提备用链；一个都没有写明只能等重置；能解析的重置时间照写", () => {
    const text = quotaCardText({ ...facts, fallback: "off", usable: 0, resetAt: new Date(2026, 9, 17, 14, 5).getTime() });
    expect(text).not.toContain("备用链");
    expect(text).toContain("没有别的能用的模型，只能等重置。");
    expect(text).toContain("重置时间：14:05");
  });

  test("自动切换的通知卡：从谁切到谁、原因、不自动切回", () => {
    const text = switchedCardText({ ...facts, target: "cc-switch-deep-seek/deepseek-v4-flash" });
    expect(text).toContain(`从 ${CURRENT} 切到 cc-switch-deep-seek/deepseek-v4-flash`);
    expect(text).toContain("GoUsageLimitError: Go usage limit exceeded");
    expect(text).toContain("不会自动切回");
  });

  test("原文：认 {type,message} 和 error 套一层；不是 JSON 原样截断", () => {
    expect(rawQuotaText('{"error":{"type":"usage_limit","message":"weekly cap"}}')).toBe("usage_limit: weekly cap");
    expect(rawQuotaText("You've hit your usage limit.")).toBe("You've hit your usage limit.");
    expect(rawQuotaText("x".repeat(600))).toHaveLength(501);
    expect(whenText(null, now)).toBe("未知");
  });
});
