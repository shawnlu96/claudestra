/**
 * 所有打断键（C-c / Esc）的唯一出口：人类消息抢占（Discord 入站、deliverToLocal）和手动打断（停止按钮、/interrupt、API）。
 * 两次键挨太近会出事（CC：两次 Esc 开 Rewind、两次 C-c 退出；Codex：双 Esc 回溯遮罩），所以按频道串行（判忙和记时之间有 await，两条同时到的消息不能都判过），
 * 且任何两次发键至少隔 MANUAL_GAP_MS。自动抢占另有 4s 冷却、只在画面判出主回合在跑时才打；人手动的停止不看画面判据，
 * 一律发键——认不出的忙碌帧（API 重试行、新文案）判成空闲时不发键，用户就停不下来。依赖全注入，单测 tests/interrupt-gate.test.ts；
 * 接线在 bridge/interrupt-gate.ts。
 */
import { createKeyedSerial } from "./keyed-serial.js";
import { controlFor } from "./runtimes/index.js";
import type { TurnState } from "./turn-state.js";

export interface InterruptGateDeps {
  /** 频道 → 窗口和运行时；查不到窗口 = null */
  resolve: (channelId: string) => Promise<{ win: string | null; runtime?: string }>;
  probe: (win: string, runtime: string | undefined, agent: string) => Promise<TurnState>;
  /** 按运行时声明发打断键（CC / Codex 是 Esc，Pi 是 C-c），返回实际发出的键 */
  interrupt: (win: string, runtime: string | undefined) => Promise<readonly string[]>;
  /** 抢占成功后的收尾（指标 + done/interrupt 事件 + 日志） */
  onPreempted: (agent: string, channelId: string) => void;
  sleep: (ms: number) => Promise<void>;
  now?: () => number;
}

/** 打断之后等 CC 收尾一拍再投递：立刻投会混进垂死回合的尾流 */
const SETTLE_MS = 1_200;
/** 任意两次发键的最小间隔：挡住 CC 的双 Esc Rewind / 双 C-c 退出和 Codex 的双 Esc 回溯遮罩 */
const MANUAL_GAP_MS = 1_500;

export function createInterruptGate(deps: InterruptGateDeps, cooldownMs = 4_000) {
  const now = deps.now ?? Date.now;
  /** 频道 → 上一次真发出键的时刻（抢占和手动共用） */
  const lastKeyAt = new Map<string, number>();
  const serial = createKeyedSerial();
  const sinceKey = (ch: string) => now() - (lastKeyAt.get(ch) ?? -Infinity);

  return {
    /**
     * 人类消息到达：目标主回合在跑就打断并等收尾，返回是否打断了。只看 main==="busy"：只剩后台 subagent 时不该打断（CC 已改发 Esc，不会再停掉它们，见 runtimes/claude-code.ts）；
     * 压缩中不打断（会掐掉压缩）；Pi 不打断（preemptOnHumanMessage=false，消息 steer 进回合）。
     * stop（停字）：人明确要停——不看 preemptOnHumanMessage（Pi 也打断），冷却按手动的最小间隔（刚抢占完紧接着说「停」必须生效），
     * 判据失效（unknown）也发键；只有确认空闲或压缩中才不发。
     */
    preempt(channelId: string, agent: string, opts: { stop?: boolean } = {}): Promise<boolean> {
      return serial(channelId, async () => {
        // 刚打断过（抢占或手动）就不再打：连发的补充消息不叠加打断，也不会离上一次发键太近
        if (sinceKey(channelId) <= (opts.stop ? MANUAL_GAP_MS : cooldownMs)) return false;
        const { win, runtime } = await deps.resolve(channelId);
        if (!win || (!opts.stop && !controlFor(runtime).preemptOnHumanMessage)) return false;
        const { main } = await deps.probe(win, runtime, agent);
        if (main === "unknown" && !opts.stop) console.warn(`⚠️ ${win} 忙闲判据失效（TUI 文案可能已变），跳过自动打断`);
        if (main !== "busy" && !(opts.stop && main === "unknown")) return false;
        lastKeyAt.set(channelId, now());
        await deps.interrupt(win, runtime);
        deps.onPreempted(agent, channelId);
        await deps.sleep(SETTLE_MS);
        return true;
      });
    },

    /**
     * 手动打断（停止按钮 / /interrupt / API）：人明确要停，不看画面判据，按运行时发键（Codex 自己只在忙时发 Esc）。
     * 只受最小间隔约束：离上一次发键（含刚才的自动抢占）不足 MANUAL_GAP_MS 就去重。发键出错原样抛给调用方回报。
     */
    manual(channelId: string, win: string, runtime: string | undefined): Promise<{ keys: readonly string[]; deduped?: true }> {
      return serial(channelId, async () => {
        if (sinceKey(channelId) <= MANUAL_GAP_MS) return { keys: [], deduped: true as const };
        const keys = await deps.interrupt(win, runtime);
        if (keys.length) lastKeyAt.set(channelId, now());
        return { keys };
      });
    },
  };
}
