/** lib/doctor-ccswitch.ts：终端环境变量覆盖、CC Switch 冲掉 hooks 的判定（台账 i02 A0） */
import { describe, expect, test } from "bun:test";
import { ccSwitchChecks } from "../src/lib/doctor-ccswitch.js";

const HOOKED = { hooks: { Stop: [{ hooks: [{ type: "command", command: "bun /x/src/hooks/typing-hook.ts" }] }] } };

describe("ccSwitchChecks", () => {
  test("没装 CC Switch、终端干净：本分区一项都不出（Claude 的源由 AI 能力清单那一行报，不重复）", () => {
    expect(ccSwitchChecks({ ccSwitchInstalled: false, settings: HOOKED, env: {} })).toEqual([]);
    const r = ccSwitchChecks({ ccSwitchInstalled: true, settings: { ...HOOKED, env: { ANTHROPIC_BASE_URL: "https://api.kimi.com/coding/v1", ANTHROPIC_AUTH_TOKEN: "sk-secret" } }, env: {} });
    expect(r.map((c) => c.name)).toEqual(["CC Switch"]);
    expect(JSON.stringify(r)).not.toContain("sk-secret");
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
