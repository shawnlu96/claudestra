/** 入站正文的字节与绝对时限：peer 验签预读和提前拒绝后的排空共用，滴流不会续期。 */
export const MAX_PEER_BODY = 2 * 1024 * 1024;
/** 网页还要上传 20MB 语音；listener 的兜底不能用 peer 的 2MB 限制。 */
export const MAX_HTTP_BODY = 32 * 1024 * 1024;
export const BODY_DEADLINE_MS = 1_000;

export class RequestBodyError extends Error {
  constructor(readonly status: 408 | 413 | 400, readonly code: string) { super(code); }
}

/** collect=false 只排空不保留；取消不 await，底层上传不结束也不能拖住拒绝响应。 */
export async function readBoundedRequestBody(req: Request, cap: number, deadlineMs = BODY_DEADLINE_MS, collect = true): Promise<Uint8Array> {
  if (!req.body) return new Uint8Array();
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const until = Date.now() + deadlineMs;
  const expired = new Promise<null>((resolve) => { timer = setTimeout(() => resolve(null), deadlineMs); });
  try {
    if (Number(req.headers.get("content-length")) > cap) throw new RequestBodyError(413, "body_too_large");
    for (;;) {
      if (Date.now() >= until) throw new RequestBodyError(408, "body_timeout");
      const next = await Promise.race([reader.read(), expired]);
      if (!next) throw new RequestBodyError(408, "body_timeout");
      if (next.done) break;
      size += next.value.byteLength;
      if (size > cap) throw new RequestBodyError(413, "body_too_large");
      if (collect) chunks.push(next.value);
    }
    return collect ? new Uint8Array(Buffer.concat(chunks, size)) : new Uint8Array();
  } catch (e) {
    void reader.cancel().catch((err) => console.warn(`[bridge] 取消请求正文失败: ${String(err)}`));
    throw e instanceof RequestBodyError ? e : new RequestBodyError(400, "body_unreadable");
  } finally {
    clearTimeout(timer);
    reader.releaseLock();
  }
}
