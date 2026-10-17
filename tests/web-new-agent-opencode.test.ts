/** 新建 agent 弹窗的 OpenCode 选项：模型清单透传 + 不选模型不让建（web/lib/api/agents.ts） */
import { describe, expect, test } from "bun:test";
import { missingRequiredModel, normalizeRuntime } from "@/lib/api/agents";

const opencode = normalizeRuntime({
  id: "opencode",
  label: "OpenCode",
  available: true,
  models: ["opencode/big-pickle", 42, "", "anthropic/claude-sonnet-5"],
  modelRequired: true,
  noEffort: true,
});

describe("normalizeRuntime", () => {
  test("透传 models（只留非空字符串）与 modelRequired", () => {
    expect(opencode).toEqual({
      id: "opencode",
      label: "OpenCode",
      available: true,
      models: ["opencode/big-pickle", "anthropic/claude-sonnet-5"],
      modelRequired: true,
      noEffort: true,
    });
  });
  test("老形状不多出字段，available 非 true 一律 false", () => {
    expect(normalizeRuntime({ id: "codex", label: "Codex", available: "yes" })).toEqual({ id: "codex", label: "Codex", available: false });
    expect(normalizeRuntime({ id: "x", label: "X", available: true, models: "a", modelRequired: "true" })).toEqual({ id: "x", label: "X", available: true });
  });
});

describe("missingRequiredModel", () => {
  const list = [opencode, normalizeRuntime({ id: "codex", label: "Codex", available: true })];
  test("opencode 没选模型 → 拦下；选了就放行", () => {
    expect(missingRequiredModel(list, "opencode", "")).toBe(true);
    expect(missingRequiredModel(list, "opencode", "  ")).toBe(true);
    expect(missingRequiredModel(list, "opencode", "opencode/big-pickle")).toBe(false);
  });
  test("不要求模型的运行时（默认 / codex）留空也行", () => {
    expect(missingRequiredModel(list, "", "")).toBe(false);
    expect(missingRequiredModel(list, "codex", "")).toBe(false);
  });
});
