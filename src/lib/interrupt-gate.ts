/**
 * 所有打断键（C-c / Esc）的唯一出口：人类消息抢占（Discord 入站、deliverToLocal）和手动打断（停止按钮、/interrupt、API）。
 * 空闲的 CC 在短窗内收到两次 C-c 就退出，所以：按频道串行（判忙和记冷却之间有 await，两条同时到的消息不能都判过）、
 * 共用一份每频道冷却、手动打断时 CC 主回合空闲一个键都不发。依赖全注入，单测 tests/interrupt-gate.test.ts；
 * 接线在 bridge/interrupt-gate.ts。
 */
import { controlFor } from "./runtimes/index.js";
import type { TurnState } from "./turn-state.js";

export interface InterruptGateDeps {
  /** 频道 → 窗口和运行时；查不到窗口 = null */
  resolve: (channelId: string) => Promise<{ win: string | null; runtime?: string }>;
  probe: (win: string, runtime: string | undefined, agent: string) => Promise<TurnState>;
  /** 按运行时声明发打断键（CC 是 C-c），返回实际发出的键 */
  interrupt: (win: string, runtime: string | undefined) => Promise<readonly string[]>;
  escape: (win: string) => Promise<void>;
  /** 抢占成功后的收尾（指标 + done/interrupt 事件 + 日志） */
  onPreempted: (agent: string, channelId: string) => void;
  sleep: (ms: number) => Promise<void>;
  now?: () => number;
}

/** 打断之后等 CC 收尾一拍再投递：立刻投会混进垂死回合的尾流 */
const SETTLE_MS = 1_200;

export function createInterruptGate(deps: InterruptGateDeps, cooldownMs = 4_000) {
  const now = deps.now ?? Date.now;
  const lastAt = new Map<string, number>();
  const chains = new Map<string, Promise<unknown>>();
  const ready = (ch: string) => now() - (lastAt.get(ch) ?? -Infinity) > cooldownMs;

  /** 同一频道的打断逻辑排队执行；前一个出错不影响后一个 */
  function serial<T>(ch: string, fn: () => Promise<T>): Promise<T> {
    const run = (chains.get(ch) ?? Promise.resolve()).then(fn);
    const tail = run.then(
      () => undefined,
      () => undefined, // 错误由 run 的调用方拿到；链尾只负责排队，不能因为前一个失败卡住后面的
    );
    chains.set(ch, tail);
    void tail.then(() => chains.get(ch) === tail && chains.delete(ch));
    return run;
  }

  return {
    /**
     * 人类消息到达：目标主回合在跑就打断并等收尾，返回是否打断了。只看 main==="busy"：只剩后台 subagent 时 C-c 会把它们全停掉；
     * 压缩中不打断（会掐掉压缩）；Pi / Codex 不打断（preemptOnHumanMessage=false，消息 steer / 排进回合）。
     */
    preempt(channelId: string, agent: string): Promise<boolean> {
      return serial(channelId, async () => {
        if (!ready(channelId)) return false;
        const { win, runtime } = await deps.resolve(channelId);
        if (!win || !controlFor(runtime).preemptOnHumanMessage) return false;
        const { main } = await deps.probe(win, runtime, agent);
        if (main === "unknown") console.warn(`⚠️ ${win} 忙闲判据失效（TUI 文案可能已变），跳过自动打断`);
        if (main !== "busy") return false;
        lastAt.set(channelId, now());
        await deps.interrupt(win, runtime);
        deps.onPreempted(agent, channelId);
        await deps.sleep(SETTLE_MS);
        return true;
      });
    },

    /**
     * 手动打断：冷却内去重；CC 主回合空闲不发键、画面认不出只发 Esc（关弹窗，不会退出），其余按运行时发键。
     * Codex / Pi 照旧交给运行时（Codex 自己只在忙时发 Esc）。发键出错原样抛给调用方回报。
     */
    manual(channelId: string, agent: string, win: string, runtime: string | undefined): Promise<{ keys: readonly string[]; deduped?: true }> {
      return serial(channelId, async () => {
        if (!ready(channelId)) return { keys: [], deduped: true as const };
        let keys: readonly string[];
        if (!controlFor(runtime).paneHeuristics) keys = await deps.interrupt(win, runtime);
        else {
          const { main } = await deps.probe(win, runtime, agent);
          if (main === "idle") keys = [];
          else if (main === "unknown") keys = (await deps.escape(win), ["Escape"]);
          else keys = await deps.interrupt(win, runtime);
        }
        if (keys.length) lastAt.set(channelId, now());
        return { keys };
      });
    },
  };
}
