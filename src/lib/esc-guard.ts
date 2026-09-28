/**
 * 双 Esc 护栏：CC 把间隔 ≤600ms 的两次 Esc 当 Rewind 手势，弹出检查点对话框挡住窗口（≥700ms 不开，git log -S ESC_DOUBLE_TAP_MS）。
 * 所有 Esc 都走 tmux-helper 的 tmuxSendEscape（它用这里的 createEscGuard 接上真的 tmux / 文件锁）：
 * - 同一窗口两次 Esc 之间 ≥1200ms，按「上一次发完」算：负载高时一次 tmux 调用能慢几百毫秒，只按预定时刻排会让两次按键挤到一起（沙箱实测开出 Rewind）；
 * - 窗口按 tmux 的 #{window_id} 认：`master:0`、`master:=master`、`@3` 是同一个窗口（大总管的打断走 master:0、取消 AUQ 走 windowTarget("master")）；
 *   解析不出来（窗口不在）退回 windowKey；
 * - 发键全程持有跨进程锁（bridge、manager 子进程都会发 Esc），拿不到锁就只按本进程记的时刻排。
 * 单测 tests/esc-guard.test.ts。
 */
import { windowKey } from "./tmux-target.js";

export const ESC_DOUBLE_TAP_MS = 1200;

export interface EscGuardDeps {
  /** 目标 → tmux 的 #{window_id}（如 "@3"）；窗口不在 / 出错 = null */
  windowId(target: string): Promise<string | null>;
  /** 按窗口的跨进程锁；拿不到 = null（降级为只看本进程） */
  lock(key: string): Promise<{ release(): void } | null>;
  /** 跨进程共享的「上一次发完」时刻（没有 = 0） */
  readShared(key: string): number;
  writeShared(key: string, at: number): void;
  send(target: string, strict: boolean): Promise<void>;
  sleep(ms: number): Promise<void>;
  now(): number;
}

export function createEscGuard(deps: EscGuardDeps) {
  const lastDone = new Map<string, number>();
  return async function sendEscape(target: string, opts: { strict?: boolean } = {}): Promise<void> {
    const key = (await deps.windowId(target).catch(() => null)) ?? windowKey(target); // 解析不出窗口 id（窗口不在、tmux 出错）就退回按写法归一的 windowKey
    const lock = await deps.lock(key);
    try {
      const wait = Math.max(lastDone.get(key) ?? 0, deps.readShared(key)) + ESC_DOUBLE_TAP_MS - deps.now();
      if (wait > 0) await deps.sleep(wait);
      await deps.send(target, !!opts.strict);
    } finally {
      const done = deps.now(); // 发完才记：键一定已经落地
      lastDone.set(key, done);
      deps.writeShared(key, done);
      lock?.release();
    }
  };
}
