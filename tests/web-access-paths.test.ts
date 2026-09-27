/** web/features/chat/access-paths-logic.ts：「访问」页四条路的开关判定 */
import { describe, expect, test } from "bun:test";
import { accessRows, type AccessPathsInfo, type EntriesView } from "@/features/chat/access-paths-logic";

const A: AccessPathsInfo = {
  relay: { enabled: true, connected: true, state: "online", home: "https://relay.example.com" },
  lan: { bind: "127.0.0.1", bindAll: false, urls: ["http://192.168.1.5:3847"] },
};
const ok = { secure: true, reachable: true, matchesLocal: true };
const SNAP: EntriesView = {
  tailscale: { installed: true, running: true },
  entries: [
    { url: "https://mini.tail1.ts.net", source: "serve", ...ok },
    { url: "http://100.1.2.3:3847", source: "tailnet-ip", secure: false, reachable: false, matchesLocal: false },
  ],
};

describe("accessRows", () => {
  test("中继在线报首页；Tailscale 有 HTTPS 入口；只听回环时局域网关着；没有别的域名", () => {
    const rows = accessRows(A, SNAP);
    expect(rows.map((r) => `${r.id}:${r.state}`)).toEqual(["relay:on", "tailscale:on", "lan:off", "domain:off"]);
    expect(rows[0].url).toBe("https://relay.example.com");
    expect(rows[1].url).toBe("https://mini.tail1.ts.net");
    expect(rows[2].note).toContain("BRIDGE_BIND=0.0.0.0");
  });

  test("自己的域名：能用的 HTTPS 入口且不是 ts.net；打不开或指到别处的不算", () => {
    const snap: EntriesView = { ...SNAP, entries: [...SNAP.entries, { url: "https://claw.example.org", source: "external", ...ok }, { url: "https://dead.example.org", source: "external", ...ok, reachable: false }] };
    expect(accessRows(A, snap).find((r) => r.id === "domain")).toMatchObject({ state: "on", url: "https://claw.example.org" });
  });

  test("中继没配 / 没连上；Tailscale 连着没入口 / 没装；局域网开着报第一个地址；数据没到的那半不出行", () => {
    const a: AccessPathsInfo = { relay: { enabled: true, connected: false, state: "offline", home: null }, lan: { bind: "0.0.0.0", bindAll: true, urls: ["http://192.168.1.5:3847"] } };
    const rows = accessRows(a, { tailscale: { installed: true, running: true }, entries: [] });
    expect(rows.map((r) => `${r.id}:${r.state}`)).toEqual(["relay:partial", "tailscale:partial", "lan:on", "domain:off"]);
    expect(rows.find((r) => r.id === "lan")!.url).toBe("http://192.168.1.5:3847");
    expect(accessRows({ ...a, relay: { ...a.relay, enabled: false } }, null).map((r) => r.id)).toEqual(["relay", "lan"]);
    expect(accessRows(null, { tailscale: { installed: false, running: false }, entries: [] })[0]).toMatchObject({ id: "tailscale", state: "off" });
  });
});
