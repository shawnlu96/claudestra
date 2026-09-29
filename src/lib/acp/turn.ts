/**
 * 宿主的回合循环：所有「开一轮」都经同一个调度器，保证同一时刻只有一轮（ACP 规定，重叠会让两轮抢同一个线程）。
 * 队列里按到达顺序放四种槽：prompt（空闲时到的，或插不进的）、steer（_session/steering 在途，归属未定）、
 * external（适配器拿 steer 的消息自己另起了一轮，已经在跑）、nudge（补 reply 提示）。调度规则：
 * 1. 有 steer 在途就什么都不开、也不算空闲：它可能已经让适配器另起了一轮（startedNewTurn 在新回合开始时就回，
 *    回包到之前那一轮已经在跑），这时再 prompt 就重叠了（tests/acp-turn.test.ts「steer 在途」）；
 * 2. 有 external 就先等它：它在适配器里已经在跑，不管排在哪；
 * 3. 否则按队首：nudge 单独一轮，连续的 prompt 拼成一轮。
 * 忙时到的消息先试 steering（插进当前回合，和 Pi 的 steer 一样即时生效），插不进就在原位置变回 prompt——并发失败也不乱序。
 * 回合结束按 Stop hook 的同一契约上报（Stop / StopFailure、stopHookActive、interrupt）；bridge 回 block = 这轮没 reply
 * （lib/reply-nudge.ts），就排一个 nudge 到队首（仍在 external 之后），补的那轮 stopHookActive=true，bridge 不会再拦。
 * 和 tmux 的差别：hook 在收尾前拦下、同一轮接着答；这里另起一个很短的回合。提示包成 <hook_prompt>，rollout 里与 hook 回灌同形。
 */
import type { AcpFailure } from "./failures.js";

export type PromptOutcome = { kind: "done" } | { kind: "cancelled" } | { kind: "failed"; failure: AcpFailure };

/** 与 hooks/typing-hook.ts 发给 /hook 的字段同名同义 */
export interface StopReport {
  event: "Stop" | "StopFailure";
  stopHookActive: boolean;
  interrupt?: boolean;
  acpDeliveryWarning?: true;
}

/**
 * _session/steering 的结果。startedNewTurn 必须带上那一轮的结束信号：IO 在处理回包的同一刻就挂上等待（按回包之后的
 * 线程状态 idle 认），所以那一轮哪怕在调度器排到它之前就结束了，done 也已经记下，不会漏等、也不会等错一轮。
 */
export type SteerResult =
  | { outcome: "injected" }
  | { outcome: "failed" }
  | { outcome: "startedNewTurn"; done: Promise<PromptOutcome> };

export interface TurnIO {
  prompt(text: string): Promise<PromptOutcome>;
  /** 插进正在跑的回合。必须有结果（宿主给请求设超时）：在途期间调度器不开新回合。不支持 steering 就不给 */
  steer?(text: string): Promise<SteerResult>;
  reportStop(r: StopReport): Promise<{ block?: boolean; reason?: string }>;
  /** 回合失败（额度 / 未登录 / 其它）：宿主转成结构化帧给 bridge 出卡 */
  onFailure(f: AcpFailure): void;
  log(msg: string): void;
}

export const hookPromptText = (reason: string) => `<hook_prompt>${reason}</hook_prompt>`;

type Slot =
  | { kind: "prompt"; text: string }
  | { kind: "steer" }
  | { kind: "external"; done: Promise<PromptOutcome> }
  | { kind: "nudge"; text: string };

type Pick = { kind: "prompt" | "nudge"; text: string } | { kind: "external"; done: Promise<PromptOutcome> };

const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));

/**
 * 调 IO 的唯一入口：同步 throw 也变成 rejection。适配器进程已经退出时，IO 实现可能直接抛而不是返回失败的 Promise；
 * 直接写 io.x().catch(…) 接不住它——steer 的占位就此不释放，busy 永远为 true，之后什么都投不进去（tests/acp-turn.test.ts「同步抛错」）。
 */
function call<T>(f: () => Promise<T>): Promise<T> {
  try {
    return Promise.resolve(f());
  } catch (e) {
    return Promise.reject(e);
  }
}

/** 传输层失败的去重键：单调序号。不能用时间戳——同一毫秒里两次失败会被 FailureDedup 合成一条、少出一张卡 */
let transportFailures = 0;
const failedOutcome = (e: unknown): PromptOutcome => ({ kind: "failed", failure: { kind: "error", key: `transport:${++transportFailures}`, message: errText(e) } });

export class AcpTurnLoop {
  private slots: Slot[] = [];
  /** 调度器正在跑一轮（含上报）。steer 在途、调度器停着等它时为 false，但 busy 仍为 true */
  private pumping = false;

  constructor(private readonly io: TurnIO) {}

  /** 有一轮在跑、或者还有没落定 / 没开的槽 */
  get busy(): boolean {
    return this.pumping || this.slots.length > 0;
  }

  get queued(): number {
    return this.slots.length;
  }

  /** 收到一条入站消息。返回它怎么进的会话（日志 / 单测用） */
  async submit(text: string): Promise<"prompt" | "steer" | "queued"> {
    const steering = this.io.steer && (this.pumping || this.slots.some((s) => s.kind === "steer"));
    if (!steering) {
      const idle = !this.busy;
      this.slots.push({ kind: "prompt", text });
      this.pump();
      return idle ? "prompt" : "queued";
    }
    // 先占位（到达顺序），再发 steer；落定之前调度器不会开新回合
    const slot: Slot = { kind: "steer" };
    this.slots.push(slot);
    const r = await call(() => this.io.steer!(text)).catch((e): SteerResult => (this.log(`steering 出错，改排队：${errText(e)}`), { outcome: "failed" }));
    const at = this.slots.indexOf(slot);
    if (r.outcome === "injected") this.slots.splice(at, 1);
    // done 登记时就接住：排到它之前就 reject 的话，不能变成 unhandled rejection（Bun 进程会以 1 退出）
    else if (r.outcome === "startedNewTurn") this.slots[at] = { kind: "external", done: call(() => r.done).catch(failedOutcome) };
    else this.slots[at] = { kind: "prompt", text };
    this.pump();
    return r.outcome === "failed" ? "queued" : "steer";
  }

  /** 按规则挑下一轮；null = 没东西可开，或者要等 steer 落定 */
  private next(): Pick | null {
    if (!this.slots.length || this.slots.some((s) => s.kind === "steer")) return null;
    const ext = this.slots.findIndex((s) => s.kind === "external");
    if (ext >= 0) return this.slots.splice(ext, 1)[0] as Pick;
    const head = this.slots[0];
    if (head.kind === "nudge") return this.slots.shift() as Pick;
    const n = this.slots.findIndex((s) => s.kind !== "prompt");
    const batch = this.slots.splice(0, n < 0 ? this.slots.length : n) as { kind: "prompt"; text: string }[];
    return { kind: "prompt", text: batch.map((b) => b.text).join("\n\n") };
  }

  /** 日志本身坏了也不能连带卡住调度（它在各个 catch 里被调用） */
  private log(msg: string): void {
    try {
      this.io.log(msg);
    } catch {
      /* 日志出口坏了：丢掉这一条，调度照常，不然一次日志失败就把槽卡死 */
    }
  }

  private pump(): void {
    if (this.pumping) return;
    const first = this.next();
    if (!first) return;
    this.pumping = true;
    void (async () => {
      try {
        // 单轮出意外（IO 实现抛错）只记日志：调度器停了，排着的消息就永远出不去
        for (let p: Pick | null = first; p; p = this.next()) await this.run(p).catch((e) => this.log(`回合调度出错：${errText(e)}`));
      } finally {
        this.pumping = false;
      }
    })();
  }

  private async run(p: Pick): Promise<void> {
    const outcome = await call(() => (p.kind === "external" ? p.done : this.io.prompt(p.text))).catch(failedOutcome);
    if (outcome.kind === "failed") {
      // 出卡失败不能连带吞掉下面的上报：bridge 收不到 StopFailure，这个 agent 就一直显示「思考中」
      try {
        this.io.onFailure(outcome.failure);
      } catch (e) {
        this.log(`失败出卡出错：${errText(e)}`);
      }
    }
    const nudge = p.kind === "nudge";
    const report: StopReport =
      outcome.kind === "done"
        ? { event: "Stop", stopHookActive: nudge }
        : { event: "StopFailure", stopHookActive: nudge, ...(outcome.kind === "cancelled" ? { interrupt: true } : {}) };
    const verdict = await call(() => this.io.reportStop(report)).catch((e) => (this.log(`回合结束上报失败（bridge 不在？）：${errText(e)}`), {} as { block?: boolean; reason?: string }));
    // 补 reply 排到队首；在跑的 external 仍按规则 2 先等完
    if (outcome.kind === "done" && !nudge && verdict.block && verdict.reason) this.slots.unshift({ kind: "nudge", text: hookPromptText(verdict.reason) });
  }
}
