/**
 * Codex 的模型目录 / 顶栏状态读取 / 显示兜底链。
 * 格式样本取自 2026-09-25 本机 codex-cli 0.153.4 的 `codex debug models` 与 rollout。
 */
import { describe, test, expect } from "bun:test";
import {
  codexDisplayDefaults,
  parseCodexCatalog,
  parseCodexConfigDefaults,
  validateCodexChoice,
} from "../src/lib/codex-catalog.js";
import { codexLineToClaudeShape } from "../src/lib/codex-session.js";
import { scanSessionTail } from "../src/lib/session-tail.js";
import { displayModelEffort } from "../src/lib/display-model.js";

const L = (o: unknown) => JSON.stringify(o);
const lv = (...e: string[]) => e.map((effort) => ({ effort, description: "" }));
const RAW = {
  models: [
    { slug: "gpt-5.5", display_name: "GPT-5.5", visibility: "list", priority: 12, default_reasoning_level: "medium",
      supported_reasoning_levels: lv("low", "medium", "high", "xhigh"), context_window: 272000 },
    { slug: "gpt-6-astra", display_name: "GPT-6-Astra", visibility: "list", priority: 1, default_reasoning_level: "low",
      supported_reasoning_levels: lv("low", "medium", "high", "xhigh", "max", "ultra"), context_window: 272000 },
    { slug: "codex-auto-review", display_name: "Codex Auto Review", visibility: "hide", priority: 43 },
  ],
};

describe("parseCodexCatalog", () => {
  test("只留 visibility=list，按 priority 排；档位与默认档照抄", () => {
    const m = parseCodexCatalog(RAW);
    expect(m.map((x) => x.id)).toEqual(["gpt-6-astra", "gpt-5.5"]);
    expect(m[0]).toEqual({
      id: "gpt-6-astra", name: "GPT-6-Astra", efforts: ["low", "medium", "high", "xhigh", "max", "ultra"],
      defaultEffort: "low", contextWindow: 272000,
    });
  });
  test("坏输入不抛", () => {
    expect(parseCodexCatalog(null)).toEqual([]);
    expect(parseCodexCatalog({ models: "x" })).toEqual([]);
  });
});

describe("parseCodexConfigDefaults", () => {
  test("只读第一个 [表] 之前的顶层键", () => {
    const toml = 'model = "gpt-5.5"\nmodel_reasoning_effort = "high"\n\n[profiles.x]\nmodel = "o3"\n';
    expect(parseCodexConfigDefaults(toml)).toEqual({ model: "gpt-5.5", effort: "high" });
    expect(parseCodexConfigDefaults('notify = ["a"]\n[features]\njs_repl = false\n')).toEqual({ model: null, effort: null });
  });
});

describe("codexDisplayDefaults", () => {
  const cat = parseCodexCatalog(RAW);
  test("没写配置：目录第一个模型 + 它的默认档", () => {
    expect(codexDisplayDefaults(cat, { model: null, effort: null }, null)).toEqual({ model: "gpt-6-astra", effort: "low" });
  });
  test("会话已知模型时，档位按那个模型的默认档；配置写了档位就用配置", () => {
    expect(codexDisplayDefaults(cat, { model: null, effort: null }, "gpt-5.5")).toEqual({ model: "gpt-5.5", effort: "medium" });
    expect(codexDisplayDefaults(cat, { model: null, effort: "xhigh" }, "gpt-5.5").effort).toBe("xhigh");
  });
});

describe("validateCodexChoice", () => {
  const cat = parseCodexCatalog(RAW);
  test("目录里没有的模型、模型不支持的档位都拦下", () => {
    expect(validateCodexChoice(cat, { model: "gpt-9", effort: "", targetModel: "gpt-9" })).toContain("未知");
    expect(validateCodexChoice(cat, { model: "", effort: "ultra", targetModel: "gpt-5.5" })).toContain("不支持");
    expect(validateCodexChoice(cat, { model: "gpt-6-astra", effort: "ultra", targetModel: "gpt-6-astra" })).toBeNull();
  });
  test("值会进启动命令：非法字符和未知档位在目录拉不到时也拦", () => {
    expect(validateCodexChoice(null, { model: "a;rm", effort: "", targetModel: null })).toContain("非法");
    expect(validateCodexChoice(null, { model: "", effort: "turbo", targetModel: null })).toContain("未知");
    expect(validateCodexChoice(null, { model: "gpt-x", effort: "high", targetModel: "gpt-x" })).toBeNull();
  });
});

describe("rollout 里的模型 / 档位 / 占用", () => {
  const turn = (ts: string, effort?: string) => L({
    timestamp: ts, type: "turn_context",
    payload: { model: "gpt-6-astra", ...(effort ? { effort } : {}), collaboration_mode: { settings: { model: "gpt-6-astra", reasoning_effort: effort ?? null } } },
  });
  const tokens = (ts: string, total: number) => L({
    timestamp: ts, type: "event_msg",
    payload: { type: "token_count", info: { last_token_usage: { input_tokens: total - 5, output_tokens: 5, total_tokens: total }, model_context_window: 258400 } },
  });
  test("翻成 model_state / context_usage；只有限流信息的 token_count 丢掉", () => {
    expect(codexLineToClaudeShape(turn("2026-09-25T00:00:00Z", "high"))).toMatchObject({ subtype: "model_state", model: "gpt-6-astra", effort: "high" });
    expect(codexLineToClaudeShape(tokens("2026-09-25T00:00:01Z", 61987))).toMatchObject({ subtype: "context_usage", tokens: 61987, window: 258400 });
    expect(codexLineToClaudeShape(L({ type: "event_msg", payload: { type: "token_count", info: null } }))).toBeNull();
  });
  test("scanSessionTail：取最后一轮；最后一轮没设档位（null）就是默认档，不回退到更早的 high", () => {
    const text = [turn("2026-09-25T00:00:00Z", "high"), tokens("2026-09-25T00:00:01Z", 30000), turn("2026-09-25T01:00:00Z"), tokens("2026-09-25T01:00:01Z", 61987)].join("\n");
    const info = scanSessionTail(text, "codex");
    expect(info).toMatchObject({ ctxTokens: 61987, ctxWindow: 258400, model: "gpt-6-astra", effort: null });
    expect(info.effortTs).toBe(Date.parse("2026-09-25T01:00:00Z"));
  });
});

describe("displayModelEffort", () => {
  const base = {
    override: { model: null, effort: null }, reg: undefined, claudeGlobal: { model: "claude-fable-5-1", effort: "xhigh" },
    resolveAlias: (m: string) => (m === "opus" ? "claude-opus-5-5" : m), now: Date.parse("2026-09-25T02:00:00Z"),
  };
  const tail = { convTs: null, ctxTokens: null, ctxWindow: null, model: "gpt-6-astra", modelTs: Date.parse("2026-09-25T01:00:00Z"), effort: null, effortTs: null };
  test("Codex 不会落到 Claude Code 的全局默认：档位 null → 目录默认档", () => {
    const cat = parseCodexCatalog(RAW);
    const r = displayModelEffort({ ...base, runtime: "codex", tail, codex: { catalog: cat, config: { model: null, effort: null } } });
    expect(r).toEqual({ model: "gpt-6-astra", effort: "low" });
  });
  test("Claude Code：registry 的别名展开，缺了才用全局", () => {
    expect(displayModelEffort({ ...base, runtime: "claude-code", tail: null, reg: { model: "opus" } })).toEqual({ model: "claude-opus-5-5", effort: "xhigh" });
  });
  test("Pi：模型原样、不落 Claude Code 全局；档位用扩展快照兜底", () => {
    const r = displayModelEffort({ ...base, runtime: "pi", tail: null, reg: { model: "p/deepseek" }, piSnapThinking: "off" });
    expect(r).toEqual({ model: "p/deepseek", effort: "off" });
  });
  test("刚切换的乐观值优先", () => {
    const r = displayModelEffort({ ...base, runtime: "codex", tail, override: { model: "gpt-5.5", effort: "high" }, codex: { catalog: null, config: { model: null, effort: null } } });
    expect(r).toEqual({ model: "gpt-5.5", effort: "high" });
  });
});
