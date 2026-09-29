/**
 * 记录流（docs/relay/e2e-design.md §4.1.4）：正文 = [len:u32 大端][AES-GCM 密文 ‖ tag] …，每条明文 ≤ 64 KiB。
 *   nonce = dir(1) ‖ rid(7) ‖ i(4)；AAD = lp(label) ‖ sid(16) ‖ dir(1) ‖ rid(7) ‖ i(4) ‖ final(1)
 * 一个 (key, dir, rid) 只能有一个 RecordSealer，i 只由它递增——nonce 不重复的论证靠这一条，调用方别为同一个 rid 建第二个。
 * final 不在明文帧头里：收方对每条记录先按 final=0 解，失败再按 final=1 解（同 age 的 STREAM），
 * 所以中继既不能把中间一条标成最后一条，也不能截掉最后一条冒充完整——收不到 final=1 的一条，end() 就报截断。
 */
import { concat, lp, readU32BE, uintBE, type Bytes } from "./encoding.js";
import { gcmOpen, gcmSeal } from "./primitives.js";

export const E2E_LABEL = "cstra-e2e-v1";
export const DIR_REQ = 0x01;
export const DIR_RES = 0x02;
export const RECORD_MAX = 64 * 1024;
export const SID_LEN = 16;
/** rid 上限（不含）：nonce 里只有 7 字节 */
const RID_LIMIT = 1n << 56n;
const I_LIMIT = 2 ** 32;
const TAG_LEN = 16;

export type Dir = typeof DIR_REQ | typeof DIR_RES;

export interface RecordScope {
  key: CryptoKey;
  sid: Uint8Array;
  dir: Dir;
  rid: bigint;
  label?: string;
}

export function recordNonce(dir: Dir, rid: bigint, i: number): Bytes {
  return concat([dir], uintBE(rid, 7), uintBE(i, 4));
}

export function recordAad(label: string, sid: Uint8Array, dir: Dir, rid: bigint, i: number, final: boolean): Bytes {
  if (sid.length !== SID_LEN) throw new RangeError("sid must be 16 bytes");
  return concat(lp(label), sid, [dir], uintBE(rid, 7), uintBE(i, 4), [final ? 1 : 0]);
}

function checkScope(s: RecordScope): void {
  if (s.rid <= 0n || s.rid >= RID_LIMIT) throw new RangeError("rid out of range");
  if (s.sid.length !== SID_LEN) throw new RangeError("sid must be 16 bytes");
}

export class RecordSealer {
  private i = 0;
  private closed = false;
  constructor(private readonly s: RecordScope) {
    checkScope(s);
  }

  /** 加密一条并带上 u32 长度头；final 之后再调用直接抛 */
  async seal(pt: Uint8Array, final: boolean): Promise<Bytes> {
    if (this.closed) throw new Error("record stream already finalized");
    if (pt.length > RECORD_MAX) throw new RangeError(`record plaintext > ${RECORD_MAX}`);
    if (this.i >= I_LIMIT) throw new RangeError("record counter exhausted");
    const i = this.i++;
    if (final) this.closed = true;
    const { key, sid, dir, rid } = this.s;
    const label = this.s.label ?? E2E_LABEL;
    const ct = await gcmSeal(key, recordNonce(dir, rid, i), recordAad(label, sid, dir, rid, i, final), pt);
    return concat(uintBE(ct.length, 4), ct);
  }
}

/** 一条完整的消息：第 0 条是头（{method,path,headers} 或 {status,headers} 的 JSON），之后正文按 64 KiB 分块；没有正文时头就是 final */
export async function sealMessage(s: RecordScope, head: Uint8Array, body: Uint8Array = new Uint8Array(0)): Promise<Bytes> {
  const sealer = new RecordSealer(s);
  const out: Uint8Array[] = [await sealer.seal(head, body.length === 0)];
  for (let at = 0; at < body.length; at += RECORD_MAX) out.push(await sealer.seal(body.subarray(at, at + RECORD_MAX), at + RECORD_MAX >= body.length));
  return concat(...out);
}

export class RecordError extends Error {}

export class RecordOpener {
  private i = 0;
  private buf: Uint8Array = new Uint8Array(0);
  private finished = false;
  constructor(private readonly s: RecordScope) {
    checkScope(s);
  }

  get done(): boolean {
    return this.finished;
  }

  /** 喂进一段收到的字节，返回其中完整记录的明文（按 i 顺序）；tag 错、超长、final 之后还有字节 → RecordError */
  async push(chunk: Uint8Array): Promise<Bytes[]> {
    this.buf = this.buf.length ? concat(this.buf, chunk) : chunk;
    const out: Bytes[] = [];
    for (;;) {
      if (this.finished) {
        if (this.buf.length) throw new RecordError("data after final record");
        return out;
      }
      if (this.buf.length < 4) return out;
      const len = readU32BE(this.buf, 0);
      if (len < TAG_LEN || len > RECORD_MAX + TAG_LEN) throw new RecordError(`bad record length ${len}`);
      if (this.buf.length < 4 + len) return out;
      const ct = this.buf.subarray(4, 4 + len);
      this.buf = this.buf.subarray(4 + len);
      out.push(await this.openOne(ct));
    }
  }

  /** 流结束：没见到 final=1 的记录、或剩半条 → 截断 */
  end(): void {
    if (!this.finished || this.buf.length) throw new RecordError("record stream truncated");
  }

  private async openOne(ct: Uint8Array): Promise<Bytes> {
    if (this.i >= I_LIMIT) throw new RecordError("record counter exhausted");
    const { key, sid, dir, rid } = this.s;
    const label = this.s.label ?? E2E_LABEL;
    const nonce = recordNonce(dir, rid, this.i);
    let pt = await gcmOpen(key, nonce, recordAad(label, sid, dir, rid, this.i, false), ct);
    if (!pt) {
      pt = await gcmOpen(key, nonce, recordAad(label, sid, dir, rid, this.i, true), ct);
      if (!pt) throw new RecordError(`record ${this.i} failed authentication`);
      this.finished = true;
    }
    this.i++;
    return pt;
  }
}

/** 一次性解开整段记录流：必须恰好以 final 结尾 */
export async function openAll(s: RecordScope, body: Uint8Array): Promise<Bytes[]> {
  const o = new RecordOpener(s);
  const out = await o.push(body);
  o.end();
  return out;
}
