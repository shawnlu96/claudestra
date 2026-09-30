/** lib/ai-inventory-format.ts：不知道的写「未知」不写数字；doctor 一行在来源冲突 / 判不出时 warn。 */
import { describe, expect, test } from "bun:test";
import type { EndpointVerdict } from "../src/lib/ai-endpoints.js";
import { aiInventoryCheck, endpointLabel, formatAiInventory, quotaLabel } from "../src/lib/ai-inventory-format.js";
import type { AiInventory, RuntimeInventory } from "../src/lib/ai-inventory.js";
import { unknownQuota } from "../src/lib/ai-quota.js";

const ep = (o: Partial<EndpointVerdict>): EndpointVerdict => ({ kind: "official", host: null, provider: "anthropic", sources: [], conflict: false, models: {}, ...o });
const rt = (o: Partial<RuntimeInventory>): RuntimeInventory => ({
  id: "claude-code", name: "Claude Code", installed: true, version: "2.1.285", path: "/x/claude", install: "npm",
  endpoint: ep({}), quota: unknownQuota("没有数据"), evidence: null, ...o,
});

describe("标签", () => {
  test("接口三类", () => {
    expect(endpointLabel(ep({}))).toBe("官方（anthropic）");
    expect(endpointLabel(ep({ kind: "third_party", host: "api.deepseek.com" }))).toBe("第三方：api.deepseek.com");
    expect(endpointLabel(ep({ kind: "third_party", host: "Amazon Bedrock", provider: "Amazon Bedrock" }))).toBe("第三方：Amazon Bedrock（Amazon Bedrock）");
    expect(endpointLabel(ep({ kind: "unknown", provider: null }))).toBe("未知");
  });
  test("额度：未知不出数字；已过重置写应已重置", () => {
    expect(quotaLabel(unknownQuota("没有快照"))).toBe("未知（没有快照）");
    const s = quotaLabel({ status: "known", source: "local_cache", observedAt: null, plan: "pro", reason: null, windows: [
      { id: "5h", kind: "session", usedPct: null, resetsAtMs: 1, resetPassed: true },
      { id: "7d", kind: "weekly", usedPct: 30, resetsAtMs: null, resetPassed: false },
    ] });
    expect(s).toContain("5h 应已重置（用量未知）");
    expect(s).toContain("7d 已用 30%（剩 70%，重置时间未知）");
    expect(s).not.toMatch(/5h[^；]*\d+%/);
  });
});

test("人读输出：未安装、模型证据为空都写明", () => {
  const inv: AiInventory = { generatedAt: Date.now(), runtimes: [
    rt({ evidence: { source: "response_model", sample: 0, limit: 200, from: null, to: null, models: [], filesScanned: 0 } }),
    rt({ id: "pi", name: "Pi", installed: false }),
  ] };
  const text = formatAiInventory(inv);
  expect(text).toContain("■ Pi：未安装");
  expect(text).toContain("实际模型：未知");
  expect(text).toContain("额度：未知（没有数据）");
});

describe("doctor 一行", () => {
  test("正常 ok", () => {
    const c = aiInventoryCheck({ generatedAt: 0, runtimes: [rt({}), rt({ id: "pi", name: "Pi", installed: false })] });
    expect(c.status).toBe("ok");
    expect(c.detail).toBe("Claude Code 2.1.285 官方（anthropic） · Pi 未安装");
  });
  test("来源冲突 / 判不出 → warn；Pi 的「未知」不算", () => {
    expect(aiInventoryCheck({ generatedAt: 0, runtimes: [rt({ endpoint: ep({ kind: "third_party", host: "h", conflict: true }) })] }).status).toBe("warn");
    expect(aiInventoryCheck({ generatedAt: 0, runtimes: [rt({ endpoint: ep({ kind: "unknown" }) })] }).status).toBe("warn");
    expect(aiInventoryCheck({ generatedAt: 0, runtimes: [rt({ id: "pi", name: "Pi", endpoint: ep({ kind: "unknown" }) })] }).status).toBe("ok");
  });
  test("一个都没装 → warn", () => {
    expect(aiInventoryCheck({ generatedAt: 0, runtimes: [rt({ installed: false })] }).status).toBe("warn");
  });
});
