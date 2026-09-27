/**
 * `claudestra pair [--agents a,b|*] [--no-terminal] [--no-manage] [--guest <名字>] [--json]`（docs/design-hosted-frontend.md §4）：
 * 让 bridge 签一组配对码，打印二维码 / 链接 / 短码，并**明确打印这条凭据的 grant**（默认全权：所有 agent + master + 终端 + 管理；
 * --guest 给别人的设备：独立身份、不含 master、无终端、无管理）。手输短码的设备会进「待确认」：这里轮询并提示 Y/n，
 * 生成码的人就在 Mac 前，点头才发凭据。扫码 / 点链接走挑战应答，不需要确认——码被消费掉即视为配好。
 */
import { toString as qrToString } from "qrcode";
import { bridgeHttpBase } from "../lib/bridge-port.js";
import type { Grant } from "../lib/devices.js";
import { output } from "./core.js";

interface PairInfo {
  ok: boolean; code: string; display: string; url: string; link: string; base: string; slug: string; fp: string;
  grant: Grant; guest?: string; expiresAt: string; error?: string;
}
interface Approval { id: string; code: string; deviceName: string; clientIp: string | null; grant: Grant; guest?: string }

const POLL_MS = 2000;

function flagValue(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}

export function parsePairArgs(args: string[]): { body: Record<string, unknown>; json: boolean } {
  const agents = flagValue(args, "--agents");
  const guest = flagValue(args, "--guest");
  return {
    json: args.includes("--json"),
    body: {
      ...(agents ? { agents: agents.split(",").map((s) => s.trim()).filter(Boolean) } : {}),
      ...(args.includes("--no-terminal") ? { terminal: false } : {}),
      ...(args.includes("--no-manage") ? { manage: false } : {}),
      ...(guest ? { guest } : {}),
    },
  };
}

export function describeGrant(g: Grant, guest?: string): string {
  const agents = g.agents.includes("*") ? `所有普通 agent${g.agents.includes("master") ? " + 大总管" : ""}` : g.agents.join(", ") || "（无）";
  return `${guest ? `给「${guest}」的设备（独立身份）` : "你自己的设备"}：${agents}；终端 ${g.terminal ? "开" : "关"}；管理 ${g.manage ? "开" : "关"}`;
}

async function post(path: string, body: unknown): Promise<Response> {
  return fetch(`${bridgeHttpBase()}${path}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(5000) });
}

export async function cmdPair(args: string[]): Promise<void> {
  const { body, json } = parsePairArgs(args);
  let r: Response;
  try {
    r = await post("/relay/pair/new", body);
  } catch (e) {
    return output({ ok: false, error: `bridge 没有响应（${(e as Error).message}）——先确认 bridge 在跑：claudestra doctor` });
  }
  const fallback = { ok: false, error: `bridge 返回 ${r.status} 且不是 JSON——多半还在跑没有 /relay 路由的旧版本，重启 bridge 到新代码` };
  const info = (await r.json().catch(() => fallback)) as PairInfo; // 非 JSON 响应按失败：状态码与这句提示就是全部信息
  if (!info.ok) {
    return output({ ok: false, error: info.error ?? "无法签发配对码", hint: "在仓库根 .env 写 RELAY_URL=wss://<中继地址>（可选 RELAY_NAME=<子域名标签>），重启 bridge 后再跑 pair" });
  }
  if (json) return output({ ...info });
  const qr = await qrToString(info.url, { type: "terminal", small: true }).catch(() => ""); // 终端不支持时只少一张二维码，链接与短码照给
  const lines = [
    `用手机相机扫码，或在任何浏览器打开下面的链接，或在 https://${info.base} 输入短码——三选一：`, "", qr.trimEnd(), "",
    `链接：${info.url}`, `短码：${info.display}`, "",
    `这条凭据的权限——${describeGrant(info.grant, info.guest)}`, `（缩小范围：--agents a,b  --no-terminal  --no-manage；给别人：--guest 名字）`, "",
    `这台机器的网页：https://${info.slug}.${info.base}`, `${new Date(info.expiresAt).toLocaleTimeString()} 前有效，只能用一次。`,
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
  process.stdout.write(`\n设备「${a.deviceName}」（${a.clientIp ?? "未知地址"}）输入了短码，请求配对：${describeGrant(a.grant, a.guest)}\n确认？[Y/n] `);
  const line = await new Promise<string>((res) => {
    process.stdin.setEncoding("utf8");
    process.stdin.once("data", (d) => res(String(d)));
  });
  const approve = !/^\s*n/i.test(line);
  const r = await post("/relay/pair/approve", { id: a.id, approve });
  const j = (await r.json().catch(() => null)) as { ok?: boolean; state?: string; error?: string } | null; // 非 JSON 就按失败提示
  process.stdout.write(j?.ok ? (approve ? "✓ 已批准，设备正在完成配对。\n" : "已拒绝。\n") : `处理失败：${j?.error ?? r.status}\n`);
  process.stdin.pause();
}
