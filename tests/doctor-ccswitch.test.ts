/** lib/doctor-ccswitch.ts：API 源、终端环境变量覆盖、CC Switch 冲掉 hooks 的判定（台账 i02 A0） */
import { describe, expect, test } from "bun:test";
import { ccSwitchChecks } from "../src/lib/doctor-ccswitch.js";

const HOOKED = { hooks: { Stop: [{ hooks: [{ type: "command", command: "bun /x/src/hooks/typing-hook.ts" }] }] } };

describe("ccSwitchChecks", () => {
  test("官方源、没装 CC Switch、终端干净：只有一项 ok", () => {
    const r = ccSwitchChecks({ ccSwitchInstalled: false, settings: HOOKED, env: {} });
    expect(r.map((c) => [c.name, c.status])).toEqual([["Claude Code 的 API 源", "ok"]]);
    expect(r[0].detail).toContain("官方");
  });
  test("第三方源只报主机名，不带路径和密钥", () => {
    const r = ccSwitchChecks({ ccSwitchInstalled: false, settings: { env: { ANTHROPIC_BASE_URL: "https://api.kimi.com/coding/v1", ANTHROPIC_AUTH_TOKEN: "sk-secret" } }, env: {} });
    expect(r[0].detail).toContain("api.kimi.com");
    expect(JSON.stringify(r)).not.toContain("sk-secret");
    expect(JSON.stringify(r)).not.toContain("/coding/v1");
  });
  test("终端里的 ANTHROPIC_* 会盖过 settings：warn，只报变量名不报值", () => {
    const r = ccSwitchChecks({ ccSwitchInstalled: false, settings: HOOKED, env: { ANTHROPIC_API_KEY: "sk-live-xyz" } });
    const w = r.find((c) => c.name === "终端环境变量")!;
    expect(w.status).toBe("warn");
    expect(w.detail).toContain("ANTHROPIC_API_KEY");
    expect(JSON.stringify(r)).not.toContain("sk-live-xyz");
  });
  test("装了 CC Switch：hooks 在 ok，被冲掉 warn（带修法）", () => {
    expect(ccSwitchChecks({ ccSwitchInstalled: true, settings: HOOKED, env: {} }).find((c) => c.name === "CC Switch")!.status).toBe("ok");
    const lost = ccSwitchChecks({ ccSwitchInstalled: true, settings: { env: {} }, env: {} }).find((c) => c.name === "CC Switch")!;
    expect(lost.status).toBe("warn");
    expect(lost.fix).toContain("install-hooks");
  });
});
