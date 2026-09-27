import { describe, expect, test } from "bun:test";
import { relayHomeCookie } from "@/lib/relay-home-cookie";

const h = (o: Record<string, string>) => ({ get: (k: string) => o[k.toLowerCase()] ?? null });

describe("relayHomeCookie：只有经中继进来的登录才记 cstra_home", () => {
  test("bridge 隧道盖了 base 头且 Host 是 <slug>.<base> → 父域 Lax cookie，值只含 slug", () => {
    const c = relayHomeCookie(h({ "x-claudestra-relay-base": "relay.example.com", "x-forwarded-host": "mini.relay.example.com" }));
    expect(c).toMatchObject({ name: "cstra_home", value: "mini", domain: "relay.example.com", sameSite: "lax", secure: true, httpOnly: true, path: "/" });
    expect(c!.maxAge).toBe(365 * 24 * 3600);
  });
  test("没有 base 头（直连 / Tailscale / 本机）→ null", () => {
    expect(relayHomeCookie(h({ host: "mini.relay.example.com" }))).toBeNull();
    expect(relayHomeCookie(h({ "x-claudestra-relay-base": "relay.example.com", host: "127.0.0.1:3333" }))).toBeNull();
  });
  test("客户端伪造 base 头但 Host 不在该域下 → null；slug 形状不对 → null", () => {
    expect(relayHomeCookie(h({ "x-claudestra-relay-base": "evil.example", host: "mini.relay.example.com" }))).toBeNull();
    expect(relayHomeCookie(h({ "x-claudestra-relay-base": "relay.example.com", host: "Bad_Slug.relay.example.com" }))).toBeNull();
  });
  test("Host 带端口、大小写混杂也认", () => {
    expect(relayHomeCookie(h({ "x-claudestra-relay-base": "Relay.Example.com", host: "Mini.relay.example.com:443" }))?.value).toBe("mini");
  });
});
