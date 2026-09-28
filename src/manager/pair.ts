/**
 * `claudestra pair [--agents a,b|*] [--no-terminal] [--no-manage] [--guest <名字> --agents a,b [--confirm-all]] [--url <入口地址>] [--json]`
 * （docs/design-hosted-frontend.md §4）：让 bridge 签一组配对码，打印二维码 / 链接 / 短码，并**明确打印这条凭据的 grant**（默认全权：
 * 所有 agent + master + 终端 + 管理；--guest 给别人的设备：独立身份、不含 master、无终端、无管理，agents 必须写明，
 * '*' 要在这里再确认一次或加 --confirm-all）。手输短码的设备会进「待确认」：这里轮询并提示 Y/n，
 * 生成码的人就在 Mac 前，点头才发凭据。扫码 / 点链接走挑战应答，不需要确认——码被消费掉即视为配好。
 */
import { toString as qrToString } from "qrcode";
import { bridgeHttpBase } from "../lib/bridge-port.js";
import type { Grant } from "../lib/devices.js";
import { isMasterAgent } from "../lib/registry.js";
import { output } from "./core.js";

interface PairInfo {
  ok: boolean; code: string; display: string; fragment: string; url: string | null; link: string | null; base: string | null; slug: string | null; fp: string;
  grant: Grant; guest?: string; expiresAt: string; error?: string;
}
interface Approval { id: string; code: string; deviceName: string; clientIp: string | null; grant: Grant; guest?: string }

const POLL_MS = 2000;
const GUEST_EXAMPLE = `例：claudestra pair --guest "Alex 的手机" --agents gc-car,relay`;
export const GUEST_ALL_WARNING = "给别人开放 '*' 等于开放全部非大总管 agent（以后新建的也算）";

const USAGE = "用法：claudestra pair [--agents a,b|*] [--no-terminal] [--no-manage] [--guest 名字 --agents a,b [--confirm-all]] [--url 入口] [--json]";
const VALUE_FLAGS = new Set(["--agents", "--guest", "--url"]);
const BOOL_FLAGS = new Set(["--no-terminal", "--no-manage", "--json", "--confirm-all"]);

/**
 * 逐个认参数：`--x v` 和 `--x=v` 都认；值位置上又是旗标（`--guest --agents a`）按没给值。不认识的旗标、多出来的词直接报错——
 * 打错一个字母（--Guest、--guest=… 写法没认出来）不能悄悄变成给自己签全权码。
 */
function readFlags(args: string[]): { values: Map<string, string>; given: Set<string>; error?: string } {
  const values = new Map<string, string>();
  const given = new Set<string>();
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    const eq = a.startsWith("--") ? a.indexOf("=") : -1;
    const name = eq > 0 ? a.slice(0, eq) : a;
    if (BOOL_FLAGS.has(a)) given.add(a);
    else if (VALUE_FLAGS.has(name)) {
      given.add(name);
      const v = eq > 0 ? a.slice(eq + 1) : args[i + 1]?.startsWith("--") ? undefined : args[++i];
      if (v !== undefined) values.set(name, v);
      else if (name !== "--guest") return { values, given, error: `${name} 后面要跟值。${USAGE}` }; // --guest 缺名字由调用方带示例报
    } else return { values, given, error: `不认识的参数 ${a}。${USAGE}` };
  }
  return { values, given };
}

export interface PairArgs {
  body: Record<string, unknown>;
  json: boolean;
  /** 本地就能判错的（不打 bridge） */
  error?: string;
  /** guest 要开放 '*' 且没带 --confirm-all：交互终端里再问一次，否则报错 */
  needsAllConfirm?: boolean;
}

export function parsePairArgs(args: string[]): PairArgs {
  const { values, given, error: flagError } = readFlags(args);
  const agents = values.get("--agents")?.split(",").map((s) => s.trim()).filter(Boolean);
  const guest = values.get("--guest")?.trim(); // 全空白的名字按没写：bridge 也拒（guest_name_required）
  const url = values.get("--url");
  const confirmAll = given.has("--confirm-all");
  const body = {
    ...(agents?.length ? { agents } : {}),
    ...(url ? { url } : {}),
    ...(given.has("--no-terminal") ? { terminal: false } : {}),
    ...(given.has("--no-manage") ? { manage: false } : {}),
    ...(guest ? { guest } : {}),
    ...(guest && confirmAll ? { confirmAllAgents: true } : {}),
  };
  const json = given.has("--json");
  if (flagError) return { body, json, error: flagError };
  // 没给名字的 --guest 不能悄悄变成给自己签全权码
  if (given.has("--guest") && !guest) return { body, json, error: `--guest 后面要写这台设备是给谁的。${GUEST_EXAMPLE}` };
  if (!guest) return { body, json };
  const named = (agents ?? []).filter((a) => !isMasterAgent(a));
  if (!named.length) return { body, json, error: `--guest 要用 --agents 写明开放哪些 agent（guest 默认一个都不开放，大总管不能给）。${GUEST_EXAMPLE}` };
  return { body, json, needsAllConfirm: named.includes("*") && !confirmAll };
}

/** 「全部非大总管 agent（以后新建的也算）」/「2 个 agent：gc-car、relay」：让发码、批准的人知道自己在给什么 */
function describeAgents(agents: string[]): string {
  const master = agents.some((a) => isMasterAgent(a));
  if (agents.includes("*")) return master ? "全部 agent（含大总管，以后新建的也算）" : "全部非大总管 agent（以后新建的也算）";
  const list = [...agents.filter((a) => !isMasterAgent(a)), ...(master ? ["大总管"] : [])];
  return list.length ? `${list.length} 个 agent：${list.join("、")}` : "（无）";
}

export function describeGrant(g: Grant, guest?: string): string {
  return `${guest ? `给「${guest}」的设备（独立身份）` : "你自己的设备"}：${describeAgents(g.agents)}；终端 ${g.terminal ? "开" : "关"}；管理 ${g.manage ? "开" : "关"}`;
}

async function readLine(prompt: string): Promise<string> {
  process.stdout.write(prompt);
  const line = await new Promise<string>((res) => {
    process.stdin.setEncoding("utf8");
    process.stdin.once("data", (d) => res(String(d)));
    process.stdin.resume(); // 前一次问完 pause 过：显式暂停的流挂 data 监听不会自己恢复
  });
  process.stdin.pause();
  return line;
}

/** 出错的结果：退出码非 0，脚本不用解析 JSON 也知道没签成 */
function fail(data: Record<string, unknown>): void {
  process.exitCode = 1;
  output({ ok: false, ...data });
}

async function post(path: string, body: unknown): Promise<Response> {
  return fetch(`${bridgeHttpBase()}${path}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(5000) });
}

export async function cmdPair(args: string[]): Promise<void> {
  const { body, json, error, needsAllConfirm } = parsePairArgs(args);
  if (error) return fail({ error });
  if (needsAllConfirm) {
    if (json || !process.stdin.isTTY) return fail({ error: `${GUEST_ALL_WARNING}。确定要这样就加 --confirm-all` });
    if (!/^\s*y/i.test(await readLine(`${GUEST_ALL_WARNING}。确定？[y/N] `))) {
      process.exitCode = 1;
      return void process.stdout.write("已取消，没有签码。\n");
    }
    body.confirmAllAgents = true;
  }
  let r: Response;
  try {
    r = await post("/relay/pair/new", body);
  } catch (e) {
    return fail({ error: `bridge 没有响应（${(e as Error).message}）——先确认 bridge 在跑：claudestra doctor` });
  }
  const fallback = { ok: false, error: `bridge 返回 ${r.status} 且不是 JSON——多半还在跑没有 /relay 路由的旧版本，重启 bridge 到新代码` };
  const info = (await r.json().catch(() => fallback)) as PairInfo; // 非 JSON 响应按失败：状态码与这句提示就是全部信息
  if (!info.ok && info.code) return fail({ error: info.error ?? "无法签发配对码" }); // 请求体被拒（guest 没写 agents 等），不是中继的事
  if (!info.ok) {
    return fail({ error: info.error ?? "无法签发配对码", hint: "在仓库根 .env 写 RELAY_URL=wss://<中继地址>（可选 RELAY_NAME=<子域名标签>），重启 bridge 后再跑 pair" });
  }
  if (json) return output({ ...info });
  const qr = info.link ? await qrToString(info.link, { type: "terminal", small: true }).catch(() => "") : ""; // 终端不支持时只少一张二维码，链接与短码照给
  const where = info.base ? `在 https://${info.base} 输入短码` : "在你打开这台机器网页的地方（http://<局域网 IP>:<bridge 端口>/ 或 Tailscale 地址）进入配对页输入短码";
  const lines = [
    info.link ? `用手机相机扫码，或在任何浏览器打开下面的链接，或${where}——三选一：` : `没连中继：${where}；要二维码 / 链接请加 --url <入口地址>`,
    "", qr.trimEnd(), "",
    ...(info.link ? [`链接：${info.link}`] : [`手动进配对页时也可直接打开 <入口地址>/pair#${info.fragment}`]), `短码：${info.display}`, "",
    `这条凭据的权限——${describeGrant(info.grant, info.guest)}`, `（缩小范围：--agents a,b  --no-terminal  --no-manage；给别人：--guest 名字 --agents a,b）`, "",
    ...(info.base ? [`这台机器在中继上的名字：${info.slug}（旧版网页：${info.url}）`] : []), `${new Date(info.expiresAt).toLocaleTimeString()} 前有效，只能用一次。`,
  ];
  process.stdout.write(lines.join("\n") + "\n"); // 人看的命令，bridge 从不调它（要机器可读加 --json）
  if (process.stdin.isTTY) await waitForApproval(info);
}

/** 轮询待确认：手输短码的设备出现就问一句；码被消费（扫码配对）或过期就收工 */
async function waitForApproval(info: PairInfo): Promise<void> {
  process.stdout.write("\n等待设备配对…（手输短码的设备会在这里请你确认；Ctrl-C 退出）\n");
  const deadline = Date.parse(info.expiresAt);
  while (Date.now() < deadline) {
    await new Promise((res) => setTimeout(res, POLL_MS));
    const r = await fetch(`${bridgeHttpBase()}/relay/pair/approvals`, { signal: AbortSignal.timeout(5000) }).catch(() => null); // bridge 一时不应答就下一拍再问
    type Poll = { approvals?: Approval[]; activeCodes?: string[] } | null;
    const j = r?.ok ? ((await r.json().catch(() => null)) as Poll) : null; // 非 JSON 也按「这一拍没读到」，下一拍再问
    if (!j) continue;
    const mine = j.approvals?.find((a) => a.code === info.code);
    if (mine) return decideInteractively(mine);
    if (j.activeCodes && !j.activeCodes.includes(info.code)) return void process.stdout.write("✓ 设备已通过扫码 / 链接配对。\n");
  }
  process.stdout.write("配对码已过期，没有设备配对。再跑一次 claudestra pair 即可。\n");
}

async function decideInteractively(a: Approval): Promise<void> {
  const all = a.guest && a.grant.agents.includes("*") ? `⚠️ ${GUEST_ALL_WARNING}\n` : "";
  const line = await readLine(`\n设备「${a.deviceName}」（${a.clientIp ?? "未知地址"}）输入了短码，请求配对：${describeGrant(a.grant, a.guest)}\n${all}确认？[Y/n] `);
  const approve = !/^\s*n/i.test(line);
  const r = await post("/relay/pair/approve", { id: a.id, approve });
  const j = (await r.json().catch(() => null)) as { ok?: boolean; state?: string; error?: string } | null; // 非 JSON 就按失败提示
  if (!j?.ok) process.exitCode = 1;
  process.stdout.write(j?.ok ? (approve ? "✓ 已批准，设备正在完成配对。\n" : "已拒绝。\n") : `处理失败：${j?.error ?? r.status}\n`);
}
