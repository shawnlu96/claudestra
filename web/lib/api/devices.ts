/**
 * 设备凭据与配对（docs/design-hosted-frontend.md §13.1）。配对时机器还没进清单，所以每个调用都显式传 {fp}：
 * 中继模式打 `/m/<fp>/api/v1/devices/…`，直托管打同源。成功响应带 Set-Cookie，api() 的 credentials:"include" 让浏览器收下它。
 */
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

/** 直托管 + 本机回环：一键配对（bridge 只认真实回环 socket + x-cstra-device 头） */
export function pairLocal(fp: string, deviceName: string): Promise<PairedInfo> {
  return api<PairedInfo>("/devices/local", { method: "POST", json: { deviceName } }, m(fp));
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

/** 配对页给用户看的错误文案（中文 key，渲染点 t() 兜底翻译） */
export function pairErrorText(e: unknown): string {
  const err = e as ApiError & { code?: string };
  switch (err?.code) {
    case "code_invalid":
      return "配对码无效或已过期，请在电脑上重新运行 claudestra pair";
    case "challenge_invalid":
      return "链接已过期，请在电脑上重新生成二维码";
    case "rate_limited":
      return "尝试太频繁，请稍后再试";
    case "machine_unknown":
      return "这台机器没有连上中继";
    case "no_machine":
      return "还没有选择机器";
  }
  if (err?.status === 403) return "只能在电脑本机的浏览器里一键配对";
  return err?.message || "配对失败";
}
