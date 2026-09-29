/**
 * 有上限地读对方（peer、中继）给的响应正文：对方可以灌无限的字节、用空段或一字节一字节地挂着不结束。
 *   - 只有非空的一段才算「有动静」、才重置空闲计时；空段不算（中继能发 b64:"" 的 data 帧）；
 *   - 另有一个与动静无关的总时限：一字节一字节地喂也撑不过它；
 *   - 超时、超限、调用方回调抛错都先 cancel 底层流（中继那头随之发 cancel）再往外抛。
 * 用在 lib/peer-e2e-client.ts（E2E 记录流、hello 回复、外层错误体）与 legacy 明文 peer 的 JSON 响应（readJsonCapped）。
 */
import { E2E_RESPONSE_MAX } from "./peer-e2e-wire.js";

/** 两段非空字节之间最多等多久：收方是整段封好 / 整段 JSON 才回的，正常不会停顿 */
const BODY_IDLE_MS = 30_000;
/** 响应头到了之后读完正文的总时限：8 MiB 在 100 KB/s 的慢链路上约 80 秒，给到 120 秒 */
const BODY_TOTAL_MS = 120_000;

export interface BodyLimits {
  idleMs?: number;
  totalMs?: number;
}

export class BodyTimeoutError extends Error {
  constructor(readonly kind: "idle" | "total") {
    super(kind === "idle" ? "response body stalled" : "response body took too long");
    this.name = "BodyTimeoutError";
  }
}

/** 把正文逐段（只给非空段）交给 onChunk；空闲或总时限到了抛 BodyTimeoutError */
export async function drainBody(res: Response, onChunk: (c: Uint8Array) => Promise<void> | void, limits: BodyLimits = {}): Promise<void> {
  if (!res.body) return;
  const idleMs = limits.idleMs ?? BODY_IDLE_MS;
  const deadline = Date.now() + (limits.totalMs ?? BODY_TOTAL_MS);
  let idleAt = Date.now() + idleMs;
  const reader = res.body.getReader();
  try {
    for (;;) {
      const kind = idleAt <= deadline ? "idle" : "total";
      let timer: ReturnType<typeof setTimeout> | undefined;
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new BodyTimeoutError(kind)), Math.max(0, Math.min(idleAt, deadline) - Date.now()));
      });
      const { done, value } = await Promise.race([reader.read(), timeout]).finally(() => clearTimeout(timer));
      if (done) return;
      if (!value.length) continue; // 空段不算动静：不重置空闲计时，也不交给调用方
      idleAt = Date.now() + idleMs;
      await onChunk(value);
    }
  } catch (e) {
    await reader.cancel().catch(() => {}); // 流已经出错或已关：cancel 失败说明没什么可停的了
    throw e;
  }
}

/**
 * 有上限的字节累加器：一块连续内存成倍扩容，每段拷进去就丢，不按分片留对象。对方用合法的单字节分片灌满上限时，
 * 若一段留一个 Uint8Array，8 MiB 以内就是几百万个对象；这里分配次数只随 log(总字节) 增长（tests/body-reader.test.ts）。
 */
export class CappedBytes {
  private buf = new Uint8Array(0);
  private n = 0;
  /** 扩容（重新分配）次数，测试用来断言不是一段一个对象 */
  allocs = 0;
  constructor(private readonly max: number) {}
  push(c: Uint8Array): void {
    const need = this.n + c.length;
    if (need > this.max) throw new RangeError("response over cap");
    if (need > this.buf.length) {
      const next = new Uint8Array(Math.min(this.max, Math.max(need, this.buf.length * 2, 16 * 1024)));
      next.set(this.buf.subarray(0, this.n));
      this.buf = next;
      this.allocs++;
    }
    this.buf.set(c, this.n);
    this.n = need;
  }
  bytes(): Uint8Array {
    return this.buf.subarray(0, this.n);
  }
}

/** 有上限地读一段 JSON；超限、超时、流出错、不是 JSON 都返回 null（调用方按「回复坏了 / 不是 JSON」处理，状态码照样判） */
export async function readJsonCapped(res: Response, max: number = E2E_RESPONSE_MAX, limits: BodyLimits = {}): Promise<unknown> {
  const acc = new CappedBytes(max);
  try {
    await drainBody(res, (c) => acc.push(c), limits);
    return JSON.parse(new TextDecoder().decode(acc.bytes()));
  } catch {
    return null; // 细节对调用方没用：超限 / 超时 / 非 JSON 一律当读不到
  }
}
