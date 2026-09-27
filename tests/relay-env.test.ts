/** 中继运行配置（src/relay/env.ts）：RELAY_BASE 校验、默认值、commit 号的两个来源 */
import { describe, expect, test } from "bun:test";
import { commitFromFile, relayEnv } from "../src/relay/env.ts";

describe("relayEnv", () => {
  test("RELAY_BASE 必填且得是主机名；默认端口 / 回环 / 数据库路径", () => {
    expect(() => relayEnv({}, () => undefined)).toThrow(/RELAY_BASE/);
    expect(() => relayEnv({ RELAY_BASE: "not a host" }, () => undefined)).toThrow(/RELAY_BASE/);
    const e = relayEnv({ RELAY_BASE: "Relay.Example.com." }, () => undefined);
    expect(e).toMatchObject({ base: "relay.example.com", port: 8787, hostname: "127.0.0.1", db: "data/relay.sqlite", trustProxy: false });
    expect(e.commit).toBeUndefined();
  });
  test("RELAY_DATA / RELAY_DB / RELAY_TRUST_PROXY / RELAY_PORT", () => {
    expect(relayEnv({ RELAY_BASE: "r.test", RELAY_DATA: "/var/lib/x/" }, () => undefined).db).toBe("/var/lib/x/relay.sqlite");
    expect(relayEnv({ RELAY_BASE: "r.test", RELAY_DB: "/tmp/a.sqlite", RELAY_DATA: "/x" }, () => undefined).db).toBe("/tmp/a.sqlite");
    expect(relayEnv({ RELAY_BASE: "r.test", RELAY_TRUST_PROXY: "1", RELAY_PORT: "9000" }, () => undefined)).toMatchObject({ trustProxy: true, port: 9000 });
  });
  test("推送网关：VAPID 文件默认在数据目录、subject 默认 mailto:relay@<base>；APNs 三项不全就不开并说明原因", () => {
    const e = relayEnv({ RELAY_BASE: "r.test" }, () => undefined);
    expect(e).toMatchObject({ vapidKeysPath: "data/vapid.json", vapidSubject: "mailto:relay@r.test" });
    expect(e.apns).toBeUndefined();
    expect(e.apnsWhy).toContain("AuthKey");
    const custom = relayEnv({ RELAY_BASE: "r.test", RELAY_DATA: "/var/lib/x/", RELAY_VAPID_SUBJECT: " https://relay.example " }, () => undefined);
    expect(custom).toMatchObject({ vapidKeysPath: "/var/lib/x/vapid.json", vapidSubject: "https://relay.example" });
    expect(relayEnv({ RELAY_BASE: "r.test", RELAY_VAPID_KEYS: "/etc/relay/vapid.json" }, () => undefined).vapidKeysPath).toBe("/etc/relay/vapid.json");
    expect(relayEnv({ RELAY_BASE: "r.test", RELAY_APNS_KEY_PATH: "/nonexistent/AuthKey_X.p8", RELAY_APNS_TEAM_ID: "T" }, () => undefined).apnsWhy).toContain("AuthKey");
  });
  test("commit：环境变量优先，其次 .relay-commit 文件；文件内容不像 sha 就当没有", () => {
    expect(relayEnv({ RELAY_BASE: "r.test", RELAY_COMMIT: " abc1234 " }, () => "ffffff1").commit).toBe("abc1234");
    expect(relayEnv({ RELAY_BASE: "r.test" }, () => "ffffff1").commit).toBe("ffffff1");
    expect(commitFromFile(() => "1E6B7E8\n")).toBe("1e6b7e8");
    expect(commitFromFile(() => "not a sha")).toBeUndefined();
    expect(commitFromFile(() => { throw new Error("ENOENT"); })).toBeUndefined();
  });
});
