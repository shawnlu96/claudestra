/**
 * 设备凭据撤销要连带在途的流（docs/design-hosted-frontend.md §5）：光让下一次请求 401 不够——正在挂着的
 * SSE（/api/v1/events）与终端流会一直活到浏览器自己断。这里是进程内的撤销总线 + 一个把流式响应绑到凭据上的包装：
 * 凭据一撤，pipeTo 的 signal 中止，源流被 cancel（SSE 的 cleanup 照常跑），浏览器那头读到错误立刻断开。
 * Bearer 类身份没有 credential 字段，原样放行（token 吊销走 principals 的 disabled，下一次请求即拒）。
 */
import type { Principal } from "../lib/principals.js";

type Listener = (credentialId: string) => void;
const listeners = new Set<Listener>();

export function onCredentialRevoked(cb: Listener): () => void {
  listeners.add(cb);
  return () => void listeners.delete(cb);
}

export function emitCredentialRevoked(credentialId: string): void {
  for (const cb of [...listeners]) cb(credentialId);
}

/** 流式响应按请求内生效的凭据绑定；非流 / 非凭据身份原样返回 */
export function revocable(res: Response, principal: Principal): Response {
  const credentialId = principal.credential;
  if (!credentialId || !res.body) return res;
  const ctrl = new AbortController();
  const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>();
  const off = onCredentialRevoked((id) => {
    if (id === credentialId) ctrl.abort(new Error("credential revoked"));
  });
  res.body.pipeTo(writable, { signal: ctrl.signal }).catch(() => {
    // 撤销中止或浏览器断开都会让 pipeTo reject：流已经收场，两头都知道，没有别的事要做
  }).finally(off);
  return new Response(readable, { status: res.status, statusText: res.statusText, headers: res.headers });
}
