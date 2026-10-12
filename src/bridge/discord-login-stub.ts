// 沙箱 Discord 桩（CLAUDESTRA_SANDBOX=1 + CLAUDESTRA_SANDBOX_DISCORD_STUB=1）的 REST 目标核对。
// discord.js 在 bridge 装出站闸之前就抓住了 fetch / undici，它的请求沙箱闸拦不到 —— 所以目标只能在建 client 前由这里放行：
// 只认本沙箱自己端口段里的固定一位（BRIDGE_PORT + 10）、回环 http、不在生产端口（默认 + CLAUDESTRA_SANDBOX_DENY_PORTS）里，否则抛错不启动。
// 测试：tests/discord-login-stub.test.ts
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
