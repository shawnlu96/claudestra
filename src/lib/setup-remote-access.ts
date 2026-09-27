/**
 * setup 向导「手机访问」一步：先选路，再配。默认是中继（手机什么都不装，这台机器只向外连一条 WebSocket，
 * docs/relay/README.md）；Tailscale 可选（选了才走 setup.ts 里保留的 Tailscale 流程）；第三项只用局域网
 * （要让 bridge 监听所有网卡，否则给出的地址打不开）；第四项自己的域名 / 反代，向导只指路。
 * 每条路的代价和谁能看到内容都在选之前讲清：中继不是必选，几条路可以并存。
 * 终端原语（t / print / prompt…）由 setup.ts 注入：lib 不能反向 import 入口文件。
 * 判定都是纯函数（normalizeRelayUrl / relayEntryUrl / bindsAllInterfaces / relayLinkVerdict），tests/setup-remote-access.test.ts。
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

/** disableRelay：机器原本配着中继而用户改选别的路，且同意停用（setup 把 RELAY_URL 写空，bridge 视为没配） */
/** bind：选了局域网并同意监听所有网卡时写进 .env 的 BRIDGE_BIND */
export type RemoteAccessChoice =
  | { kind: "relay"; relayUrl: string; relayName: string; url: string }
  | { kind: "tailscale"; url?: string; disableRelay?: boolean }
  | { kind: "lan"; url?: string; disableRelay?: boolean; bind?: string }
  | { kind: "custom"; url?: undefined; disableRelay?: boolean };

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

/**
 * 手机要打开的地址：中继首页（路径模式，配对后浏览器记住是哪台机器）。旧的 <名字>.<中继域名> 子域名入口已废弃，
 * 向导不再给出它——那个地址扫码后停在「等待确认」，子域名下线后直接失效。
 */
export function relayEntryUrl(st: Pick<RelayLinkInfo, "base"> | null, relayUrl: string): string {
  const home = relayHttpsBase(relayUrl);
  return st?.base ? `${new URL(home).protocol}//${st.base}` : home;
}

/** .env 的 BRIDGE_BIND 是否监听所有网卡（局域网 / tailnet 的明文地址只有这时才打得开） */
export function bindsAllInterfaces(bind: string | undefined): boolean {
  return /^(0\.0\.0\.0|::|\[::\]|\*)$/.test((bind ?? "").trim().replace(/^["']|["']$/g, ""));
}

/** 名字的校验（中继目录里的机器名，也用作旧子域名标签）：不合法就给出 slugify 后的建议 */
export function relayNameError(v: string, t: SetupUi["t"]): string | null {
  const s = slugify(v);
  if (s === v) return null;
  return t(`只能用小写字母、数字和中划线，开头结尾不能是中划线（建议：${s}）`, `Lowercase letters, digits and dashes only, not starting/ending with a dash (suggestion: ${s})`);
}

export type RelayLinkVerdict =
  | { kind: "connected"; url: string; renamed: boolean }
  | { kind: "waiting"; why: string }
  | { kind: "no-bridge" };

/** bridge 的 GET /relay/status（或拿不到它）→ 装完后该对用户说什么；renamed = 中继给的名字和填的不一样（被占了加了后缀） */
export function relayLinkVerdict(st: RelayLinkInfo | null, relayUrl: string, name: string): RelayLinkVerdict {
  if (!st) return { kind: "no-bridge" };
  if (st.connected) return { kind: "connected", url: relayEntryUrl(st, relayUrl), renamed: !!st.slug && st.slug !== slugify(name) };
  return { kind: "waiting", why: `${st.state ?? "unknown"}${st.lastError ? `: ${st.lastError}` : ""}` };
}

// ── 交互 ──────────────────────────────────────────────────────────────────

export type RelayProbe = (relayUrl: string) => Promise<{ ok: true; version?: string } | { ok: false; detail: string }>;

export interface ChooseOpts {
  /** 现有 .env 的值（续装时做默认） */
  existing: { RELAY_URL?: string; RELAY_NAME?: string; BRIDGE_BIND?: string };
  /** 探测到的局域网地址（第三项只用它） */
  lanUrl?: string;
  /** 单测注入；生产用 probeRelay（GET /healthz） */
  probe?: RelayProbe;
}

/** 四选一。选了 Tailscale 只返回意向，具体流程在 setup.ts */
export async function chooseRemoteAccess(ui: SetupUi, opts: ChooseOpts): Promise<RemoteAccessChoice> {
  const { t } = ui;
  printChoices(ui);
  const pick = (await ui.prompt(t("选择", "Choose"), "1", (v) => (["1", "2", "3", "4"].includes(v.trim()) ? null : t("输入 1、2、3 或 4", "Enter 1, 2, 3 or 4")))).trim();
  if (pick === "1") return configureRelay(ui, opts.existing, opts.probe ?? probeRelay);
  const base = pick === "2" ? { kind: "tailscale" as const, url: opts.lanUrl } : pick === "3" ? await chooseLan(ui, opts) : chooseCustom(ui);
  const current = normalizeRelayUrl(opts.existing.RELAY_URL ?? "");
  if (!current) return base;
  // 原本走着中继却改选别的路：问一句要不要停用，默认留着（几条路并存无害，删了才是不可逆的）
  const disableRelay = await ui.confirm(
    t(`这台机器目前配着中继（${current}）。停用它吗？（默认留着，两条路可以同时用）`, `This machine is currently on the relay (${current}). Disable it? (default: keep it — both paths can be used at once)`),
    false,
  );
  return { ...base, disableRelay };
}

function printChoices(ui: SetupUi): void {
  const { t, c } = ui;
  ui.print(t(
    "装完后在这台电脑上开浏览器就能用。要在手机或别的电脑上用，从下面选一条。中继不是必选；这几条路可以同时开着，以后重跑 bun run setup 随时换。",
    "Once installed, a browser on this machine just works. To use Claudestra from your phone or another computer, pick a path below. " +
      "The relay is optional; paths can run side by side, and you can switch any time by rerunning `bun run setup`.",
  ));
  ui.br();
  ui.print(`  ${c.bold}1${c.reset}  ${t(
    "中继（默认，最省事）—— 手机什么都不装。这台电脑向外连一条 WebSocket，手机在任何网络打开中继首页、扫码配对。不开端口、不要公网 IP、不配证书。",
    "Relay (default, easiest) — nothing to install on the phone. This machine keeps one outbound WebSocket; the phone opens the relay's home page " +
      "from any network and pairs by QR code. No open port, no public IP, no certificates.",
  )}`);
  ui.hint(t(
    "⚠ 中继是 HTTPS 的终点，网页脚本也由它下发：运营方技术上能看到你和 agent 的对话，也能冒用你已配对的设备给 agent 下命令（agent 在这台电脑上等于一个不受限的 shell）。官方中继由 Claudestra 维护者运营，端到端加密还没做。介意就选 2，或自建中继：docs/relay/self-host.md",
    "⚠ The relay terminates HTTPS and serves the web app's scripts, so its operator can technically read your conversations with agents and act " +
      "as one of your paired devices (an agent is an unrestricted shell on this machine). The official relay is run by the Claudestra maintainers; " +
      "end-to-end encryption is not built yet. If that matters, pick 2 or self-host a relay: docs/relay/self-host.md",
  ));
  ui.print(`  ${c.bold}2${c.reset}  ${t(
    "Tailscale —— 两边都装 Tailscale、登录同一个账号，内容只在你自己的设备之间走；向导可以替你装好并配 HTTPS。代价：要装 App；开 HTTPS 证书后机器名会进入公开的证书透明日志。",
    "Tailscale — install it on both devices with the same account; traffic stays between your own devices. The wizard can install it and set up " +
      "HTTPS. Cost: an app on the phone; with HTTPS certificates the machine name lands in public Certificate Transparency logs.",
  )}`);
  ui.print(`  ${c.bold}3${c.reset}  ${t(
    "只在同一网络用（临时试用）—— bridge 要监听所有网卡。明文 HTTP，同一网络的人能看到流量；扫码配对、推送、语音、PWA 都用不了" +
      "（在配对页手输短码，再在这台电脑或已配对设备上批准），出门就断。",
    "Same network only (quick trial) — the bridge must listen on all interfaces. Plain HTTP, visible to anyone on the network; no QR pairing, " +
      "push, voice or PWA (type the short code on the pairing page, then approve it on this machine or a paired device); stops working once you leave.",
  )}`);
  ui.print(`  ${c.bold}4${c.reset}  ${t(
    "我有自己的域名 / 反向代理（高级）—— 向导不自动配，给你文档和配对命令。",
    "My own domain / reverse proxy (advanced) — not automated; the wizard points you to the docs and the pairing command.",
  )}`);
  ui.br();
}

/** 选 3：bridge 默认只听 127.0.0.1，不改 BRIDGE_BIND 给出的局域网地址打不开，所以先讲风险再问要不要改 */
async function chooseLan(ui: SetupUi, opts: ChooseOpts): Promise<Extract<RemoteAccessChoice, { kind: "lan" }>> {
  const { t } = ui;
  if (bindsAllInterfaces(opts.existing.BRIDGE_BIND)) return { kind: "lan", url: opts.lanUrl };
  ui.hint(t(
    "bridge 现在只监听本机（127.0.0.1）。改成监听所有网卡（0.0.0.0 = 这台电脑所有的 IPv4 接口，不只是 Wi-Fi）后，能连到这些接口的设备都能访问它的端口：" +
      "网页和配对入口是公开的，其余接口要配对后才能用，但流量是明文，登录凭据可能被同网络的人截获复用。咖啡馆、公司这类公共网络不要开。",
    "The bridge listens on this machine only (127.0.0.1). Listening on all interfaces (0.0.0.0 = every IPv4 interface, not just Wi-Fi) lets any " +
      "device that can reach them hit its port: the web page and pairing entry are public, the rest needs pairing, but traffic is plain text and " +
      "a login cookie can be sniffed and replayed. Don't do this on public networks such as cafés or offices.",
  ));
  if (await ui.confirm(t("让 bridge 监听所有网卡（.env 写 BRIDGE_BIND=0.0.0.0）？", "Let the bridge listen on all interfaces (.env BRIDGE_BIND=0.0.0.0)?"), false)) {
    return { kind: "lan", url: opts.lanUrl, bind: "0.0.0.0" };
  }
  ui.hint(t("没改。手机暂时用不了；之后想配，重跑 bun run setup。", "Unchanged. The phone can't connect for now; rerun `bun run setup` when you want to set this up."));
  return { kind: "lan" };
}

/**
 * 选 4：只指路。反代必须设置（覆盖）X-Forwarded-For：bridge 把「回环 socket 且没有 XFF」认成本机（可一键全权配对、
 * 免控制面鉴权），nginx 只配 Proto / Host 时公网请求就成了「本机」。Proto / Host 用来判同源。
 */
function chooseCustom(ui: SetupUi): Extract<RemoteAccessChoice, { kind: "custom" }> {
  const { t, c } = ui;
  ui.print(t(
    `照 ${c.cyan}web/SETUP.md${c.reset} 的「Public reverse proxy」和「Custom domain」两节，用 Caddy / nginx 加证书，把 HTTPS 转到 bridge 端口。`,
    `Follow the "Public reverse proxy" and "Custom domain" sections of ${c.cyan}web/SETUP.md${c.reset}: Caddy or nginx with a certificate, forwarding HTTPS to the bridge port.`,
  ));
  ui.warn(t(
    "反代必须设置（覆盖掉客户端自带的）X-Forwarded-For，再带上 X-Forwarded-Proto 和 X-Forwarded-Host。漏了 X-Forwarded-For，外网请求会被 bridge 当成「本机」，" +
      "能一键拿到全部权限。Caddy 默认会设；nginx 要写 proxy_set_header X-Forwarded-For $remote_addr;",
    "The proxy must set (overwriting any client value) X-Forwarded-For, plus X-Forwarded-Proto and X-Forwarded-Host. Without X-Forwarded-For, " +
      "internet requests look like this machine to the bridge and can pair with full access in one click. Caddy sets it by default; " +
      "nginx needs proxy_set_header X-Forwarded-For $remote_addr;",
  ));
  ui.hint(t(
    "对公网开放时必须加限流或 IP 白名单。配好后用 claudestra pair --url https://<你的域名> 出配对二维码。",
    "If it faces the internet, add rate limiting or an IP allowlist. Once it works, `claudestra pair --url https://<your-domain>` prints a pairing QR code.",
  ));
  return { kind: "custom" };
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
    `${c.bold}${t("这台电脑的显示名", "Display name for this machine")}${c.reset} ${c.dim}${t(
      "(中继目录、配对页和联系人的通讯录里都看得到；不想暴露真名或公司名就换一个)",
      "(shown in the relay directory, on pairing pages and in your contacts' lists — change it if the hostname reveals too much)",
    )}${c.reset}`,
    existing.RELAY_NAME && !relayNameError(existing.RELAY_NAME, t) ? existing.RELAY_NAME : slugify(hostname()),
    (v) => relayNameError(v, t),
  );
  const url = relayEntryUrl(null, relayUrl);
  ui.ok(t(`手机上打开: ${c.cyan}${url}${c.reset}（装完会出配对二维码）`, `On your phone: ${c.cyan}${url}${c.reset} (a pairing QR code follows after install)`));
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

/** link = 中继首页 + #<指纹>.<密钥>（扫码直接完成配对）；url 是旧子域名入口的字段，只在没有 link 的旧 bridge 上兜底 */
interface PairInfo { ok: boolean; link?: string | null; url?: string | null; display: string; expiresAt: string; error?: string }

/**
 * 装完（daemon 已起）之后：等 bridge 连上中继，报最终地址，并直接签一个配对码打成二维码——手机扫一下就登录，
 * 不用先找密码。等不到就告诉用户之后怎么拿（claudestra pair）。返回该写进「完成」横幅的手机地址。
 */
export async function confirmRelayLink(ui: SetupUi, choice: { relayUrl: string; relayName: string; url: string }, waitMs = 20_000): Promise<string> {
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
  const v = relayLinkVerdict(st, choice.relayUrl, choice.relayName);
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
  if (v.renamed && st?.slug) ui.hint(t(`名字被占了，中继上显示为 ${st.slug}。`, `The name was taken; the relay lists this machine as ${st.slug}.`));
  const pair = await fetch(`${bridgeHttpBase()}/relay/pair/new`, { method: "POST", signal: AbortSignal.timeout(5000) })
    .then((r) => r.json() as Promise<PairInfo>)
    .catch(() => null); // 签不出配对码不是安装失败：下面提示用 claudestra pair 再拿
  const link = pair?.link ?? pair?.url;
  if (!pair?.ok || !link) {
    ui.hint(t("配对码稍后用 claudestra pair 拿。", "Get a pairing code later with `claudestra pair`."));
    return v.url;
  }
  ui.br();
  // 只有新版 bridge 给的 link（#指纹.密钥）扫了才直接配好；旧 bridge 只有子域名 #短码，还要电脑批准
  ui.print(pair.link
    ? t("手机相机扫这个码，打开就配对好了（10 分钟内有效，只能用一次）：", "Scan this with the phone camera — it opens already paired (valid 10 minutes, single use):")
    : t("手机相机扫这个码（旧版入口：打开后还要在这台电脑上批准；10 分钟内有效）：", "Scan this with the phone camera (legacy entry: approve it on this machine afterwards; valid 10 minutes):"));
  await printQr(ui, link);
  ui.print(`  ${t("链接", "Link")}: ${c.cyan}${link}${c.reset}`);
  const home = relayEntryUrl(st, choice.relayUrl);
  ui.print(`  ${t("短码", "Code")}: ${c.bold}${pair.display}${c.reset}  ${c.dim}${t(
    `（也可以在 ${home} 首页手输；手输的还要在这台电脑或已配对设备上批准）`,
    `(or type it at ${home}; a typed code must then be approved on this machine or a paired device)`,
  )}${c.reset}`);
  ui.hint(t(
    "扫码的这台设备会拥有这台电脑的全部权限（全部 agent、终端、管理）；丢了就去网页「设备」面板撤销。以后给别的设备配对：claudestra pair。",
    "The device that scans gets full access to this machine (all agents, terminal, management); if it's lost, revoke it in the web client's " +
      "Devices panel. Pair more devices later with `claudestra pair`.",
  ));
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
