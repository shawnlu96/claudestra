/**
 * 宿主的回合循环：同一时刻只有一个回合在跑（ACP 规定），我们的 session/prompt 没返回就是忙。
 * - 空闲时到的消息直接开一轮；忙时先试 _session/steering 插进当前回合（和 Pi 的 steer 一样即时生效），
 *   适配器不支持或插不进就排队，等这轮返回后把排着的拼成一条再开一轮。
 * - 竞态：steer 到达时回合恰好收尾，适配器会拿这条消息自己另起一轮（答 startedNewTurn），这一轮没有我们的 prompt 请求，
 *   结束只能看线程状态回到 idle（io.waitExternalTurn）。它作为一项排进循环：等它结束、照常上报，后面的 prompt 不会和它重叠。
 * - 回合结束后按 Stop hook 的同一契约上报 bridge（POST /hook：Stop / StopFailure、stopHookActive、interrupt），
 *   bridge 回 {block, reason} = 这轮没 reply（lib/reply-nudge.ts 判定），就把 reason 当一轮 prompt 补发，只补一次。
 *   和 tmux 的差别：hook 在 Codex 收尾前拦下、同一轮接着答；这里另起一个很短的回合（网页上多一轮）。
 * - 补发的提示包成 <hook_prompt>：rollout 里和 tmux 的 hook 回灌同一形状，历史面板照旧显示成系统提示（codex-session.ts）。
 * 所有 IO 注入，tests/acp-turn.test.ts 用假实现逐条钉住。
 */
import type { AcpFailure } from "./failures.js";

export type PromptOutcome = { kind: "done" } | { kind: "cancelled" } | { kind: "failed"; failure: AcpFailure };

/** 与 hooks/typing-hook.ts 发给 /hook 的字段同名同义 */
export interface StopReport {
  event: "Stop" | "StopFailure";
  stopHookActive: boolean;
  interrupt?: boolean;
}

/** _session/steering 的结果（适配器原值）；failed = 插不进也没另起一轮 */
export type SteerOutcome = "injected" | "startedNewTurn" | "failed";

export interface TurnIO {
  prompt(text: string): Promise<PromptOutcome>;
  /** 插进正在跑的回合。不支持 steering 就不给 */
  steer?(text: string): Promise<SteerOutcome>;
  /** 等适配器自己另起的那一轮结束（线程状态回到 idle） */
  waitExternalTurn(): Promise<PromptOutcome>;
  reportStop(r: StopReport): Promise<{ block?: boolean; reason?: string }>;
  /** 回合失败（额度 / 未登录 / 其它）：宿主转成结构化帧给 bridge 出卡 */
  onFailure(f: AcpFailure): void;
  log(msg: string): void;
}

export const hookPromptText = (reason: string) => `<hook_prompt>${reason}</hook_prompt>`;

/** 排队的多条消息拼成一轮：各自已经是完整的 <channel> 块，空行隔开 */
const joinQueued = (texts: readonly string[]) => texts.join("\n\n");

type Item = { kind: "prompt"; text: string } | { kind: "external" };

const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));

export class AcpTurnLoop {
  private items: Item[] = [];
  private running = false;

  constructor(private readonly io: TurnIO) {}

  get busy(): boolean {
    return this.running;
  }

  get queued(): number {
    return this.items.length;
  }

  /** 收到一条入站消息。返回它怎么进的会话（日志 / 单测用） */
  async submit(text: string): Promise<"prompt" | "steer" | "queued"> {
    if (!this.running) {
      this.enqueue({ kind: "prompt", text });
      return "prompt";
    }
    const r = this.io.steer ? await this.io.steer(text).catch((e): SteerOutcome => (this.io.log(`steering 出错，改排队：${errText(e)}`), "failed")) : "failed";
    if (r === "injected") return "steer";
    // 适配器已经拿它另起了一轮：排在所有还没开的 prompt 前面，因为它已经在跑了
    if (r === "startedNewTurn") this.enqueue({ kind: "external" }, true);
    else this.enqueue({ kind: "prompt", text });
    return r === "startedNewTurn" ? "steer" : "queued";
  }

  private enqueue(item: Item, front = false): void {
    if (front) this.items.unshift(item);
    else this.items.push(item);
    if (!this.running) void this.drain();
  }

  private async drain(): Promise<void> {
    this.running = true;
    try {
      while (this.items.length) {
        const head = this.items[0];
        if (head.kind === "external") {
          this.items.shift();
          await this.turn(null);
        } else {
          // 连续排着的 prompt 拼成一轮；遇到 external 就停，它得先等
          const n = this.items.findIndex((i) => i.kind !== "prompt");
          const batch = this.items.splice(0, n < 0 ? this.items.length : n) as { kind: "prompt"; text: string }[];
          await this.turn(joinQueued(batch.map((b) => b.text)));
        }
      }
    } finally {
      this.running = false;
    }
  }

  /** 一轮（text=null：适配器自己另起的那一轮），外加最多一轮补 reply 提示 */
  private async turn(text: string | null): Promise<void> {
    let nudged = false;
    let next: string | null = text;
    let external = text === null;
    while (external || next !== null) {
      const run = external ? this.io.waitExternalTurn() : this.io.prompt(next as string);
      const outcome = await run.catch((e): PromptOutcome => ({
        kind: "failed",
        failure: { kind: "error", key: `transport:${Date.now()}`, message: errText(e) },
      }));
      external = false;
      next = null;
      if (outcome.kind === "failed") this.io.onFailure(outcome.failure);
      const report: StopReport =
        outcome.kind === "done"
          ? { event: "Stop", stopHookActive: nudged }
          : { event: "StopFailure", stopHookActive: nudged, ...(outcome.kind === "cancelled" ? { interrupt: true } : {}) };
      const verdict = await this.io.reportStop(report).catch((e) => (this.io.log(`回合结束上报失败（bridge 不在？）：${errText(e)}`), {} as { block?: boolean; reason?: string }));
      if (outcome.kind === "done" && !nudged && verdict.block && verdict.reason) {
        nudged = true;
        next = hookPromptText(verdict.reason);
      }
    }
  }
}
