import { describe, test, expect } from "bun:test";
import { modelTargetKey, sameModelTarget } from "../src/lib/switch-target.ts";

describe("modelTargetKey", () => {
  test("id 与框里的显示名归到同一个键", () => {
    expect(modelTargetKey("claude-sonnet-5")).toBe("sonnet 5");
    expect(modelTargetKey("Sonnet 5")).toBe("sonnet 5");
    expect(modelTargetKey("claude-haiku-4-5-20251001")).toBe("haiku 4.5");
    expect(modelTargetKey("Haiku 4.5")).toBe("haiku 4.5");
    expect(modelTargetKey("claude-fable-5-1")).toBe("fable 5.1");
    expect(modelTargetKey("Opus 5.5")).toBe("opus 5.5");
  });

  test("1M 上下文变体单独成键", () => {
    expect(modelTargetKey("claude-opus-4-6[1m]")).toBe("opus 4.6 1m");
    expect(modelTargetKey("Opus 4.6 (1M context)")).toBe("opus 4.6 1m");
    expect(modelTargetKey("Opus 4.6")).toBe("opus 4.6");
  });

  test("认不出的写法 → null", () => {
    for (const s of ["sonnet", "default", "opusplan", "my-proxy-model", "gpt-5", "Sonnet 5 (preview)", "claude-opus-4-6[fast]", ""]) {
      expect(modelTargetKey(s)).toBeNull();
    }
  });
});

describe("sameModelTarget", () => {
  test("同家族不同版本不算同一个", () => {
    expect(sameModelTarget("claude-sonnet-5", "Sonnet 4.6")).toBe(false);
    expect(sameModelTarget("claude-sonnet-4-6", "Sonnet 4.6")).toBe(true);
    expect(sameModelTarget("claude-opus-4-6", "Opus 4.6 (1M context)")).toBe(false);
    expect(sameModelTarget("claude-opus-4-6[1m]", "Opus 4.6 (1M context)")).toBe(true);
  });

  test("两边任一认不出 → 不算", () => {
    expect(sameModelTarget("my-proxy-model", "my-proxy-model")).toBe(false);
    expect(sameModelTarget("claude-sonnet-5", "Something new")).toBe(false);
  });
});
