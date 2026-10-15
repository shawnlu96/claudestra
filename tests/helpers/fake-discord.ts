// 本机假 Discord：REST /gateway/bot + gateway ws（HELLO / IDENTIFY→READY / 心跳 ACK；RESUME 一律 INVALID_SESSION 逼重新 identify）。
// 其余 REST 路由回 404 —— 用来验证 ready 之后的 Discord 侧初始化失败时 bridge 也只记日志不退出。
// 用法：tests/discord-login-gateway.test.ts；沙箱桩模式（bridge/config.ts）手动起：
// bun -e 'import("./tests/helpers/fake-discord.ts").then((m) => m.startFakeDiscord(23990, console.log))'

export interface FakeDiscord {
  server: ReturnType<typeof Bun.serve>; identifies: () => number; restHits: () => string[];
  /** 收到的 RESUME（op 6）次数 */
  resumes: () => number;
  /** 断网模拟：true = 新 ws 升级一律 503 并掐掉现有连接（REST 照常，配合 resetAfter 缓存 gateway 信息） */
  setDown: (down: boolean) => void;
  /** 此刻已 IDENTIFY 且没断的网关会话数 */
  sessions: () => number;
  /** 像 Discord 一样把同一次按钮点击推给本 bot 的每个会话 */
  clickButton: (id: string) => void;
  /** 用指定 close code 掐掉已 IDENTIFY 的会话（4000 = discord.js 走 RESUME 恢复） */
  kick: (code: number) => void;
}

export interface FakeDiscordOptions {
  /** READY 里下发的 resume_gateway_url，缺省指回自己；测试用来模拟恶意异源恢复地址 */
  resumeUrl?: string;
}

type Conn = { close(code?: number, reason?: string): void; send(m: string): unknown };

/** resetAfterMs：/gateway/bot 的 session_start_limit.reset_after —— 真 Discord 是小时级，discord.js 按它缓存 gateway 信息 */
export function startFakeDiscord(port: number, log: (m: string) => void = () => {}, resetAfterMs = 0, opts: FakeDiscordOptions = {}): FakeDiscord {
  let identifies = 0;
  let resumes = 0;
  let down = false;
  const hits: string[] = [];
  const live = new Set<Conn>();
  const identified = new Set<Conn>();
  const server = Bun.serve({
    port, hostname: "127.0.0.1",
    fetch(req, srv) {
      const url = new URL(req.url);
      if (req.headers.get("upgrade") === "websocket") {
        if (down) return new Response("down", { status: 503 });
        if (srv.upgrade(req)) return undefined;
      }
      hits.push(`${req.method} ${url.pathname}`);
      if (url.pathname.endsWith("/gateway/bot")) {
        return Response.json({
          url: `ws://127.0.0.1:${port}`, shards: 1,
          session_start_limit: { total: 1000, remaining: 1000, reset_after: resetAfterMs, max_concurrency: 1 },
        });
      }
      if (req.method === "PUT" && /\/applications\/\d+(\/guilds\/\d+)?\/commands$/.test(url.pathname)) {
        log(`REST PUT ${url.pathname} → 200（slash 注册打到了桩）`);
        return Response.json([]);
      }
      log(`REST ${req.method} ${url.pathname} → 404`);
      return Response.json({ message: "Unknown (fake discord)", code: 0 }, { status: 404 });
    },
    websocket: {
      open(ws) { live.add(ws); ws.send(JSON.stringify({ op: 10, d: { heartbeat_interval: 45_000 } })); },
      close(ws) { live.delete(ws); identified.delete(ws); },
      message(ws, raw) {
        const p = JSON.parse(String(raw)) as { op: number };
        if (p.op === 1) ws.send(JSON.stringify({ op: 11 }));
        if (p.op === 6 && ++resumes) ws.send(JSON.stringify({ op: 9, d: false }));
        if (p.op !== 2) return;
        identifies++;
        identified.add(ws);
        log(`gateway IDENTIFY #${identifies} → READY`);
        ws.send(JSON.stringify({ op: 0, s: 1, t: "READY", d: {
          v: 10, user: { id: "100", username: "stub", discriminator: "0", bot: true }, guilds: [],
          session_id: `s${identifies}`, resume_gateway_url: opts.resumeUrl ?? `ws://127.0.0.1:${port}`, application: { id: "100", flags: 0 },
        } }));
      },
    },
  });
  const clickButton = (id: string) => {
    const at = new Date().toISOString();
    const user = { id: "400", username: "owner", discriminator: "0" };
    const message = { id: "1300000000000000099", channel_id: "300", author: { ...user, id: "100", bot: true }, content: "x", timestamp: at, edited_timestamp: null,
      tts: false, mention_everyone: false, mentions: [], mention_roles: [], attachments: [], embeds: [], pinned: false, type: 0, components: [] };
    const d = { id, application_id: "100", type: 3, token: "tok", version: 1, channel_id: "300", channel: { id: "300", type: 1 }, user,
      data: { custom_id: "probe_btn", component_type: 2 }, message, locale: "en-US", app_permissions: "0", entitlements: [], authorizing_integration_owners: {}, context: 0 };
    for (const ws of identified) ws.send(JSON.stringify({ op: 0, s: 2, t: "INTERACTION_CREATE", d }));
  };
  return {
    server, identifies: () => identifies, resumes: () => resumes, restHits: () => hits, sessions: () => identified.size, clickButton,
    kick(code) { for (const ws of identified) ws.close(code, "kick"); },
    setDown(v) { down = v; if (v) for (const ws of live) ws.close(1001, "down"); },
  };
}

