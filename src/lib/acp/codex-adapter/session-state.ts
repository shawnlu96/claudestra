/**
 * 同一进程里的会话代际（I11、B56）：一个进程只有一个当前线程；new / resume / fork 共用一道会话变更闸，并发的回 -32600。
 * new / resume 成功后进入「待确认」：旧线程留着订阅记成 previous，闸一直占着，直到宿主第一次用带 sessionId 的回合类请求
 * （prompt / steering / set_config_option）表态——用新 id 是确认（放掉旧的），用旧 id 是回滚（宿主 /clear 超时放弃了，放掉新的），
 * 第三个 id 回 -32602、仍待确认。cancel 通知、会话变更请求都不算表态。epoch 每次提交 / 回滚加 1，异步续体据此作废。
 * 模型 / effort 跟线程一起提交、一起回滚：回滚后 A 的回合用的还是 A 上选的值，不是 B 建线程时带来的。
 * new / resume 在 await app-server 期间（switching）不开回合：回合开在要被换掉的线程上，收尾事件会被线程过滤丢掉（server.ts）。
 * tests/codex-adapter-session.test.ts「会话代际」。
 */
import { RpcError } from "../rpc.js";
import type { ModelState } from "./session-config.js";

const INVALID_REQUEST = -32600;
const INVALID_PARAMS = -32602;

export class SessionState {
  current: string | null = null;
  /** 当前会话的模型 / effort（set_config_option 改它，回合按它发） */
  models: ModelState | null = null;
  /** 非空 = 待确认 */
  previous: string | null = null;
  private previousModels: ModelState | null = null;
  epoch = 0;
  /** 旧线程已经放掉过：之后会话类请求的失败带 previousSessionClosed，宿主据此重起接回 registry 里的线程 */
  releasedPrevious = false;
  /** new / resume 正在 await app-server（fork 不换当前线程，不算） */
  switching = false;
  private changing = false;

  /** 拿会话变更闸；switching = 这次要换当前线程。返回释放函数 */
  acquire(switching: boolean): () => void {
    if (this.changing) throw new RpcError(INVALID_REQUEST, "上一次会话切换还在进行");
    if (this.previous) throw new RpcError(INVALID_REQUEST, "上一次会话切换还没确认（宿主还没用新会话发过请求）");
    this.changing = true;
    this.switching = switching;
    return () => void (this.changing = this.switching = false);
  }

  /** new / resume 成功：有旧线程且不是同一个才进入待确认（连同它的模型状态） */
  commit(id: string, models: ModelState): void {
    if (this.current && this.current !== id) {
      this.previous = this.current;
      this.previousModels = this.models;
    }
    this.current = id;
    this.models = models;
    this.epoch++;
  }

  /** 回合类请求带的 sessionId → 要放掉的线程（确认放旧的、回滚放新的；没有就 null） */
  touch(sessionId: unknown): string | null {
    if (typeof sessionId !== "string" || !sessionId) throw new RpcError(INVALID_PARAMS, "缺 sessionId");
    if (!this.previous) {
      if (sessionId !== this.current) throw new RpcError(INVALID_PARAMS, `不认识的会话 ${sessionId}（当前是 ${this.current ?? "无"}）`);
      return null;
    }
    if (sessionId === this.current) {
      const old = this.previous;
      this.previous = this.previousModels = null;
      this.releasedPrevious = true;
      return old;
    }
    if (sessionId !== this.previous) throw new RpcError(INVALID_PARAMS, `不认识的会话 ${sessionId}（待确认：${this.current} / ${this.previous}）`);
    const abandoned = this.current!;
    this.current = this.previous;
    this.models = this.previousModels;
    this.previous = this.previousModels = null;
    this.epoch++;
    return abandoned;
  }

  /** 会话类请求失败时要带的 data */
  failureData(): Record<string, unknown> | undefined {
    return this.releasedPrevious ? { previousSessionClosed: true } : undefined;
  }
}
