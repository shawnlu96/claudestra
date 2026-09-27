/** web/lib/app-config.ts isLegacySubdomain：认出已废弃的子域名入口 <slug>.<中继>；中继主机本身、别的域名、没报 relayBase 都不算 */
import { describe, expect, test } from "bun:test";
import { isLegacySubdomain, parseAppConfig } from "@/lib/app-config";

describe("isLegacySubdomain", () => {
  test("<slug>.<中继> 算；中继本身 / 别的域名 / 本机地址 / 没有 relayBase 不算；大小写不敏感", () => {
    expect(isLegacySubdomain("mini.relay.sunstriker.cc", "relay.sunstriker.cc")).toBe(true);
    expect(isLegacySubdomain("MINI.Relay.Sunstriker.cc", "relay.sunstriker.cc")).toBe(true);
    expect(isLegacySubdomain("relay.sunstriker.cc", "relay.sunstriker.cc")).toBe(false);
    expect(isLegacySubdomain("claude.sunstriker.cc", "relay.sunstriker.cc")).toBe(false);
    expect(isLegacySubdomain("evilrelay.sunstriker.cc", "relay.sunstriker.cc")).toBe(false);
    expect(isLegacySubdomain("127.0.0.1", "relay.sunstriker.cc")).toBe(false);
    expect(isLegacySubdomain("mini.relay.sunstriker.cc", undefined)).toBe(false);
  });
  test("直托管的 app-config 带 relayBase 时解析出来，没有就不带", () => {
    const fb = { mode: "direct" as const, fp: "local", machineName: "x", version: "" };
    expect(parseAppConfig({ mode: "direct", fp: "aa", machineName: "mini", relayBase: "relay.test" }, fb)).toMatchObject({ relayBase: "relay.test" });
    expect(parseAppConfig({ mode: "direct", fp: "aa", machineName: "mini" }, fb)).not.toHaveProperty("relayBase");
  });
});
