import { describe, expect, test } from "bun:test";
import { hashCred, type CredRecord } from "../src/lib/caller-cred.ts";
import { IDENTITY_UNVERIFIED, rejectsTakeover, requireVerified, resolveCallerIdentity } from "../src/lib/caller-identity.ts";
import { callerRegisterFields } from "../src/lib/whoami-tool.ts";

const TA = "a".repeat(64);
const TB = "b".repeat(64);
const creds: Record<string, CredRecord> = {
  [hashCred(TA)]: { agent: "agent-a", family: "claude-code", sessionId: "launch-a", issuedAt: "t" },
  [hashCred(TB)]: { agent: "agent-b", family: "codex", issuedAt: "t" },
  [hashCred("c".repeat(64))]: { agent: "master", family: "claude-code", sessionId: "m1", issuedAt: "t" },
};
const agents = [
  { name: "agent-a", channelId: "ch-a", sessionId: "now-a" },
  { name: "agent-b", channelId: "ch-b", sessionId: "now-b", runtime: "codex" },
];
const deps = { creds, agents, controlChannelId: "ctl" };

describe("resolveCallerIdentity", () => {
  test("有效凭据 + 签给的正是频道主人 → verified；会话 / 家族取 registry 当前值", () => {
    expect(resolveCallerIdentity({ credHash: hashCred(TA), channelId: "ch-a" }, deps)).toEqual({ agent: "agent-a", sessionId: "now-a", family: "claude-code", verified: true });
    expect(resolveCallerIdentity({ credHash: hashCred(TB), channelId: "ch-b" }, deps)).toEqual({ agent: "agent-b", sessionId: "now-b", family: "codex", verified: true });
  });

  test("没有凭据 → 照样认出是谁，但 verified=false", () => {
    expect(resolveCallerIdentity({ channelId: "ch-a" }, deps)).toEqual({ agent: "agent-a", sessionId: "now-a", family: "claude-code", verified: false });
  });

  test("拿 A 的凭据注册 B 的频道 → 不算数（串卡）", () => {
    expect(resolveCallerIdentity({ credHash: hashCred(TA), channelId: "ch-b" }, deps)).toMatchObject({ agent: "agent-b", verified: false });
  });

  test("凭据已被同 agent 的新凭据顶掉（存储里没了）→ false", () => {
    expect(resolveCallerIdentity({ credHash: hashCred("d".repeat(64)), channelId: "ch-a" }, deps).verified).toBe(false);
  });

  test("回环代理降级过的帧 → false", () => {
    expect(resolveCallerIdentity({ credHash: hashCred(TB), channelId: "ch-b", downgraded: true }, deps).verified).toBe(false);
  });

  test("未注册 / 不认识的频道 → agent=null", () => {
    expect(resolveCallerIdentity({ credHash: hashCred(TA) }, deps)).toEqual({ agent: null, sessionId: null, family: null, verified: false });
    expect(resolveCallerIdentity({ channelId: "ch-x" }, deps)).toEqual({ agent: null, sessionId: null, family: null, verified: false });
  });

  test("控制频道 = master", () => {
    expect(resolveCallerIdentity({ credHash: hashCred("c".repeat(64)), channelId: "ctl" }, deps)).toEqual({ agent: "master", sessionId: "m1", family: "claude-code", verified: true });
    expect(resolveCallerIdentity({ credHash: hashCred(TA), channelId: "ctl" }, deps).verified).toBe(false);
  });

  test("master 的会话取 bridge 按 MASTER_DIR 给的当前值（新建时签发记录里没有、/clear 后会换）；未验证不取", () => {
    const master = hashCred("c".repeat(64));
    const fresh = { ...deps, creds: { [master]: { agent: "master", family: "claude-code", issuedAt: "t" } } };
    expect(resolveCallerIdentity({ credHash: master, channelId: "ctl" }, { ...fresh, masterSessionId: () => "m-now" })).toMatchObject({ sessionId: "m-now", verified: true });
    expect(resolveCallerIdentity({ credHash: master, channelId: "ctl" }, { ...deps, masterSessionId: () => "m-after-clear" }).sessionId).toBe("m-after-clear");
    expect(resolveCallerIdentity({ credHash: master, channelId: "ctl" }, { ...deps, masterSessionId: () => undefined }).sessionId).toBe("m1");
    let asked = false;
    expect(resolveCallerIdentity({ channelId: "ctl" }, { ...deps, masterSessionId: () => ((asked = true), "x") }).sessionId).toBeNull();
    expect(asked).toBe(false);
  });
});

describe("顶替与工具闸", () => {
  const v = resolveCallerIdentity({ credHash: hashCred(TA), channelId: "ch-a" }, deps);
  const u = resolveCallerIdentity({ channelId: "ch-a" }, deps);
  test("只拒「无凭据的来顶替仍有效的已验证持有者」", () => {
    expect(rejectsTakeover(v, u)).toBe(true);
    expect(rejectsTakeover(v, v)).toBe(false); // /mcp 重连：同一份凭据
    expect(rejectsTakeover(u, u)).toBe(false); // 兼容期：大家都没凭据
    expect(rejectsTakeover(u, v)).toBe(false);
    expect(rejectsTakeover(null, u)).toBe(false);
  });
  test("requireVerified：未验证一律 identity_unverified", () => {
    expect(requireVerified(v)).toEqual({ ok: true, identity: v });
    expect(requireVerified(u)).toEqual({ ok: false, error: IDENTITY_UNVERIFIED, identity: u });
  });
});

describe("channel-server 的 register 字段", () => {
  test("有凭据才带；Codex 模式下环境里有适配器专属变量 = shell 起的，自报出来", () => {
    expect(callerRegisterFields(undefined, {})).toEqual({});
    expect(callerRegisterFields(TA, {})).toEqual({ callerCred: TA });
    expect(callerRegisterFields(undefined, { CLAUDESTRA_RUNTIME: "codex", APP_SERVER_LOGS: "/x" })).toEqual({ outsideMcpLauncher: true });
    expect(callerRegisterFields(undefined, { CLAUDESTRA_RUNTIME: "codex" })).toEqual({});
    expect(callerRegisterFields(undefined, { APP_SERVER_LOGS: "/x" })).toEqual({});
  });
});
