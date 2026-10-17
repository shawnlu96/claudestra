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
  const DS = "cc-switch-deep-seek/deepseek-v4-flash";
  const facts: QuotaCardFacts = {
    label: "Pi", current: CURRENT, provider: GO, now, resetAt: null, sameProvider: 2, usable: [DS, "zai/glm-5.3"], recommended: true,
    message: '429 {"type":"GoUsageLimitError","message":"Go usage limit exceeded"}',
    walled: [{ provider: "openai-codex", resetAt: new Date(2026, 9, 22, 8, 0).getTime(), source: "Codex 额度快照" }],
    fallback: "observe", chain: ["cc-switch-deep-seek"], target: DS,
  };
  const top3 = (t: string) => t.split("\n").slice(0, 3);

  test("前 3 行：谁到顶 + 原文摘要 + 重置时间；推荐切到谁；observe 会切到谁", () => {
    expect(top3(quotaCardText(facts))).toEqual([
      `${GO} 额度到顶：GoUsageLimitError: Go usage limit exceeded；重置 未知`,
      `推荐切到 ${DS}`,
      `按备用链会切到 ${DS}（observe 档，没有自动切）`,
    ]);
  });

  test("后面才是完整原文、没列的原因、怎么切回", () => {
    const rest = quotaCardText(facts).split("\n").slice(3).join("\n");
    expect(rest).toContain(`当前模型：${CURRENT}；原文：GoUsageLimitError: Go usage limit exceeded`);
    expect(rest).toContain(`没列：${GO} 的另外 2 个模型`);
    expect(rest).toContain("没列：openai-codex 也到顶了（Codex 额度快照，重置 10月22日 08:00）");
    expect(rest).toContain(`模型下拉里选 ${CURRENT}`);
  });

  test("一个都没有：第 2 行写只能等重置和原因；off 档不提备用链；能解析的重置时间照写", () => {
    const lines = top3(quotaCardText({ ...facts, fallback: "off", usable: [], resetAt: new Date(2026, 9, 17, 14, 5).getTime() }));
    expect(lines[0]).toEndWith("；重置 14:05");
    expect(lines[1]).toBe("只能等重置（同一个账号的另外 2 个模型也用不了，openai-codex 也到顶了）");
    expect(lines.join("\n")).not.toContain("备用链");
    expect(quotaCardText({ ...facts, usable: [], sameProvider: 0, walled: [] }).split("\n")[1]).toBe("只能等重置（下拉里没有别家的模型）");
  });

  test("on 档第 3 行：不自动切的原因 / 切了没成；同系列以外的第一个只写「可以切到」", () => {
    expect(top3(quotaCardText({ ...facts, fallback: "on", noAuto: "审查会话不自动切" }))[2]).toBe(`按备用链该切到 ${DS}，但审查会话不自动切`);
    expect(top3(quotaCardText({ ...facts, fallback: "on", switchError: "Invalid params" }))[2]).toBe(`按备用链切到 ${DS} 没成：Invalid params`);
    expect(top3(quotaCardText({ ...facts, recommended: false }))[1]).toBe(`可以切到 ${DS}`);
  });

  test("摘要截到 80 字，原文截到 500 字（JSON 分支也一样）", () => {
    const long = quotaCardText({ ...facts, message: JSON.stringify({ type: "T", message: "x".repeat(20_000) }) });
    expect(long.split("\n")[0]!.length).toBeLessThan(140);
    expect(rawQuotaText(JSON.stringify({ type: "T", message: "x".repeat(20_000) }))).toHaveLength(501);
    expect(rawQuotaText("x".repeat(600))).toHaveLength(501);
  });

  test("自动切换的通知卡：从谁切到谁、原因、不自动切回、重置前切回会再撞墙", () => {
    const text = switchedCardText({ ...facts, target: DS });
    expect(text.split("\n")[0]).toBe(`已按备用链从 ${CURRENT} 切到 ${DS}`);
    expect(text).toContain("GoUsageLimitError: Go usage limit exceeded");
    expect(text).toContain("不会自动切回");
    expect(text).toContain("重置前切回会再撞一次墙");
  });

  test("原文：认 {type,message} 和 error 套一层；不是 JSON 原样", () => {
    expect(rawQuotaText('{"error":{"type":"usage_limit","message":"weekly cap"}}')).toBe("usage_limit: weekly cap");
    expect(rawQuotaText("You've hit your usage limit.")).toBe("You've hit your usage limit.");
    expect(whenText(null, now)).toBe("未知");
  });
});
