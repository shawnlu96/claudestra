/**
 * 双 Esc 护栏：CC 把间隔 ≤600ms 的两次 Esc 当 Rewind 手势，弹出检查点对话框挡住窗口（≥700ms 不开，git log -S ESC_DOUBLE_TAP_MS）。
 * 所有 Esc 都走 tmux-helper 的 tmuxSendEscape（它用这里的 createEscGuard 接上真的 tmux / 文件锁）：
 * - 同一窗口两次 Esc 之间 ≥1200ms，按「上一次发完」算：负载高时一次 tmux 调用能慢几百毫秒，只按预定时刻排会让两次按键挤到一起（沙箱实测开出 Rewind）；
 * - 窗口按 tmux 的 #{window_id} 认：`master:0`、`master:=master`、`@3` 是同一个窗口（大总管的打断走 master:0、取消 AUQ 走 windowTarget("master")）；
 *   查询出错（tmux 超时 / 报错 / 窗口不在）这一发不发：退回 windowKey 会和按 @id 作键的其它发送方不互斥（窗口不在时键本来也落不了地）；
 *   别的「按窗口记」的东西（keyOf：程序敲字记录、最后发 Esc 的时刻）照旧退回 windowKey；
 * - 同一进程里按窗口排队；跨进程（bridge、manager 子进程都会发 Esc）发键全程持锁。锁等得比过期久（持锁进程崩了也能等到回收）；
 *   真拿不到就不发（fail-closed）：告警，strict 调用方（打断键）收到错误如实回报——少发一下 Esc 能重按，开出 Rewind 会挡住窗口。
 * 单测 tests/esc-guard.test.ts。
 */
import { createKeyedSerial } from "./keyed-serial.js";
import { windowKey } from "./tmux-target.js";

export const ESC_DOUBLE_TAP_MS = 1200;
/** 等窗口锁的上限：比锁的过期时间（5 秒）长，持锁进程崩了也等得到回收 */
export const ESC_LOCK_WAIT_MS = 12_000;
/**
 * bridge 各 HTTP 入口的连接空闲上限（秒）。打断请求最坏要等打断间隔（≤2.75 秒）+ 窗口锁 ESC_LOCK_WAIT_MS + 锁内 1.2 秒才有结果；
 * Bun 默认 10 秒会先把连接切断，客户端只拿到空响应，看不到「Esc 没发」。网页打断的超时（web/lib/api/chat.ts）要在两者之间。
 */
export const HTTP_IDLE_TIMEOUT_S = 30;

export interface EscGuardDeps {
  /** 目标 → tmux 的 #{window_id}（如 "@3"）；窗口不在 = null，查询出错 = 抛错 */
  windowId(target: string): Promise<string | null>;
  /** 按窗口的跨进程锁；拿不到 = null（这一发不发）。held()：发之前再核一次还是不是自己的（持锁进程被暂停过、锁已被回收 = 不发） */
  lock(key: string): Promise<{ release(): void; held?(): boolean } | null>;
  /** 跨进程共享的「上一次发完」时刻（没有 = 0） */
  readShared(key: string): number;
  writeShared(key: string, at: number): void;
  send(target: string, strict: boolean): Promise<void>;
  /** 所有等待之后、发之前的最后一查（Codex 选择菜单，lib/codex-key-guard.ts）：返回错误 = 这一发不发（strict 抛出，否则记日志） */
  blocked?(target: string): Promise<Error | null>;
  sleep(ms: number): Promise<void>;
  now(): number;
}

export function createEscGuard(deps: EscGuardDeps) {
  const lastDone = new Map<string, number>();
  const keyOf = async (target: string) => (await deps.windowId(target).catch(() => null)) ?? windowKey(target); // 解析不出窗口 id（窗口不在、tmux 出错）就退回按写法归一的 windowKey
  const lastAt = (key: string) => Math.max(lastDone.get(key) ?? 0, deps.readShared(key));
  const serial = createKeyedSerial();
  /** fail-closed：不发，告警；strict 调用方（打断键）收到错误如实回报 */
  const refuse = (msg: string, strict: boolean): void => {
    console.warn(`⚠️ ${msg}`);
    if (strict) throw new Error(msg);
  };
  const lockLost = (target: string) => `没发（${target}）：等的这段时间窗口锁被当过期回收了，别的进程可能刚发过`;
  /** 发键用的锁键（Esc 和 locked 同一个开头）：查窗口 id 出错 = 不发（refuse 后返回 undefined）；窗口不在退回 windowKey */
  const lockKeyOf = async (target: string, strict: boolean, label: string): Promise<string | undefined> => {
    const id = await deps.windowId(target).then((x) => ({ x }), (e: Error) => ({ err: e }));
    if ("err" in id) return void refuse(`${label}（${target}）：查不到窗口 id（${id.err.message}），换个键互斥不住别的发送方`, strict);
    return id.x ?? windowKey(target);
  };
  /**
   * unguarded：生命周期退出（kill / restart 清场）要关掉菜单本身，不走 blocked 那一查（runtimes/window-ops.ts）。
   * gate：调用方自己的画面闸，放在所有等待（锁、节流、blocked）之后、发之前；抛错 = 不发（manager/send-keys.ts）
   */
  async function sendEscape(target: string, opts: { strict?: boolean; unguarded?: boolean; gate?: () => Promise<void> } = {}): Promise<void> {
    const key = await lockKeyOf(target, !!opts.strict, "Esc 没发");
    if (key === undefined) return;
    return serial(key, () => sendLocked(key, target, !!opts.strict, !!opts.unguarded, opts.gate));
  }
  async function sendLocked(key: string, target: string, strict: boolean, unguarded: boolean, gate?: () => Promise<void>): Promise<void> {
    const lock = await deps.lock(key);
    let sent = false;
    if (!lock) return refuse(`Esc 没发（${target}）：等不到窗口锁，前面排着的 Esc 太多或锁卡住了，不持锁发可能开出 Rewind`, strict);
    try {
      const wait = lastAt(key) + ESC_DOUBLE_TAP_MS - deps.now();
      if (wait > 0) await deps.sleep(wait);
      const blocked = unguarded ? null : ((await deps.blocked?.(target)) ?? null);
      if (blocked) {
        if (strict) throw blocked;
        return void console.warn(`⚠️ Esc 没发: ${blocked.message}`);
      }
      await gate?.();
      if (lock.held && !lock.held()) return refuse(`Esc ${lockLost(target)}`, strict);
      sent = true; // 从这里起键可能已经落地（send 抛错也可能发出去了）：记时刻，下一发照样隔开
      await deps.send(target, strict);
    } finally {
      // 没发（拒发 / 被拦）不记：lastSentAt 会把之后几秒里真人按的 Esc 认成程序发的（T13e r2 P2-3）
      const done = deps.now();
      if (sent) lastDone.set(key, done), deps.writeShared(key, done);
      lock.release();
    }
  }
  /** 这个窗口最后一次经这里发完 Esc 的时刻（跨进程；没发过 = 0）：认出会话记录里的打断是不是程序发的键 */
  sendEscape.lastSentAt = async (target: string): Promise<number> => lastAt(await keyOf(target));
  /** 窗口的钥匙（tmux #{window_id}，解析不出退回 windowKey）：别的「按窗口跨进程记」的东西也用它（lib/program-input.ts） */
  sendEscape.keyOf = keyOf;
  /**
   * 非 Esc 的键拿同一把窗口锁发（不节流）：拿到锁 → gate（调用方的画面闸，抛错 = 不发）→ 核对锁还是自己的 → send。
   * 查画面到发键之间，别的进程的 Esc / 受闸发键插不进来；查不到窗口 id、拿不到锁、锁被回收过都抛错、不发（manager/send-keys.ts）
   */
  sendEscape.locked = async (target: string, gate: () => Promise<void>, send: () => Promise<void>): Promise<void> => {
    const key = (await lockKeyOf(target, true, "没发"))!; // strict：出错已经抛了
    return serial(key, async () => {
      const lock = await deps.lock(key);
      if (!lock) throw new Error(`没发（${target}）：等不到窗口锁`);
      try {
        await gate();
        if (lock.held && !lock.held()) throw new Error(lockLost(target));
        await send();
      } finally {
        lock.release();
      }
    });
  };
  return sendEscape;
}
