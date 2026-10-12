// 沙箱 Discord 桩（CLAUDESTRA_SANDBOX=1 + CLAUDESTRA_SANDBOX_DISCORD_STUB=1）的 REST 目标核对。
// discord.js 在 bridge 装出站闸之前就抓住了 fetch / undici，它的请求沙箱闸拦不到 —— 所以目标只能在建 client 前由这里放行：
// 只认本沙箱自己端口段里的固定一位（BRIDGE_PORT + 10）、回环 http、不在生产端口（默认 + CLAUDESTRA_SANDBOX_DENY_PORTS）里，否则抛错不启动。
// 测试：tests/discord-login-stub.test.ts
import { DefaultRestOptions, type RESTOptions } from "discord.js";

type Env = Record<string, string | undefined>;
const DISCORD_STUB_PORT_OFFSET = 10;
const LOOPBACK = ["127.0.0.1", "localhost", "[::1]"];

export function sandboxDiscordStubApi(env: Env, defaultPort: number): string | undefined {
  if (env.CLAUDESTRA_SANDBOX !== "1" || env.CLAUDESTRA_SANDBOX_DISCORD_STUB !== "1") return undefined;
  const raw = env.CLAUDESTRA_SANDBOX_DISCORD_API;
  const want = Number(env.BRIDGE_PORT) + DISCORD_STUB_PORT_OFFSET;
  const deny = [defaultPort, ...(env.CLAUDESTRA_SANDBOX_DENY_PORTS || "").split(",").map((s) => Number(s.trim())).filter((n) => n > 0)];
  let u: URL | null = null;
  try { u = new URL(raw || ""); } catch { /* 下面按「不合法」报错，带上原值 */ }
  const port = u ? Number(u.port || 80) : NaN;
  const problem = !u ? "不是合法 URL"
    : u.protocol !== "http:" || !LOOPBACK.includes(u.hostname) ? "必须是回环 http 地址"
    : !Number.isInteger(want) || port !== want ? `端口必须是本沙箱的桩端口 BRIDGE_PORT+${DISCORD_STUB_PORT_OFFSET}=${want}`
    : deny.includes(port) ? `端口 ${port} 在生产端口清单里`
    : null;
  if (problem) throw new Error(`CLAUDESTRA_SANDBOX_DISCORD_API ${problem}，拒绝启动（收到 ${raw ?? "(空)"}）`);
  return u!.href.replace(/\/$/, "");
}

type MakeRequest = RESTOptions["makeRequest"];

/**
 * 桩模式的 discord.js REST 选项。只核对初始地址不够：REST 默认跟随重定向，假 Discord 回个 307 就能把请求带到别的端口；
 * /gateway/bot 回的 gateway 地址也由它说了算。所以每个请求都要求与桩同源、不跟随重定向（3xx 直接拒），gateway 地址也必须指回桩。
 * base 缺省是 discord.js 自己的默认策略（装闸前就抓住的 fetch）。
 */
export function stubRestOptions(api: string, base: MakeRequest = DefaultRestOptions.makeRequest): Partial<RESTOptions> {
  const stub = new URL(api);
  const refuse = (what: string): never => { throw new Error(`沙箱 Discord 桩：拒绝${what}（只认 ${stub.host}）`); };
  const makeRequest: MakeRequest = async (url, init) => {
    if (new URL(url).origin !== stub.origin) refuse(` REST 发往 ${url}`);
    const res = (await base(url, { ...init, redirect: "manual" })) as unknown as Response; // Bun 下默认策略就是 fetch
    if (res.status >= 300 && res.status < 400) refuse(`跟随重定向到 ${res.headers.get("location") ?? "?"}`);
    if (new URL(url).pathname.endsWith("/gateway/bot")) {
      const gw = new URL(String(((await res.clone().json()) as { url?: unknown }).url ?? ""), "ws://invalid");
      if (gw.protocol !== "ws:" || gw.host !== stub.host) refuse(`连 gateway ${gw.href}`);
    }
    return res as unknown as Awaited<ReturnType<MakeRequest>>;
  };
  return { api, makeRequest };
}
