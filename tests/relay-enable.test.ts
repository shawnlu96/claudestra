/** Peer 面板「一键接入中继」（bridge/relay-link.ts enableRelay）：写 .env 的 RELAY_URL 后当场连；已配 / 沙箱 / 地址不对都不写 */
import { describe, expect, test } from "bun:test";
import { enableRelay } from "../src/bridge/relay-link.js";
import { DEFAULT_RELAY_URL } from "../src/lib/setup-remote-access.js";

function deps(over: { current?: string; sandbox?: string | null } = {}) {
  const writes: Record<string, string>[] = [];
  let started = 0;
  return {
    writes, started: () => started,
    d: {
      current: () => over.current ?? "",
      write: async (u: Record<string, string>) => void writes.push(u),
      start: async () => void started++,
      sandbox: () => over.sandbox ?? null,
    },
  };
}

describe("enableRelay", () => {
  test("不给地址 = 官方中继：写进 .env 后当场连", async () => {
    const h = deps();
    expect(await enableRelay(undefined, h.d)).toEqual({ ok: true, relayUrl: DEFAULT_RELAY_URL });
    expect(h.writes).toEqual([{ RELAY_URL: DEFAULT_RELAY_URL }]);
    expect(h.started()).toBe(1);
  });
  test("给了地址按 setup 的规矩规整（裸主机名补 wss://）", async () => {
    const h = deps();
    expect(await enableRelay("relay.example.com/", h.d)).toEqual({ ok: true, relayUrl: "wss://relay.example.com" });
  });
  test("已经配了、沙箱、地址不对：不写不连", async () => {
    for (const [h, arg, status] of [[deps({ current: "wss://x" }), undefined, 409], [deps({ sandbox: "沙箱" }), undefined, 409], [deps(), "not a url", 400]] as const) {
      expect(await enableRelay(arg, h.d)).toMatchObject({ ok: false, status });
      expect(h.writes).toEqual([]);
      expect(h.started()).toBe(0);
    }
  });
});
