/**
 * 测试用的极简实例客户端：按 docs/relay/protocol.md 握手、收发帧、按条件等帧。
 * 故意不依赖 src/lib/relay-client.ts——服务端测试要能独立于客户端库的实现验证协议本身。
 */
import { createPrivateKey, createPublicKey, type KeyObject } from "node:crypto";
import { authSignature, PROTOCOL_VERSION, SUBPROTOCOL } from "../src/lib/relay-protocol.ts";

export interface TestKey { publicKey: string; privateKey: KeyObject }

/** 固定种子 → Ed25519 密钥（PKCS#8 前缀 + 32 字节种子），协议 §10 的向量就是这么来的 */
export function keyFromSeed(seedHex: string): TestKey {
  const der = Buffer.concat([Buffer.from("302e020100300506032b657004220420", "hex"), Buffer.from(seedHex, "hex")]);
  const privateKey = createPrivateKey({ key: der, format: "der", type: "pkcs8" });
  const publicKey = String(createPublicKey(privateKey).export({ format: "jwk" }).x);
  return { publicKey, privateKey };
}

export const seedOf = (n: number): string => n.toString(16).padStart(64, "0");

type Frame = Record<string, unknown>;

export interface ConnectOptions {
  name?: string;
  slug?: string;
  /** 篡改用：签名 / 版本 / 延迟发 auth */
  sig?: string;
  v?: number;
  authDelayMs?: number;
  /** 不自动发 auth（自己决定发什么） */
  manualAuth?: boolean;
}

export class TestClient {
  readonly frames: Frame[] = [];
  readonly closed: Promise<{ code: number; reason: string }>;
  private waiters: Array<{ pred: (f: Frame) => boolean; resolve: (f: Frame) => void }> = [];
  private ws!: WebSocket;
  welcome: Frame | null = null;
  /** 握手被拒时中继回的 error 帧 */
  authError: Frame | null = null;

  private constructor(readonly url: string, readonly key: TestKey, readonly opts: ConnectOptions) {
    let resolveClosed!: (v: { code: number; reason: string }) => void;
    this.closed = new Promise((r) => (resolveClosed = r));
    this.ws = new WebSocket(url, [SUBPROTOCOL]);
    this.ws.addEventListener("message", (ev) => this.onFrame(JSON.parse(String(ev.data)) as Frame));
    this.ws.addEventListener("close", (ev) => resolveClosed({ code: ev.code, reason: ev.reason }));
  }

  /** 连上并（默认）完成握手；返回的客户端里 welcome 已就位。握手被拒时 welcome 为 null，错误帧在 frames 里 */
  static async connect(url: string, key: TestKey, opts: ConnectOptions = {}): Promise<TestClient> {
    const c = new TestClient(url, key, opts);
    await new Promise<void>((resolve, reject) => {
      c.ws.addEventListener("open", () => resolve());
      c.ws.addEventListener("error", () => reject(new Error("websocket error")));
    });
    const hello = await c.next((f) => f.t === "hello");
    if (opts.manualAuth) return c;
    if (opts.authDelayMs) await new Promise((r) => setTimeout(r, opts.authDelayMs));
    c.sendAuth(String(hello.nonce));
    const reply = await c.next((f) => f.t === "welcome" || f.t === "error");
    if (reply.t === "welcome") c.welcome = reply;
    else c.authError = reply;
    return c;
  }

  sendAuth(nonce: string, name = this.opts.name ?? "Test Box", slug = this.opts.slug ?? "test-box"): void {
    const sig = this.opts.sig ?? authSignature(this.key.privateKey, nonce, this.key.publicKey, name, slug);
    this.send({ t: "auth", v: this.opts.v ?? PROTOCOL_VERSION, key: this.key.publicKey, name, slug, sig });
  }

  get fp(): string {
    return String(this.welcome?.fp ?? "");
  }

  get slug(): string {
    return String(this.welcome?.slug ?? "");
  }

  send(frame: Frame): void {
    try {
      this.ws.send(JSON.stringify(frame));
    } catch {
      // 中继已经把这条连接关了（测试故意迟发 auth）：发不出去正是被测的行为，closed 里有关闭码
    }
  }

  sendRaw(text: string | Uint8Array): void {
    this.ws.send(text);
  }

  /** 等一帧满足条件（已收到但没被消费过的也算）；超时抛错，错误信息带上到目前收到的帧类型 */
  next(pred: (f: Frame) => boolean, timeoutMs = 3000): Promise<Frame> {
    const i = this.frames.findIndex(pred);
    if (i >= 0) return Promise.resolve(this.frames.splice(i, 1)[0]);
    return new Promise((resolve, reject) => {
      const w = { pred, resolve };
      this.waiters.push(w);
      setTimeout(() => {
        const idx = this.waiters.indexOf(w);
        if (idx < 0) return;
        this.waiters.splice(idx, 1);
        reject(new Error(`no matching frame within ${timeoutMs}ms; seen: ${this.frames.map((f) => f.t).join(",") || "(none)"}`));
      }, timeoutMs);
    });
  }

  /** 断言一段时间内没有满足条件的帧 */
  async none(pred: (f: Frame) => boolean, ms = 150): Promise<boolean> {
    await new Promise((r) => setTimeout(r, ms));
    return !this.frames.some(pred);
  }

  contacts(fps: string[]): Promise<Frame> {
    this.send({ t: "contacts", fps });
    return this.next((f) => f.t === "peers");
  }

  close(code = 1000): void {
    this.ws.close(code);
  }

  private onFrame(f: Frame): void {
    const i = this.waiters.findIndex((w) => w.pred(f));
    if (i >= 0) return void this.waiters.splice(i, 1)[0].resolve(f);
    this.frames.push(f);
  }
}
