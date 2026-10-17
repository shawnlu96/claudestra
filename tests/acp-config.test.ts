import { describe, expect, test } from "bun:test";
import { configRefusal, currentValueOf, modelStateEntry, parseConfigOptions, quotaCardChoices } from "../src/lib/acp/config.ts";

/** codex-acp 2.0.0 session/new 的 configOptions（ModelConfigOption.ts：平铺 select） */
const RAW = [
  {
    id: "mode",
    name: "Mode",
    category: "mode",
    type: "select",
    currentValue: "agent-full-access",
    options: [{ value: "read-only", name: "Read Only" }, { value: "agent-full-access", name: "Full Access" }],
  },
  {
    id: "model",
    name: "Model",
    category: "model",
    type: "select",
    currentValue: "gpt-5.6-sol",
    options: [
      { value: "gpt-5.6-sol", name: "gpt-5.6-sol", description: "flagship" },
      { value: "gpt-5.6-luna", name: "gpt-5.6-luna" },
      { value: "gpt-5.5-codex", name: "GPT-5.5 Codex" },
    ],
  },
  { id: "reasoning_effort", name: "Reasoning Effort", type: "select", currentValue: "high", options: [{ value: "low", name: "Low" }, { value: "high", name: "High" }] },
  { id: "broken" },
  null,
];

describe("parseConfigOptions", () => {
  test("select 项规整成 {id, name, currentValue, choices}，认不出的跳过", () => {
    const opts = parseConfigOptions(RAW);
    expect(opts.map((o) => o.id)).toEqual(["mode", "model", "reasoning_effort"]);
    expect(opts[1].choices[0]).toEqual({ value: "gpt-5.6-sol", name: "gpt-5.6-sol", description: "flagship" });
    expect(currentValueOf(opts, "reasoning_effort")).toBe("high");
    expect(parseConfigOptions(undefined)).toEqual([]);
  });

  test("宿主规整过的形状（choices，经 ws 发给 bridge 的）原样认回来，不丢模型", () => {
    const once = parseConfigOptions(RAW);
    const again = parseConfigOptions(JSON.parse(JSON.stringify(once)));
    expect(again).toEqual(once);
    expect(again[1]!.choices.map((c) => c.value)).toEqual(["gpt-5.6-sol", "gpt-5.6-luna", "gpt-5.5-codex"]);
  });

  test("fast-mode 的布尔当前值按字符串收", () => {
    const [o] = parseConfigOptions([{ id: "fast-mode", name: "Fast", currentValue: false, options: [{ value: "on", name: "On" }] }]);
    expect(o.currentValue).toBe("false");
  });
});

describe("configRefusal（set_config_option 之前本地挡掉，免得适配器回 -32602）", () => {
  const opts = parseConfigOptions(RAW);
  test("合法值放行", () => {
    expect(configRefusal(opts, "reasoning_effort", "low")).toBeNull();
    expect(configRefusal(opts, "model", "gpt-5.6-luna")).toBeNull();
  });
  test("没有这一项 / 没有这个值 → 说清楚能选什么", () => {
    expect(configRefusal(opts, "fast-mode", "on")).toContain("mode, model, reasoning_effort");
    expect(configRefusal(opts, "reasoning_effort", "xhigh")).toContain("low, high");
  });
});

describe("modelStateEntry（顶栏的 model / effort）", () => {
  test("与 rollout 翻出来的 model_state 同形", () => {
    expect(modelStateEntry(parseConfigOptions(RAW), "t")).toEqual({ type: "system", subtype: "model_state", timestamp: "t", model: "gpt-5.6-sol", effort: "high" });
  });
  test("模型不支持推理档位（没有 reasoning_effort 项）→ effort=null；没有模型项 → null", () => {
    expect(modelStateEntry(parseConfigOptions(RAW.slice(0, 2)), "t")).toMatchObject({ effort: null });
    expect(modelStateEntry([], "t")).toBeNull();
  });
});

describe("quotaCardChoices（规则细节在 tests/quota-fallback.test.ts）", () => {
  test("第一个是等重置；Codex 的模型都是同一个账号，一个都不列", () => {
    expect(quotaCardChoices(parseConfigOptions(RAW), "18:20 重置")).toEqual([{ value: null, label: "等重置（18:20 重置）" }]);
  });
  test("别家的模型照列，名字和值不同时都写上", () => {
    const opts = parseConfigOptions([{ id: "model", currentValue: "go/m1", options: [{ value: "go/m1" }, { value: "ds/m2", name: "M2" }] }]);
    expect(quotaCardChoices(opts)).toEqual([{ value: null, label: "等重置" }, { value: "ds/m2", label: "切到 M2（ds/m2）" }]);
  });
  test("没有模型项只给等重置", () => {
    expect(quotaCardChoices([])).toEqual([{ value: null, label: "等重置" }]);
  });
});
