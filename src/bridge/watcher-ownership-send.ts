/**
 * 观察器往频道发东西的出口带停止令牌：channels.fetch 等发送准备的 await 回来、以及每次真正 send 前都核观察器仍有效，
 * 已被停 / 换代的旧调用抛 RetiredSend（调用方原本就吞发送错误），不把旧会话正文发出去。只包 discordReply 用到的那两步。
 */
import type { Client } from "discord.js";

class RetiredSend extends Error {
  constructor() { super("watcher retired before send"); }
}

export function liveDiscord(discord: Client, alive: () => boolean): Client {
  const check = () => { if (!alive()) throw new RetiredSend(); };
  const guard = (ch: object) => new Proxy(ch, {
    get(t, p) {
      const v = Reflect.get(t, p);
      if (p === "send" && typeof v === "function") return async (...a: unknown[]) => { check(); return v.apply(t, a); };
      return typeof v === "function" ? v.bind(t) : v;
    },
  });
  const fetch = async (...a: Parameters<Client["channels"]["fetch"]>) => {
    const ch = await discord.channels.fetch(...a);
    check();
    return ch && guard(ch);
  };
  return { channels: { fetch } } as unknown as Client;
}
