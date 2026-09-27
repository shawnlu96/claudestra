/**
 * setup 向导「手机访问」一步：先选路，再配。默认是中继（手机什么都不装，这台机器只向外连一条 WebSocket，
 * docs/relay/README.md）；Tailscale 退为可选（选了才走 setup.ts 里保留的 Tailscale 流程）；第三项只用局域网。
 * 终端原语（t / print / prompt…）由 setup.ts 注入：lib 不能反向 import 入口文件。
 * 判定都是纯函数（normalizeRelayUrl / predictRelayUrl / relayLinkVerdict），tests/setup-remote-access.test.ts。
 */
import { hostname } from "node:os";
import { bridgeHttpBase } from "./bridge-port.js";
import type { RelayLinkInfo } from "./relay-client-types.js";
import { slugify } from "./relay-protocol.js";

/** 官方托管中继。产品域名换了只改这一处；自建的人在向导里覆盖它，或直接写 .env 的 RELAY_URL */
export const DEFAULT_RELAY_URL = "wss://relay.sunstriker.cc";

/** setup.ts 的终端原语（只取这一步用到的） */
export interface SetupUi {
  t: (zh: string, en: string) => string;
  print: (s?: string) => void;
  br: () => void;
  ok: (s: string) => void;
  warn: (s: string) => void;
  hint: (s: string) => void;
  prompt: (label: string, def?: string, validator?: (v: string) => string | null) => Promise<string>;
  confirm: (question: string, defaultYes?: boolean) => Promise<boolean>;
  c: { bold: string; dim: string; cyan: string; reset: string };
}

export type RemoteAccessChoice =
  | { kind: "relay"; relayUrl: string; relayName: string; url: string }
  | { kind: "tailscale"; url?: string }
  | { kind: "lan"; url?: string };

// ── 纯函数 ────────────────────────────────────────────────────────────────

/** 用户输入 → .env 里的 RELAY_URL：裸主机名补 wss://，https/http 换成 wss/ws，去掉引号、查询串与末尾的 /；不像地址的返回 null */
export function normalizeRelayUrl(input: string): string | null {
  let s = input.trim().replace(/^["']|["']$/g, "");
  if (!s || /\s/.test(s)) return null;
  if (!/^[a-z]+:\/\//i.test(s)) s = `wss://${s}`;
  s = s.replace(/^https:\/\//i, "wss://").replace(/^http:\/\//i, "ws://");
  let u: URL;
  try {
    u = new URL(s);
  } catch {
    return null; // 不是能解析的地址：调用方提示重输
  }
  if ((u.protocol !== "wss:" && u.protocol !== "ws:") || !u.hostname) return null;
  const path = u.pathname.replace(/\/+$/, "");
  return `${u.protocol}//${u.host}${path}`;
}

/** 中继的 HTTPS 基址（healthz、首页）：wss → https、ws → http，同主机同端口 */
export function relayHttpsBase(relayUrl: string): string {
  const u = new URL(relayUrl);
  return `${u.protocol === "ws:" ? "http:" : "https:"}//${u.host}`;
}

/** 装完之前预测的网页地址；名字被占时中继会加后缀，最终以 bridge 连上后报的为准 */
export function predictRelayUrl(relayUrl: string, name: string): string {
  const u = new URL(relayUrl);
  return `${u.protocol === "ws:" ? "http:" : "https:"}//${slugify(name)}.${u.hostname}${u.port ? `:${u.port}` : ""}`;
}

/** 子域名标签的校验：不合法就给出 slugify 后的建议 */
export function relayNameError(v: string, t: SetupUi["t"]): string | null {
  const s = slugify(v);
  if (s === v) return null;
  return t(`只能用小写字母、数字和中划线，开头结尾不能是中划线（建议：${s}）`, `Lowercase letters, digits and dashes only, not starting/ending with a dash (suggestion: ${s})`);
}

export type RelayLinkVerdict =
  | { kind: "connected"; url: string; renamed: boolean }
  | { kind: "waiting"; why: string }
  | { kind: "no-bridge" };

/** bridge 的 GET /relay/status（或拿不到它）→ 装完后该对用户说什么 */
export function relayLinkVerdict(st: RelayLinkInfo | null, predicted: string): RelayLinkVerdict {
  if (!st) return { kind: "no-bridge" };
  if (st.connected && st.url) return { kind: "connected", url: st.url, renamed: st.url !== predicted };
  return { kind: "waiting", why: `${st.state ?? "unknown"}${st.lastError ? `: ${st.lastError}` : ""}` };
}

// ── 交互 ──────────────────────────────────────────────────────────────────

export type RelayProbe = (relayUrl: string) => Promise<{ ok: true; version?: string } | { ok: false; detail: string }>;

export interface ChooseOpts {
  /** 现有 .env 的值（续装时做默认） */
  existing: { RELAY_URL?: string; RELAY_NAME?: string };
  /** 探测到的局域网地址（第三项只用它） */
  lanUrl?: string;
  /** 单测注入；生产用 probeRelay（GET /healthz） */
  probe?: RelayProbe;
}

/** 三选一。选了 Tailscale 只返回意向，具体流程在 setup.ts */
export async function chooseRemoteAccess(ui: SetupUi, opts: ChooseOpts): Promise<RemoteAccessChoice> {
  const { t, c } = ui;
  ui.print(t(
    "Web 端装在本机，在这台机器上开浏览器就能用。要在**手机**上用，三条路选一条：",
    "The web client runs on this machine — a browser here just works. To use it from your **phone**, pick one of three ways:",
  ));
  ui.br();
  ui.print(`  ${c.bold}1${c.reset}  ${t(
    "中继（推荐）—— 手机什么都不装。这台机器向外连一条加密 WebSocket 到中继，手机在任何网络打开 https://<你的名字>.<中继域名> 就是这里的网页；不需要公网 IP、不开端口、不配证书。",
    "Relay (recommended) — nothing to install on the phone. This machine keeps one encrypted WebSocket to the relay; the phone opens https://<your-name>.<relay-domain> from any network. No public IP, no open port, no certificates.",
  )}`);
  ui.hint(t(
    "中继是 TLS 的终点，看得见经它的流量（和任何反向代理一样）。官方中继免费；也可以自建：docs/relay/self-host.md",
    "The relay terminates TLS and can read the traffic through it (like any reverse proxy). The official relay is free; you can also run your own: docs/relay/self-host.md",
  ));
  ui.print(`  ${c.bold}2${c.reset}  ${t(
    "Tailscale —— 两边都装 Tailscale，流量只走你自己的私有网络、不经任何第三方；要装 App、登录账号，再配 HTTPS。",
    "Tailscale — install it on both devices; traffic stays inside your own private network, no third party. Needs the app, an account, then HTTPS.",
  )}`);
  ui.print(`  ${c.bold}3${c.reset}  ${t(
    `先不配 —— 只在同一 Wi-Fi 下用局域网地址${opts.lanUrl ? `（${opts.lanUrl}）` : ""}，出门就断。`,
    `Not now — LAN address only${opts.lanUrl ? ` (${opts.lanUrl})` : ""}, stops working once you leave the Wi-Fi.`,
  )}`);
  ui.br();
  const pick = await ui.prompt(t("选择", "Choose"), "1", (v) => (["1", "2", "3"].includes(v.trim()) ? null : t("输入 1、2 或 3", "Enter 1, 2 or 3")));
  if (pick.trim() === "2") return { kind: "tailscale" };
  if (pick.trim() === "3") {
    ui.hint(t("之后想配，重跑 bun run setup 走到这一步即可。", "Rerun `bun run setup` any time to set this up."));
    return { kind: "lan", url: opts.lanUrl };
  }
  return configureRelay(ui, opts.existing, opts.probe ?? probeRelay);
}

async function configureRelay(ui: SetupUi, existing: ChooseOpts["existing"], probe: RelayProbe): Promise<RemoteAccessChoice> {
  const { t, c } = ui;
  ui.br();
  let relayUrl = "";
  for (;;) {
    const raw = await ui.prompt(
      `${c.bold}${t("中继地址", "Relay address")}${c.reset} ${c.dim}${t("(回车用官方中继；自建的填自己的)", "(ENTER for the official relay; or your own)")}${c.reset}`,
      normalizeRelayUrl(existing.RELAY_URL ?? "") ?? DEFAULT_RELAY_URL,
      (v) => (normalizeRelayUrl(v) ? null : t("要像 wss://relay.example.com 这样（只写主机名也行）", "Looks like wss://relay.example.com (a bare hostname works too)")),
    );
    relayUrl = normalizeRelayUrl(raw)!;
    const h = await probe(relayUrl);
    if (h.ok) {
      ui.ok(t(`中继在线${h.version ? `（v${h.version}）` : ""}`, `Relay is up${h.version ? ` (v${h.version})` : ""}`));
      break;
    }
    ui.warn(t(`连不上这个中继：${h.detail}`, `Can't reach this relay: ${h.detail}`));
    if (await ui.confirm(t("仍然写入这个地址？（bridge 会自己重试；选 n 重输）", "Keep this address anyway? (the bridge retries on its own; n = re-enter)"), false)) break;
  }
  const relayName = await ui.prompt(
    `${c.bold}${t("你的名字（子域名标签）", "Your name (subdomain label)")}${c.reset}`,
    existing.RELAY_NAME && !relayNameError(existing.RELAY_NAME, t) ? existing.RELAY_NAME : slugify(hostname()),
    (v) => relayNameError(v, t),
  );
  const url = predictRelayUrl(relayUrl, relayName);
  ui.ok(t(`手机上打开: ${c.cyan}${url}${c.reset}`, `On your phone: ${c.cyan}${url}${c.reset}`));
  ui.hint(t("名字被别人占了会自动加一段后缀，装完以实际连上的地址为准（下面会再确认一次）。", "If the name is taken the relay appends a suffix; the final address is confirmed after install below."));
  return { kind: "relay", relayUrl, relayName, url };
}

/** GET <https base>/healthz：中继在不在、哪一版 */
const probeRelay: RelayProbe = async (relayUrl) => {
  try {
    const r = await fetch(`${relayHttpsBase(relayUrl)}/healthz`, { signal: AbortSignal.timeout(5000) });
    if (!r.ok) return { ok: false, detail: `HTTP ${r.status}` };
    const j = (await r.json().catch(() => ({}))) as { version?: string }; // 不是 JSON 也算在线：只是少了版本号
    return { ok: true, version: j.version };
  } catch (e) {
    return { ok: false, detail: (e as Error).message };
  }
};

interface PairInfo { ok: boolean; url: string; display: string; expiresAt: string; error?: string }

/**
 * 装完（daemon 已起）之后：等 bridge 连上中继，报最终地址，并直接签一个配对码打成二维码——手机扫一下就登录，
 * 不用先找密码。等不到就告诉用户之后怎么拿（claudestra pair）。返回该写进「完成」横幅的手机地址。
 */
export async function confirmRelayLink(ui: SetupUi, choice: { relayUrl: string; url: string }, waitMs = 20_000): Promise<string> {
  const { t, c } = ui;
  const predicted = choice.url;
  ui.br();
  ui.print(t("等 bridge 连上中继…", "Waiting for the bridge to reach the relay…"));
  const deadline = Date.now() + waitMs;
  let st: RelayLinkInfo | null = null;
  for (;;) {
    const r = await fetch(`${bridgeHttpBase()}/relay/status`, { signal: AbortSignal.timeout(2000) }).catch(() => null); // bridge 还没起来：下面按 no-bridge 提示
    if (r?.ok) st = (await r.json()) as RelayLinkInfo;
    if (st?.connected || Date.now() >= deadline || (r && !r.ok)) break; // 非 2xx = 跑着没有 /relay 路由的旧 bridge，等也没用
    await new Promise((res) => setTimeout(res, 1000));
  }
  const v = relayLinkVerdict(st, predicted);
  if (v.kind === "no-bridge") {
    ui.hint(t(
      "bridge 还没起来（或者你选了自己启动 daemon）。起来后运行 claudestra pair 拿配对码，手机扫码即登录。",
      "The bridge isn't up yet (or you chose to start the daemons yourself). Once it is, run `claudestra pair` for a QR code — scan it and you're signed in.",
    ));
    return predicted;
  }
  if (v.kind === "waiting") {
    ui.warn(t(`bridge 还没连上中继（${v.why}）—— 它会自己重试。`, `The bridge hasn't reached the relay yet (${v.why}) — it keeps retrying.`));
    ui.hint(t("稍后 claudestra doctor 看「手机访问 → 中继」；连上后 claudestra pair 出配对码。", "Check `claudestra doctor` (Phone access → relay) later; once connected, `claudestra pair` prints a pairing code."));
    return predicted;
  }
  ui.ok(t(`已连上中继: ${c.cyan}${v.url}${c.reset}`, `Connected to the relay: ${c.cyan}${v.url}${c.reset}`));
  if (v.renamed) ui.hint(t("名字被占了，中继分配了这个地址。", "The name was taken; the relay assigned this address."));
  const pair = await fetch(`${bridgeHttpBase()}/relay/pair/new`, { method: "POST", signal: AbortSignal.timeout(5000) })
    .then((r) => r.json() as Promise<PairInfo>)
    .catch(() => null); // 签不出配对码不是安装失败：下面提示用 claudestra pair 再拿
  if (!pair?.ok) {
    ui.hint(t("配对码稍后用 claudestra pair 拿（手机扫码即登录）。", "Get a pairing code later with `claudestra pair` (scan to sign in)."));
    return v.url;
  }
  ui.br();
  ui.print(t("手机相机扫这个码，打开就登录了（10 分钟内有效，只能用一次）：", "Scan this with the phone camera — it opens signed in (valid 10 minutes, single use):"));
  await printQr(ui, pair.url);
  ui.print(`  ${t("链接", "Link")}: ${c.cyan}${pair.url}${c.reset}`);
  ui.print(`  ${t("短码", "Code")}: ${c.bold}${pair.display}${c.reset}  ${c.dim}${t(`（在 ${relayHttpsBase(choice.relayUrl)} 首页输入也行）`, `(or type it at ${relayHttpsBase(choice.relayUrl)})`)}${c.reset}`);
  ui.hint(t("以后给别的手机配对：claudestra pair；网页的 Peer 面板顶部也有「配对新设备」。", "To pair another phone later: `claudestra pair`, or the *Pair a new device* button in the web client's Peer panel."));
  return v.url;
}

/** 终端二维码（qrcode 是根目录依赖；setup 可能在 bun install 之前跑，加载失败就只留 URL 文本） */
export async function printQr(ui: SetupUi, url: string): Promise<void> {
  try {
    const { toString } = await import("qrcode");
    const qr = await toString(url, { type: "terminal", small: true });
    ui.br();
    ui.print(qr.trimEnd().split("\n").map((l) => `  ${l}`).join("\n"));
    ui.br();
  } catch {
    ui.hint(ui.t("（终端画不出二维码，用上面的链接）", "(no QR in this terminal — use the link)"));
  }
}
