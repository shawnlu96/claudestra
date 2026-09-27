/**
 * 设备凭据的 HTTP 面（docs/design-hosted-frontend.md §3–§5）。
 * 公开端点（不带凭据）：签挑战、配对（二维码走挑战应答；手输短码进待确认队列）、轮询待确认结果、本机回环自动配对。
 * 管理端点（grant.manage）：列设备、撤销、待确认列表与决定。回环控制路由（manager CLI）在 relay-routes.ts 接线，逻辑在这里。
 * 凭据落 principals.json；挑战与待确认在内存（进程重启即失效，重新配对即可）。纯逻辑在 lib/devices.ts / lib/pairing-codes.ts。
 */
import { hostname } from "node:os";
import { instanceKeySync, keyFingerprint } from "../lib/instance-key.js";
import {
  Approvals, attachCredential, canManage, ChallengeStore, DEVICE_HEADER, deviceCookieHeader, ensureOwnerPrincipal, fullGrant, guestGrant, newGuestPrincipal,
  normalizeGrant, type Grant,
} from "../lib/devices.js";
import { readPrincipalsStrict, writePrincipals, type Principal } from "../lib/principals.js";
import { formatCode } from "../lib/relay-protocol.js";
import { apiJson, forbidden, INVALID_JSON, invalidJsonBody, readJsonBody } from "./api-respond.js";
import { emitCredentialRevoked } from "./credential-revocation.js";
import { relayClient } from "./relay-link.js";
import { issuePairingCode, redeemPairingByProof, redeemPairingCode } from "./relay-pairing.js";
import { requestContextOf, type RequestContext } from "./request-context.js";

const challenges = new ChallengeStore();
const approvals = new Approvals();
const MANAGE_MSG = "device management requires a credential with manage grant";
/** 单测把 principals.json 指到临时目录；生产不调 */
let principalsPath: string | undefined;
export function setDevicesPrincipalsPathForTest(path: string | undefined): void {
  principalsPath = path;
}

interface PairOutcome { token: string; principalId: string; credentialId: string; grant: Grant; expiresAt: string }
type Body = Record<string, unknown>;

function machineFp(): string | null {
  const k = instanceKeySync();
  return k ? keyFingerprint(k.publicKey) : null;
}

const str = (v: unknown, max = 64): string | undefined => (typeof v === "string" && v.trim() ? v.trim().slice(0, max) : undefined);

/** 凭据落盘：owner 的设备挂 owner:self；guest 新建一个 principal（不含 master、无终端、无管理） */
async function grantCredential(deviceName: string, grant: Grant, guest: string | undefined, ip: string | null): Promise<PairOutcome> {
  const file = await readPrincipalsStrict(principalsPath);
  const principal = guest ? newGuestPrincipal(guest, grant) : ensureOwnerPrincipal(file);
  if (guest) file.principals.push(principal);
  const { token, credential } = attachCredential(principal, deviceName, guest ? guestGrant(grant.agents) : grant, { ip });
  await writePrincipals(file, principalsPath);
  return { token, principalId: principal.id, credentialId: credential.id, grant: credential.grant, expiresAt: credential.expiresAt };
}

/** 直托管 Path=/；经中继 Path 写成 /m/<fp>/（中继还会再钉一次） */
function cookieFor(ctx: RequestContext, token: string | null): string {
  return deviceCookieHeader(token, { path: ctx.pathPrefix ? `${ctx.pathPrefix}/` : "/", secure: ctx.https || ctx.source === "relay" });
}

function pairedResponse(ctx: RequestContext, out: PairOutcome): Response {
  const res = apiJson(200, { ok: true, fp: machineFp(), machineName: hostname(), principalId: out.principalId, credentialId: out.credentialId, grant: out.grant, expiresAt: out.expiresAt });
  res.headers.append("set-cookie", cookieFor(ctx, out.token));
  res.headers.set("cache-control", "no-store");
  return res;
}

function pairFailure(reason: "invalid" | "expired" | "rate_limited"): Response {
  const error = reason === "expired" ? "code expired" : reason === "rate_limited" ? "too many attempts, wait a minute" : "code invalid";
  return apiJson(reason === "rate_limited" ? 429 : 400, { ok: false, error, code: reason });
}

// ── 公开端点 ──────────────────────────────────────────────────────────────

export async function handleDevicesPublic(req: Request, url: URL): Promise<Response | null> {
  const p = url.pathname;
  if (p === "/api/v1/devices/pair/challenge" && req.method === "GET") {
    return apiJson(200, { ok: true, ...challenges.issue(), fp: machineFp(), machineName: hostname() });
  }
  if (p === "/api/v1/devices/pair" && req.method === "POST") return pair(req);
  if (p === "/api/v1/devices/pair/status" && req.method === "GET") return pairStatus(req, url);
  if (p === "/api/v1/devices/local" && req.method === "POST") return pairLocal(req);
  return null;
}

/** 二维码：{proof:{challenge,hmac}} 直接发凭据；手输：{code} 进待确认，Mac 侧点头才发 */
async function pair(req: Request): Promise<Response> {
  const ctx = requestContextOf(req);
  const body = await readJsonBody(req);
  if (body === INVALID_JSON) return invalidJsonBody();
  const b = (body ?? {}) as Body & { proof?: Body };
  const deviceName = str(b.deviceName) ?? "device";
  if (b.proof && typeof b.proof.challenge === "string" && typeof b.proof.hmac === "string") {
    if (!challenges.consume(b.proof.challenge)) return apiJson(400, { ok: false, error: "challenge invalid or expired", code: "challenge_invalid" });
    const r = redeemPairingByProof(relayClient(), b.proof.challenge, b.proof.hmac);
    if (!r.ok) return pairFailure(r.reason);
    return pairedResponse(ctx, await grantCredential(deviceName, r.grant, r.guest, ctx.clientIp));
  }
  if (typeof b.code === "string") {
    const r = redeemPairingCode(relayClient(), b.code);
    if (!r.ok) return pairFailure(r.reason);
    const a = approvals.add({ code: r.code, deviceName, clientIp: ctx.clientIp, grant: r.grant, guest: r.guest });
    return apiJson(202, { ok: true, pending: true, approvalId: a.id, expiresAt: new Date(a.expiresAt).toISOString(), machineName: hostname() });
  }
  return apiJson(400, { ok: false, error: '"code" or "proof" required' });
}

/** 浏览器轮询待确认：批准的结果只给一次 */
function pairStatus(req: Request, url: URL): Response {
  const t = approvals.take(url.searchParams.get("approval") ?? "");
  if (t.state === "pending") return apiJson(202, { ok: true, state: "pending" });
  if (t.state !== "approved") return apiJson(410, { ok: false, state: t.state, error: t.state === "denied" ? "pairing denied on the machine" : "approval expired" });
  return pairedResponse(requestContextOf(req), { ...t.result, grant: t.approval.grant });
}

/** 本机浏览器：只认真实回环 socket（经中继 dispatch 的 source 是 relay，进不来）+ 自定义头 + 同源 */
async function pairLocal(req: Request): Promise<Response> {
  const ctx = requestContextOf(req);
  if (ctx.source !== "loopback") return forbidden("local pairing is only available from this machine");
  if (!req.headers.get(DEVICE_HEADER)) return forbidden(`${DEVICE_HEADER} header required`);
  const origin = req.headers.get("origin");
  if (origin && origin !== new URL(req.url).origin) return forbidden("cross-origin local pairing refused");
  const body = await readJsonBody(req);
  const deviceName = str((body === INVALID_JSON || !body ? {} : (body as Body)).deviceName) ?? "本机浏览器";
  return pairedResponse(ctx, await grantCredential(deviceName, fullGrant(), undefined, ctx.clientIp));
}

// ── 管理端点 ──────────────────────────────────────────────────────────────

export async function handleDevicesManaged(req: Request, url: URL, principal: Principal): Promise<Response | null> {
  const p = url.pathname;
  if (!p.startsWith("/api/v1/devices")) return null;
  if (p === "/api/v1/devices" && req.method === "GET") return canManage(principal) ? listDevices(principal) : forbidden(MANAGE_MSG);
  const del = p.match(/^\/api\/v1\/devices\/(dev_[0-9a-f]+)$/);
  if (del && req.method === "DELETE") return revokeDevice(req, principal, del[1]);
  if (p === "/api/v1/devices/approvals" && req.method === "GET") {
    return canManage(principal) ? apiJson(200, { ok: true, approvals: pendingApprovals() }) : forbidden(MANAGE_MSG);
  }
  const dec = p.match(/^\/api\/v1\/devices\/approvals\/([A-Za-z0-9_-]+)$/);
  if (dec && req.method === "POST") {
    if (!canManage(principal)) return forbidden(MANAGE_MSG);
    const body = await readJsonBody(req);
    if (body === INVALID_JSON) return invalidJsonBody();
    const r = await decideApproval(dec[1], (body as Body)?.approve === true);
    return apiJson(r ? 200 : 404, r ?? { ok: false, error: "approval not found or already decided" });
  }
  return null;
}

async function listDevices(principal: Principal): Promise<Response> {
  const file = await readPrincipalsStrict(principalsPath);
  const devices = file.principals.flatMap((p) => (p.credentials ?? []).map((c) => ({
    id: c.id, deviceName: c.deviceName, principal: p.id, principalName: p.name ?? p.id, grant: c.grant, createdAt: c.createdAt,
    lastSeenAt: c.lastSeenAt ?? null, lastIp: c.lastIp ?? null, expiresAt: c.expiresAt, disabled: !!c.disabled, current: c.id === principal.credential,
  })));
  return apiJson(200, { ok: true, devices });
}

/** 撤销：有 manage 的能撤任何一条；任何设备都能撤自己这条（= 退出登录）。guest 撤到最后一条就停用那个 principal */
async function revokeDevice(req: Request, principal: Principal, id: string): Promise<Response> {
  const own = principal.credential === id;
  if (!own && !canManage(principal)) return forbidden(MANAGE_MSG);
  const file = await readPrincipalsStrict(principalsPath);
  const holder = file.principals.find((p) => (p.credentials ?? []).some((c) => c.id === id));
  if (!holder) return apiJson(404, { ok: false, error: "device not found" });
  holder.credentials = (holder.credentials ?? []).filter((c) => c.id !== id);
  if (holder.id.startsWith("guest:") && holder.credentials.length === 0) holder.disabled = true;
  await writePrincipals(file, principalsPath);
  emitCredentialRevoked(id); // 在途的 SSE / 终端流随之中止
  const res = apiJson(200, { ok: true, revoked: id, principal: holder.id });
  if (own) res.headers.append("set-cookie", cookieFor(requestContextOf(req), null));
  return res;
}

// ── 回环控制路由与管理端点共用 ─────────────────────────────────────────────

export function pendingApprovals(): Array<Record<string, unknown>> {
  return approvals.pending().map((a) => ({
    id: a.id, code: a.code, deviceName: a.deviceName, clientIp: a.clientIp, grant: a.grant, ...(a.guest ? { guest: a.guest } : {}),
    createdAt: new Date(a.createdAt).toISOString(), expiresAt: new Date(a.expiresAt).toISOString(),
  }));
}

/** Mac 侧的决定：批准就此刻签凭据挂进待确认，浏览器下次轮询取走 */
export async function decideApproval(id: string, approve: boolean): Promise<Record<string, unknown> | null> {
  const a = approvals.get(id);
  if (!a || a.state !== "pending") return null;
  if (!approve) return approvals.decide(id, false) ? { ok: true, id, state: "denied" } : null;
  const out = await grantCredential(a.deviceName, a.grant, a.guest, a.clientIp);
  approvals.decide(id, true, { token: out.token, credentialId: out.credentialId, principalId: out.principalId, expiresAt: out.expiresAt });
  return { ok: true, id, state: "approved", credentialId: out.credentialId, principalId: out.principalId, deviceName: a.deviceName };
}

/**
 * `claudestra pair` 的签码：grant 由 CLI 给（默认全权；--guest 给别人的设备）；短码给中继（连着的话），秘密只进链接的 # 片段。
 * 没连中继也能签（直托管入口）：link 要有入口地址才拼得出（CLI 的 --url），否则只给短码与 fragment 让用户手动进配对页。
 */
export function issuePairing(i: { url?: string | null; base?: string | null; slug?: string | null; fp?: string | null }, body: Body): Record<string, unknown> {
  const fp = i.fp ?? machineFp();
  if (!fp) return { ok: false, error: "本机没有实例密钥（instance-key.pem 读写失败），签不了配对码" };
  const guest = str(body.guest);
  const grant = normalizeGrant(body as Partial<{ agents: unknown; terminal: unknown; manage: unknown }>, guest ? guestGrant(["*"]) : fullGrant());
  const r = issuePairingCode(relayClient(), guest ? guestGrant(grant.agents) : grant, guest);
  const entry = str(body.url, 256)?.replace(/\/+$/, "") ?? (i.base ? `https://${i.base}` : null);
  const fragment = `${fp}.${r.secret}`;
  return {
    ok: true, code: r.code, display: formatCode(r.code), fragment, link: entry ? `${entry}/pair#${fragment}` : null,
    url: i.url ? `${i.url}/pair#${r.code}` : null, base: i.base ?? null, slug: i.slug ?? null, fp, grant: r.grant, ...(guest ? { guest } : {}),
    expiresAt: new Date(r.expiresAt).toISOString(),
  };
}
