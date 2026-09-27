/**
 * setup 向导「手机访问」一步（lib/setup-remote-access.ts）：中继默认、Tailscale 可选、只用局域网三选一，
 * 以及中继地址 / 名字的整形与装完后的连接判定。交互用脚本化的假终端跑，不碰网络。
 */
import { describe, expect, test } from "bun:test";
import {
  DEFAULT_RELAY_URL,
  chooseRemoteAccess,
  normalizeRelayUrl,
  predictRelayUrl,
  relayHttpsBase,
  relayLinkVerdict,
  relayNameError,
  type SetupUi,
} from "../src/lib/setup-remote-access.js";

const t = (zh: string) => zh;

/** 按顺序回答每个 prompt / confirm；记录打出的每一行 */
function fakeUi(answers: string[]) {
  const lines: string[] = [];
  const ui: SetupUi = {
    t,
    print: (s = "") => void lines.push(s),
    br: () => void lines.push(""),
    ok: (s) => void lines.push(`✓ ${s}`),
    warn: (s) => void lines.push(`⚠ ${s}`),
    hint: (s) => void lines.push(`  ${s}`),
    prompt: async (_label, def, validator) => {
      for (;;) {
        const a = answers.shift();
        if (a === undefined) throw new Error("prompt: 脚本答案用完了");
        const v = a || def || "";
        if (!validator || !validator(v)) return v;
        lines.push(`✗ ${validator(v)}`);
      }
    },
    confirm: async (_q, defaultYes = true) => {
      const a = answers.shift();
      if (a === undefined) throw new Error("confirm: 脚本答案用完了");
      return a === "" ? defaultYes : a === "y";
    },
    c: { bold: "", dim: "", cyan: "", reset: "" },
  };
  return { ui, lines, answers };
}

const up = async () => ({ ok: true as const, version: "2.28.0" });
const down = async () => ({ ok: false as const, detail: "ECONNREFUSED" });

describe("normalizeRelayUrl", () => {
  test("裸主机名补 wss://；https/http 换成 wss/ws；引号、查询串、末尾 / 去掉；反代子路径保留", () => {
    expect(normalizeRelayUrl("relay.example.com")).toBe("wss://relay.example.com");
    expect(normalizeRelayUrl("https://relay.example.com/")).toBe("wss://relay.example.com");
    expect(normalizeRelayUrl("http://localhost:8787")).toBe("ws://localhost:8787");
    expect(normalizeRelayUrl('"wss://relay.example.com"')).toBe("wss://relay.example.com");
    expect(normalizeRelayUrl(" wss://relay.example.com:8443/relay/?x=1 ")).toBe("wss://relay.example.com:8443/relay");
    expect(normalizeRelayUrl(DEFAULT_RELAY_URL)).toBe(DEFAULT_RELAY_URL);
  });

  test("不像地址的返回 null：空、带空格、别的协议", () => {
    expect(normalizeRelayUrl("")).toBeNull();
    expect(normalizeRelayUrl("relay example")).toBeNull();
    expect(normalizeRelayUrl("ftp://relay.example.com")).toBeNull();
    expect(normalizeRelayUrl("wss://")).toBeNull();
  });
});

describe("relayHttpsBase / predictRelayUrl / relayNameError", () => {
  test("wss → https、ws → http，端口跟着走；预测地址用 slugify 后的名字", () => {
    expect(relayHttpsBase("wss://relay.example.com")).toBe("https://relay.example.com");
    expect(relayHttpsBase("ws://localhost:8787")).toBe("http://localhost:8787");
    expect(predictRelayUrl("wss://relay.example.com", "mini")).toBe("https://mini.relay.example.com");
    expect(predictRelayUrl("wss://relay.example.com:8443", "Shawn's Mac")).toBe("https://shawn-s-mac.relay.example.com:8443");
  });

  test("名字校验：合法给 null，不合法附建议", () => {
    expect(relayNameError("mini", t)).toBeNull();
    expect(relayNameError("Mini", t)).toContain("mini");
    expect(relayNameError("-a-", t)).toContain("建议：a");
  });
});

describe("relayLinkVerdict（装完后 GET /relay/status 的解读）", () => {
  const base = { enabled: true, state: "online" as const, fp: "aaaa", slug: "mini", base: "relay.example.com", relayUrl: "wss://relay.example.com", retryAt: null, lastError: null };
  test("拿不到状态 → no-bridge；连上且地址如预期 → connected 不改名；被改名 → renamed", () => {
    expect(relayLinkVerdict(null, "https://mini.relay.example.com")).toEqual({ kind: "no-bridge" });
    const ok = relayLinkVerdict({ ...base, connected: true, url: "https://mini.relay.example.com" }, "https://mini.relay.example.com");
    expect(ok).toEqual({ kind: "connected", url: "https://mini.relay.example.com", renamed: false });
    const renamed = relayLinkVerdict({ ...base, connected: true, url: "https://mini-9109.relay.example.com" }, "https://mini.relay.example.com");
    expect(renamed).toMatchObject({ kind: "connected", renamed: true });
  });

  test("没连上 → waiting，带状态与原因", () => {
    const v = relayLinkVerdict({ ...base, connected: false, url: null, state: "offline", lastError: "socket error" }, "x");
    expect(v).toEqual({ kind: "waiting", why: "offline: socket error" });
  });
});

describe("chooseRemoteAccess（三选一）", () => {
  test("一路回车 = 中继 + 官方地址 + 主机名 slug；探测在线打版本；预测地址给出来", async () => {
    const { ui, lines } = fakeUi(["", "", ""]);
    const r = await chooseRemoteAccess(ui, { existing: {}, probe: up });
    expect(r.kind).toBe("relay");
    if (r.kind !== "relay") return;
    expect(r.relayUrl).toBe(DEFAULT_RELAY_URL);
    expect(r.relayName).toMatch(/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/);
    expect(r.url).toBe(predictRelayUrl(DEFAULT_RELAY_URL, r.relayName));
    expect(lines.join("\n")).toContain("v2.28.0");
  });

  test("续装：现有 RELAY_URL / RELAY_NAME 做默认；输入的地址与名字会被整形 / 校验", async () => {
    const { ui, lines } = fakeUi(["", "", "", "", "https://my.relay.test/", "Bad Name", "mini"]);
    const r = await chooseRemoteAccess(ui, { existing: { RELAY_URL: '"wss://old.relay.test"', RELAY_NAME: "old" }, probe: up });
    expect(r).toMatchObject({ kind: "relay", relayUrl: "wss://old.relay.test", relayName: "old" });
    const r2 = await chooseRemoteAccess(ui, { existing: {}, probe: up });
    expect(r2).toMatchObject({ kind: "relay", relayUrl: "wss://my.relay.test", relayName: "mini", url: "https://mini.my.relay.test" });
    expect(lines.join("\n")).toContain("建议：bad-name");
  });

  test("探测失败：默认 n 重输，y 则照写（bridge 会自己重试）", async () => {
    const { ui, lines } = fakeUi(["", "typo.relay.test", "", "good.relay.test", "", "mini"]);
    let calls = 0;
    const probe = async (u: string) => (calls++, u.includes("typo") ? down() : up());
    const r = await chooseRemoteAccess(ui, { existing: {}, probe });
    expect(r).toMatchObject({ kind: "relay", relayUrl: "wss://good.relay.test" });
    expect(calls).toBe(2);
    expect(lines.join("\n")).toContain("ECONNREFUSED");
    const keep = fakeUi(["", "typo.relay.test", "y", "mini"]);
    expect(await chooseRemoteAccess(keep.ui, { existing: {}, probe: down })).toMatchObject({ kind: "relay", relayUrl: "wss://typo.relay.test" });
  });

  test("选 2 只返回 Tailscale 意向；选 3 带回局域网地址", async () => {
    expect(await chooseRemoteAccess(fakeUi(["2"]).ui, { existing: {} })).toEqual({ kind: "tailscale", url: undefined });
    expect(await chooseRemoteAccess(fakeUi(["3"]).ui, { existing: {}, lanUrl: "http://192.168.1.2:3333" })).toEqual({ kind: "lan", url: "http://192.168.1.2:3333" });
    const bad = fakeUi(["9", "3"]);
    expect(await chooseRemoteAccess(bad.ui, { existing: {} })).toEqual({ kind: "lan", url: undefined });
    expect(bad.lines.join("\n")).toContain("输入 1、2 或 3");
  });

  test("原本配着中继却改选 2 / 3：问要不要停用，默认留着；答 y 才带 disableRelay", async () => {
    const existing = { RELAY_URL: "wss://relay.example.com" };
    expect(await chooseRemoteAccess(fakeUi(["2", ""]).ui, { existing })).toMatchObject({ kind: "tailscale", disableRelay: false });
    expect(await chooseRemoteAccess(fakeUi(["3", "y"]).ui, { existing })).toMatchObject({ kind: "lan", disableRelay: true });
    const asked = fakeUi(["2", "n"]);
    await chooseRemoteAccess(asked.ui, { existing });
    expect(asked.answers).toHaveLength(0); // 确实问了
    expect((await chooseRemoteAccess(fakeUi(["2"]).ui, { existing: {} })).kind).toBe("tailscale"); // 没配过中继就不问
  });
});
