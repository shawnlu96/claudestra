/**
 * BFF 路由的公共样板（server-side only）：鉴权 → 代理 bridge → 错误映射。
 *
 * 为什么（2026-09-23 D8-10 / D6-4）：几十个 route 各抄一遍「未登录 401 + catch 一律 502」，
 * bridge 明确给出的 4xx（404 没这个 agent、409 回合中/已在进行）和 retryable 标记全被
 * 抹成 502，前端只能一律显示「失败」，clear 路由甚至要靠正则从错误文案里猜 409。
 *
 * 映射口径：
 *  - bridge 401 → 502：那是 BFF 自己的 token 配错了，不是用户没登录；透传 401 前端会跳登录页。
 *  - 其余 4xx 原样透传，body 带上 bridge 给的字段（如 409 的 runId）。
 *  - retryable 或 503 → 503（链路重连中，前端可以稍后再试）。
 *  - 其它（网络不通、超时、5xx）→ 502。
 */
import { NextResponse } from "next/server";
import { isAuthed } from "@/lib/api-auth";
import { bridgeGet, bridgePost, type BridgeError } from "@/lib/chat/bridge-api";

/** handler 里抛它 = 直接回这个状态码（参数校验失败等，不经 bridge 错误映射） */
export class HttpError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

export function unauthorized(): NextResponse {
  return NextResponse.json({ error: "未登录" }, { status: 401 });
}

/** 纯函数：bridge 错误 → 该回给浏览器的状态码（单测锁口径） */
export function bridgeErrorStatus(e: unknown): number {
  const err = e as BridgeError | undefined;
  const st = typeof err?.status === "number" ? err.status : 0;
  if (st === 401) return 502;
  if (st >= 400 && st < 500) return st;
  if (err?.retryable || st === 503) return 503;
  return 502;
}

export function bridgeErrorResponse(e: unknown, prefix = ""): NextResponse {
  const err = e as BridgeError | undefined;
  const status = bridgeErrorStatus(e);
  const msg = `${prefix}${err?.message ?? String(e)}`;
  // 透传的 4xx 带上 bridge 的原始字段；401 映射成 502 时不带（里面是 token 层的信息）
  const extra = status >= 400 && status < 500 && err?.body ? err.body : {};
  return NextResponse.json(
    { ...extra, ok: false, error: msg, ...(err?.retryable ? { retryable: true } : {}) },
    { status },
  );
}

/**
 * 包一层：未登录回 401，handler 抛出的错误走 bridgeErrorResponse。
 * 用法：`export const POST = authed(async (req) => NextResponse.json(await bridgePost(...)))`
 * （`export const runtime = "nodejs"` 仍须写在每个 route 文件里，Next 只认字面导出）
 */
export function authed<A extends unknown[]>(
  handler: (req: Request, ...rest: A) => Promise<Response>,
  opts?: { errorPrefix?: string },
): (req: Request, ...rest: A) => Promise<Response> {
  return async (req: Request, ...rest: A) => {
    if (!(await isAuthed(req))) return unauthorized();
    try {
      return await handler(req, ...rest);
    } catch (e) {
      if (e instanceof HttpError) return NextResponse.json({ error: e.message }, { status: e.status });
      return bridgeErrorResponse(e, opts?.errorPrefix);
    }
  };
}

/** 纯代理 GET：bridge 的 JSON 原样回给浏览器 */
export function proxyGet(path: string, opts?: { timeoutMs?: number }) {
  return authed(async () => NextResponse.json(await bridgeGet(path, opts)));
}

/** 纯代理 POST：浏览器的 JSON body 原样转给 bridge（解析失败当空对象） */
export function proxyPost(path: string, opts?: { timeoutMs?: number }) {
  return authed(async (req) => NextResponse.json(await bridgePost(path, await req.json().catch(() => ({})), opts)));
}

/** agents/{kill,restart,remove}：body {name} → POST /agents/:name/<action> */
export function agentAction(action: "kill" | "restart" | "remove", timeoutMs: number) {
  return authed(async (req) => {
    const { name } = (await req.json().catch(() => ({}))) as { name?: unknown };
    if (!name || typeof name !== "string") throw new HttpError(400, "name 不能为空");
    return NextResponse.json(
      await bridgePost(`/agents/${encodeURIComponent(name.trim())}/${action}`, {}, { timeoutMs }),
    );
  });
}
