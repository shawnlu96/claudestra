/**
 * 设备凭据与配对（docs/design-hosted-frontend.md §13.1）。配对时机器还没进清单，所以每个调用都显式传 {fp}：
 * 中继模式打 `/m/<fp>/api/v1/devices/…`，直托管打同源。成功响应带 Set-Cookie，api() 的 credentials:"include" 让浏览器收下它。
 */
import { defaultDeviceName } from "@/lib/pairing";
import type { ShareOpts } from "@/lib/guest-share";
import { api, apiRaw, apiErrorFrom, type ApiError } from "./client";

export interface PairedInfo {
  fp: string;
  machineName: string;
  principalId: string;
  credentialId: string;
  grant: { agents: string[] | "*"; master?: boolean; terminal?: boolean; manage?: boolean };
  expiresAt: string;
}

export interface DeviceInfo {
  id: string;
  deviceName: string;
  principal: string;
  principalName: string;
  grant: PairedInfo["grant"];
  createdAt: string;
  lastSeenAt?: string | null;
  lastIp?: string | null;
  expiresAt?: string;
  /** 就是本浏览器这一条 */
  current?: boolean;
  /** 审计：谁签的配对码 / 谁批准的（凭据 id；"cli" = 电脑终端） */
  issuedBy?: string | null;
  approvedBy?: string | null;
}

const m = (fp: string) => ({ fp });

export function pairChallenge(fp: string): Promise<{ challenge: string; expiresAt: string; fp: string | null; machineName: string }> {
  return api("/devices/pair/challenge", {}, m(fp));
}

export function pairWithProof(fp: string, proof: { challenge: string; hmac: string }, deviceName: string): Promise<PairedInfo> {
  return api<PairedInfo>("/devices/pair", { method: "POST", json: { proof, deviceName } }, m(fp));
}

export function pairWithCode(fp: string, code: string, deviceName: string): Promise<{ pending: true; approvalId: string; expiresAt: string; machineName: string }> {
  return api("/devices/pair", { method: "POST", json: { code, deviceName } }, m(fp));
}

export type ApprovalStatus = { state: "pending" } | { state: "paired"; info: PairedInfo } | { state: "denied" | "expired" };

/** 202 = 还在等 Mac 侧点头；200 = 发凭据了；410 = 拒绝 / 过期 */
export async function pairStatus(fp: string, approvalId: string, signal?: AbortSignal): Promise<ApprovalStatus> {
  const res = await apiRaw(`/devices/pair/status?approval=${encodeURIComponent(approvalId)}`, { signal }, m(fp));
  if (res.status === 202) return { state: "pending" };
  const body = (await res.json().catch(() => ({}))) as Record<string, unknown>; // 空体 / 非 JSON 按空对象，下面按状态码判
  if (res.status === 410) return { state: body.state === "denied" ? "denied" : "expired" };
  if (!res.ok) throw apiErrorFrom(res.status, body, fp);
  return { state: "paired", info: body as unknown as PairedInfo };
}

/**
 * 直托管开机时把凭据备好，返回最后有没有凭据。先探 whoami：已有凭据就什么都不做。没有时：
 *   从旧 web 服务升上来的浏览器还带着旧登录 cookie（cstra_session，HttpOnly 看不见）→ 一次性换成设备凭据（POST /devices/legacy-session）。
 * 本机回环不再自动配对：全权要在别的已配对设备上批准（bridge/devices.ts pairLocal），开机自动发会每次刷新都推一条待批；
 * 拿不到就由 MachineGate 带去 /pair，点「一键配对本机」才发。
 * 这里故意不走 api()/apiRaw()：那两个遇 401 会把机器标成「需重新配对」，而这里的 401 是预期的探测结果。
 */
export async function ensureDirectCredential(): Promise<boolean> {
  const deviceName = defaultDeviceName(navigator.userAgent, navigator.platform);
  try {
    const who = await fetch("/api/v1/whoami", { credentials: "include", cache: "no-store" });
    if (who.status !== 401) return who.ok;
    const r = await fetch("/api/v1/devices/legacy-session", {
      method: "POST", credentials: "include", cache: "no-store",
      headers: { "Content-Type": "application/json", "x-cstra-device": "1" },
      body: JSON.stringify({ deviceName }),
    });
    return r.ok;
  } catch (e) {
    console.warn("[pair] 直托管自动取凭据失败，按普通配对处理:", (e as Error).message);
    return false;
  }
}

export interface LocalPending {
  pending: true;
  approvalId: string;
  /** 8 位展示码：批准的设备上会显示同一个，对得上再允许 */
  code: string;
  machineName: string;
}

/** 直托管 + 本机回环：一键配对。bridge 带控制 token 才直接签（网页没有）；否则 202 进待批，拿 approvalId 轮询 pairStatus */
export function pairLocal(fp: string, deviceName: string): Promise<PairedInfo | LocalPending> {
  return api<PairedInfo | LocalPending>("/devices/local", { method: "POST", json: { deviceName } }, m(fp));
}

/** 中继的短码查找（不在任何机器的基址下，直接打同源）；404 code_invalid / 429 rate_limited 抛 ApiError */
export async function codeLookup(code: string): Promise<{ fp: string; name: string; slug: string }> {
  const res = await fetch("/api/v1/codes/lookup", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ code }),
    cache: "no-store",
    credentials: "omit",
  });
  const body = (await res.json().catch(() => ({}))) as Record<string, unknown>; // 非 JSON（反代错页）按空体，下面按状态码报错
  if (!res.ok) throw apiErrorFrom(res.status === 401 ? 502 : res.status, body, "");
  return body as unknown as { fp: string; name: string; slug: string };
}

export async function listDevices(): Promise<DeviceInfo[]> {
  return (await api<{ devices?: DeviceInfo[] }>("/devices")).devices ?? [];
}

/** 撤销一条凭据；撤自己那条 = 退出登录（bridge 顺手回删 cookie） */
export function revokeDevice(id: string): Promise<void> {
  return api(`/devices/${encodeURIComponent(id)}`, { method: "DELETE" }).then(() => undefined);
}

/** 退出登录：撤这次请求用的那条设备凭据，不用 manage、不用先拉列表（guest 拿不到列表）；bridge 同样回删 cookie */
export function revokeCurrentDevice(): Promise<void> {
  return api("/devices/current", { method: "DELETE" }).then(() => undefined);
}

// ── 在网页里发配对码、批准别的设备（要 manage；bridge/local-api/control.ts 与 devices.ts 的管理端点）──

/** 手输短码等着这台机器点头的设备 */
export interface PendingApproval {
  id: string;
  code: string;
  deviceName: string;
  clientIp: string | null;
  grant: PairedInfo["grant"];
  guest?: string;
  /** 本机浏览器请求全权（这台电脑自己的浏览器；本机的 agent 也能冒充，码对得上再允许） */
  local?: boolean;
  expiresAt: string;
}

/** activeCodes：还没被用掉的码（旧 bridge 不给 → undefined，调用方就不判「已被扫码配走」） */
export async function listApprovals(): Promise<{ approvals: PendingApproval[]; activeCodes?: string[] }> {
  const j = await api<{ approvals?: PendingApproval[]; activeCodes?: string[] }>("/devices/approvals", { timeoutMs: 5000 });
  return { approvals: j.approvals ?? [], activeCodes: j.activeCodes };
}

export function decideApproval(id: string, approve: boolean): Promise<void> {
  return api(`/devices/approvals/${encodeURIComponent(id)}`, { method: "POST", json: { approve } }).then(() => undefined);
}

export interface ShareCode {
  code: string;
  display: string;
  /** 扫码 / 点开即配好的链接（入口 + /pair#<指纹>.<秘密>） */
  link: string;
  expiresAt: string;
}

/**
 * 签一个配对码。guest = 给别人的设备（独立身份、只含选中的会话、无终端无管理），不给就是自己的设备（全权）。
 * guest 的请求体由 guestShareOpts 拼（名字、agents 必须写明，"*" 还要 confirmAllAgents）。
 * link：bridge 知道入口时给（中继首页）；没给就用当前页面的 origin 拼——前端就托管在这个源上。老 bridge 只有 url（子域名）。
 */
export async function newShareCode(opts: ShareOpts = {}): Promise<ShareCode> {
  type R = { ok?: boolean; error?: string; code?: string; display?: string; link?: string | null; fragment?: string; url?: string | null; expiresAt?: string };
  const j = await api<R>("/relay/pair", { method: "POST", json: opts, timeoutMs: 5000 });
  const link = j.link || (j.fragment ? `${window.location.origin}/pair#${j.fragment}` : j.url);
  if (!j.ok || !j.code || !link) throw new Error(j.error || "配对码生成失败");
  return { code: j.code, display: j.display ?? j.code, link, expiresAt: j.expiresAt ?? "" };
}

/** 配对页给用户看的错误文案（中文 key，渲染点 t() 兜底翻译）。local = 本机一键配对那条路径：只有它的 403 意味着「不是本机」 */
export function pairErrorText(e: unknown, local = false): string {
  const err = e as ApiError & { code?: string };
  switch (err?.code) {
    case "code_invalid":
      return "配对码无效或已过期，请重新生成一个";
    case "challenge_invalid":
      return "链接已过期，请重新生成二维码";
    case "rate_limited":
      return "尝试太频繁，请稍后再试";
    case "machine_unknown":
      return "这台机器没有连上中继";
    case "no_machine":
      return "还没有选择机器";
    case "no_approver":
      return "还没有能批准的已配对设备：在电脑终端运行 claudestra pair";
  }
  if (err?.status === 403) return local ? "只能在电脑本机的浏览器里一键配对" : "配对请求被这台机器拒绝了";
  return err?.message || "配对失败";
}
