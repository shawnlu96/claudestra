// Discord 连接生命周期：登录失败分类 + 退避重试 + gateway 看门狗。
// 约束：Discord 连不上时 bridge 进程绝不退出 —— web / 中继 / agent 间消息 / 巡检都在同一进程里，
// 退出 = 全部陪葬（launchd 每分钟拉起一次，ready 之后的启动步骤一个都跑不到）。
// 重连是再调一次 client.login()；旧 shard 能被真正销毁靠 discord-login-shards.ts 的 strategy，接线时两者缺一不可。
// 测试：tests/discord-login.test.ts

type LoginFailureKind = "token" | "intents" | "network" | "tls" | "unknown";
export interface LoginFailure {
  kind: LoginFailureKind;
  /** 不可恢复：重试也不会好（token / intent 要人去改配置），按上限间隔重试并持续醒目告警 */
  fatal: boolean;
  detail: string;
}

const LOGIN_BACKOFF_BASE_MS = 5_000;
export const LOGIN_BACKOFF_MAX_MS = 5 * 60_000;
/** login() 本身可能永远不 settle（gateway 握手被黑洞、4014 这类不可恢复关闭只关 shard 不 reject） */
export const LOGIN_TIMEOUT_MS = 3 * 60_000;

const NETWORK_CODES = new Set([
  "ConnectionRefused", "ConnectionClosed", "FailedToOpenSocket", "ECONNREFUSED", "ECONNRESET", "ENOTFOUND", "EAI_AGAIN",
  "ETIMEDOUT", "ENETUNREACH", "EHOSTUNREACH", "ENETDOWN", "EHOSTDOWN", "EPIPE", "ECONNABORTED",
]);
const TLS_CODE_RE = /CERT|TLS|SSL|SELF_SIGNED|UNABLE_TO_VERIFY|UNABLE_TO_GET_ISSUER/i;

interface ErrLike { name?: unknown; code?: unknown; status?: unknown; message?: unknown; cause?: unknown }

/** 沿 cause 链收集 name/code/status/message —— Bun fetch 与 discord.js 各包一层，真原因常在里层 */
function errorChain(e: unknown): ErrLike[] {
  const out: ErrLike[] = [];
  let cur: unknown = e;
  while (cur && typeof cur === "object" && out.length < 6) {
    out.push(cur as ErrLike);
    cur = (cur as ErrLike).cause;
  }
  if (!out.length) out.push({ message: String(e) });
  return out;
}

export function classifyLoginError(e: unknown): LoginFailure {
  const chain = errorChain(e);
  const codes = chain.map((x) => String(x.code ?? ""));
  const text = chain.map((x) => `${String(x.name ?? "")} ${String(x.message ?? "")}`).join(" | ");
  const detail = `${codes.filter(Boolean).join("/") || "-"}: ${text.trim()}`.slice(0, 300);
  if (codes.includes("TokenInvalid") || chain.some((x) => x.status === 401) || /authentication failed|invalid token/i.test(text)) {
    return { kind: "token", fatal: true, detail };
  }
  if (codes.some((c) => /^(DisallowedIntents|InvalidIntents)$/.test(c)) || /(disallowed|invalid) intents/i.test(text)) {
    return { kind: "intents", fatal: true, detail };
  }
  if (codes.some((c) => TLS_CODE_RE.test(c)) || /certificate|\btls\b|\bssl\b/i.test(text)) return { kind: "tls", fatal: false, detail };
  const network = codes.some((c) => NETWORK_CODES.has(c) || c.startsWith("UND_ERR_") || c === "20")
    || chain.some((x) => x.name === "AbortError" || x.name === "TimeoutError")
    || /unable to connect|fetch failed|timed out|socket|network/i.test(text);
  if (network) return { kind: "network", fatal: false, detail };
  return { kind: "unknown", fatal: false, detail };
}

/** gateway 不可恢复关闭码（discord.js UNRECOVERABLE_CLOSE_CODES）→ 失败类别；可恢复的返回 null */
export function classifyGatewayClose(code: number | undefined): LoginFailure | null {
  switch (code) {
    case 4004: return { kind: "token", fatal: true, detail: "gateway close 4004 Authentication failed" };
    case 4013: return { kind: "intents", fatal: true, detail: "gateway close 4013 Invalid intents" };
    case 4014: return { kind: "intents", fatal: true, detail: "gateway close 4014 Disallowed intents" };
    case 4010: case 4011: case 4012: return { kind: "unknown", fatal: true, detail: `gateway close ${code}（分片 / API 版本配置错误）` };
    default: return null;
  }
}

/** 第 n 次连续失败（从 1 起）后等多久：5s 起翻倍，封顶 5 分钟；不可恢复类直接按上限 */
export function loginBackoffMs(failures: number, fatal: boolean): number {
  if (fatal) return LOGIN_BACKOFF_MAX_MS;
  return Math.min(LOGIN_BACKOFF_MAX_MS, LOGIN_BACKOFF_BASE_MS * 2 ** Math.max(0, failures - 1));
}

const KIND_LABEL: Record<LoginFailureKind, string> = {
  token: "🚨 Discord token 无效（DISCORD_BOT_TOKEN 失效或被重置）",
  intents: "🚨 Discord 拒绝 intents（Developer Portal 未开 Privileged Gateway Intents，尤其 MESSAGE CONTENT）",
  network: "📴 Discord 网络不可达",
  tls: "🔒 Discord TLS 握手失败（代理 / 证书 / 系统时间）",
  unknown: "❓ Discord 登录失败（原因未识别）",
};

function describeFailure(f: LoginFailure, failures: number, retryMs: number): string {
  const head = `${KIND_LABEL[f.kind]} —— 第 ${failures} 次，${Math.round(retryMs / 1000)}s 后重试；bridge 不退出，web / agent 消息照常`;
  const fix = f.fatal ? "\n   🚨 不可恢复：改好 .env / Developer Portal 后 launchctl kickstart -k gui/$(id -u)/com.claudestra.bridge" : "";
  return `${head}\n   原因：${f.detail}${fix}`;
}

type Timer = ReturnType<typeof setTimeout>;
/**
 * gateway 此刻是否在线：所有 shard 都 READY(0)。不能用 client.isReady() / ws.status ——
 * 前者在任何一次 login 失败后永远 false（ws.destroyed 不复位），后者第一次 ready 后永远是 READY。
 */
export function gatewayConnected(client: { ws: { shards: { size: number; every(fn: (s: { status: number }) => boolean): boolean } } }): boolean {
  return client.ws.shards.size > 0 && client.ws.shards.every((s) => s.status === 0);
}

export interface ConnectorDeps {
  login: () => Promise<unknown>;
  /** 重试定时器到点时若已在线（超时作废的旧 login 后来连上了）就不再 identify */
  isConnected: () => boolean;
  log?: Pick<Console, "log" | "warn" | "error">;
  setTimer?: (fn: () => void, ms: number) => Timer;
  clearTimer?: (t: Timer) => void;
  loginTimeoutMs?: number;
}

export interface DiscordConnector {
  start(): void;
  /** 看门狗用：已有登录在跑或重试已排上就不插队 */
  reconnect(reason: string): void;
  /** 外部发现的失败（gateway 不可恢复关闭）：作废在跑的登录，按退避重排 */
  fail(f: LoginFailure): void;
  readonly failures: number;
}

export function createDiscordConnector(deps: ConnectorDeps): DiscordConnector {
  const log = deps.log ?? console;
  const setTimer = deps.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
  const clearTimer = deps.clearTimer ?? ((t) => clearTimeout(t));
  const timeoutMs = deps.loginTimeoutMs ?? LOGIN_TIMEOUT_MS;
  let gen = 0; // 每次新尝试 / 作废 +1：迟到的旧 login 结果一律丢弃
  let inFlight = false;
  let retry: Timer | null = null;
  let failures = 0;

  const recovered = (how: string) => {
    if (failures) log.log(`✅ Discord 登录恢复（此前连续失败 ${failures} 次；${how}）`);
    failures = 0;
  };
  const schedule = (f: LoginFailure) => {
    failures++;
    const ms = loginBackoffMs(failures, f.fatal);
    (f.fatal ? log.error : log.warn)(describeFailure(f, failures, ms));
    if (retry) clearTimer(retry);
    retry = setTimer(() => {
      retry = null;
      if (deps.isConnected()) return recovered("超时作废的那次登录后来连上了");
      attempt();
    }, ms);
  };

  const attempt = () => {
    const my = ++gen;
    inFlight = true;
    let timer: Timer | null = setTimer(() => {
      timer = null;
      if (my !== gen) return;
      gen++; inFlight = false;
      schedule({ kind: "network", fatal: false, detail: `login ${Math.round(timeoutMs / 1000)}s 未完成（gateway 握手无响应）` });
    }, timeoutMs);
    deps.login().then(
      () => {
        if (my !== gen) return;
        inFlight = false;
        recovered("login 成功");
      },
      (e: unknown) => {
        if (my !== gen) return;
        inFlight = false;
        schedule(classifyLoginError(e));
      },
    ).finally(() => { if (timer) clearTimer(timer); });
  };

  return {
    start: attempt,
    reconnect(reason) {
      if (inFlight || retry) return;
      log.warn(`🔄 Discord 重连：${reason}`);
      attempt();
    },
    fail(f) {
      gen++; inFlight = false;
      schedule(f);
    },
    get failures() { return failures; },
  };
}

export interface GatewayEmitter { on(event: string, fn: (...args: any[]) => void): unknown }
export const SHARD_LOG_EVERY_MS = 60_000;

/**
 * shard 诊断 + 不可恢复关闭码（4004 / 4014 …，discord.js 不会自己重连）交给 connector.fail。
 * discord.js 只对这些码发 shardDisconnect；可恢复的断线由 @discordjs/ws 自己无限重连，长时间连不回来归状态看门狗。
 */
export function attachGatewayWatch(client: GatewayEmitter, connector: DiscordConnector, now: () => number = Date.now): void {
  client.on("shardDisconnect", (event: { code?: number; reason?: string } | undefined, shardId: number) => {
    console.warn(`⚠️ shard ${shardId} disconnect: code=${event?.code} reason="${event?.reason || ""}"`);
    const fatal = classifyGatewayClose(event?.code);
    if (fatal) connector.fail(fatal);
  });
  // 断网时 shard 每 0.5s 重连一次、每次各打一行 —— 断几小时就是几万行，同类每分钟只打一条并带上省略数
  const quiet = new Map<string, { at: number; skipped: number }>();
  const throttled = (key: string, write: (m: string) => void, msg: string) => {
    const t = now();
    const s = quiet.get(key);
    if (s && t - s.at < SHARD_LOG_EVERY_MS) { s.skipped++; return; }
    write(s?.skipped ? `${msg}（此前同类 ${s.skipped} 条已省略）` : msg);
    quiet.set(key, { at: t, skipped: 0 });
  };
  client.on("shardError", (error: Error, shardId: number) => throttled(`err${shardId}`, console.error, `⚠️ shard ${shardId} error: ${error?.message}`));
  client.on("shardReconnecting", (shardId: number) => throttled(`re${shardId}`, console.log, `🔄 shard ${shardId} reconnecting…`));
  client.on("shardResume", (shardId: number, replayed: number) => console.log(`✅ shard ${shardId} resumed (replayed ${replayed} events)`));
  client.on("shardReady", (shardId: number) => console.log(`✅ shard ${shardId} ready`));
}

/**
 * gateway 健康看门狗的一拍（每分钟）：shard 断了自己重连不回来时，连续 5 拍不在线 → 重新 login。
 * 断网期间 connector 正在退避时 reconnect 是空操作，所以不会叠加。
 */
export function createStatusWatchdog(connected: () => boolean, connector: DiscordConnector, limit = 5): () => void {
  let bad = 0;
  return () => {
    if (connected()) { bad = 0; return; }
    bad++;
    console.warn(`⚠️ Discord gateway 不在线 — unhealthy ${bad}/${limit}`);
    if (bad < limit) return;
    bad = 0;
    connector.reconnect(`gateway 持续 ${limit} 分钟非 READY`);
  };
}

/** ready 可能因重连再次触发：Discord 侧初始化（slash 注册、看板、看门狗…）只做第一次 */
export function bindFirstReady(client: { once(event: "ready", fn: () => void): unknown }, init: () => Promise<void>): void {
  client.once("ready", () => {
    init().catch((e) => console.error("Discord 首次 ready 初始化失败:", e));
  });
}
