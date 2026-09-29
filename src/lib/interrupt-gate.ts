/**
 * 所有打断键（C-c / Esc）的唯一出口：人类消息抢占（Discord 入站、deliverToLocal）和手动打断（停止按钮、/interrupt、API）。
 * 两次键挨太近会出事（CC：两次 Esc 开 Rewind、两次 C-c 退出；Codex：双 Esc 回溯遮罩），所以按频道串行（判忙和记时之间有 await，两条同时到的消息不能都判过），
 * 且任何两次发键至少隔 MANUAL_GAP_MS。自动抢占另有 4s 冷却、只在画面判出主回合在跑时才打；人手动的停止不看画面判据，
 * 一律发键——认不出的忙碌帧（API 重试行、新文案）判成空闲时不发键，用户就停不下来。依赖全注入，单测 tests/interrupt-gate.test.ts；
 * 接线在 bridge/interrupt-gate.ts。
 */
import { createKeyedSerial } from "./keyed-serial.js";
import { controlFor, type Transport } from "./runtimes/index.js";
import type { TurnState } from "./turn-state.js";

export interface InterruptGateDeps {
  /** 频道 → 窗口和运行时；查不到窗口 = null */
  resolve: (channelId: string) => Promise<{ win: string | null; runtime?: string; transport?: Transport }>;
  probe: (win: string, runtime: string | undefined, agent: string, channelId: string) => Promise<TurnState>;
  /**
   * 窗口停在额度菜单 / 撞墙等待（lib/quota-wall-text.ts paneShowsWallWait）：一个键都不发，停字也不发（菜单里有花钱的选项，
   * 倒计时上的键会取消 CC 排好的自动续跑）。两个抢占入口都经这里，以后新加的入口也跑不掉。
   */
  wallWait?: (win: string) => Promise<boolean>;
  /** 按运行时声明发打断键（CC / Codex 是 Esc，Pi 是 C-c），返回实际发出的键 */
  interrupt: (win: string, runtime: string | undefined, channelId: string, kind: "preempt" | "manual", wanted?: () => boolean) => Promise<readonly string[]>;
  /** 这一次允不允许由 bridge 主动打断（Codex：channel-server 得会打字投递、上次 Stop 之后没抢占过） */
  allow?: (channelId: string, runtime: string | undefined, stop: boolean) => boolean;
  /** 抢占成功后的收尾（指标 + done/interrupt 事件 + 日志） */
  onPreempted: (agent: string, channelId: string) => void;
  sleep: (ms: number) => Promise<void>;
  now?: () => number;
}

/** preempt 的结果：fired = 发了键且画面确认停下了；否则 why 说明为什么没打断 */
export type PreemptResult = { fired: true } | { fired: false; why: "cooldown" | "not_allowed" | "wall_wait" | "not_busy" | "no_keys" | "ineffective" | "withdrawn" };

/** 打断之后等 CC 收尾一拍再投递：立刻投会混进垂死回合的尾流 */
const SETTLE_MS = 1_200;
/** 判完要发键之后隔这么久再看一眼画面：这之间菜单刚弹出来、或回合刚结束的，不发 */
const RECHECK_MS = 300;
/** 任意两次发键的最小间隔：挡住 CC 的双 Esc Rewind / 双 C-c 退出和 Codex 的双 Esc 回溯遮罩 */
const MANUAL_GAP_MS = 1_500;

export function createInterruptGate(deps: InterruptGateDeps, cooldownMs = 4_000) {
  const now = deps.now ?? Date.now;
  /** 频道 → 上一次真发出键的时刻（抢占和手动共用） */
  const lastKeyAt = new Map<string, number>();
  /** 上一次发键是停止（手动）的频道：紧跟着的又一次停止去重，紧跟着抢占的停止照发 */
  const lastManual = new Set<string>();
  const serial = createKeyedSerial();
  const sinceKey = (ch: string) => now() - (lastKeyAt.get(ch) ?? -Infinity);
  // 「停」（停字 / 停止按钮）离上一次发键要隔多久：上一次是抢占的话，插话那条要等收尾一拍（SETTLE_MS）之后才投，
  // 停的键得落在它开的回合上，不能落在两回合之间的空闲里
  const gapAfter = (ch: string) => (lastManual.has(ch) ? MANUAL_GAP_MS : SETTLE_MS + MANUAL_GAP_MS);

  return {
    /**
     * 人类消息到达：目标主回合在跑就打断并等收尾。只看 main==="busy"：只剩后台 subagent 时不打断；压缩中不打断（会掐掉压缩）；
     * Pi 不打断（preemptOnHumanMessage=false，消息 steer 进回合）。发完键再看一眼：画面还在忙（焦点在浮层 / copy-mode / vim 插入模式，
     * 键没起作用）就不算打断——调用方不能据此告诉 agent「你被打断了」。
     * stop（停字）：人明确要停——不看 preemptOnHumanMessage（Pi 也打断）；离上一次发键不足最小间隔就等够再发（不丢这次停）；
     * 判据失效（unknown）也发键；只有确认空闲或压缩中才不发。中止走扩展 / ACP 宿主的（Pi、ACP Codex）不看 bridge 的忙闲，由运行时回空闲（no_keys）。
     */
    preempt(channelId: string, agent: string, opts: { stop?: boolean; wanted?: () => boolean } = {}): Promise<PreemptResult> {
      return serial(channelId, async (): Promise<PreemptResult> => {
        const stop = !!opts.stop;
        const since = sinceKey(channelId);
        // 刚打断过（抢占或手动）：连发的补充消息不叠加打断；停字等够最小间隔再发
        if (!stop && since <= cooldownMs) return { fired: false, why: "cooldown" };
        if (stop && since <= gapAfter(channelId)) await deps.sleep(gapAfter(channelId) - since + 50);
        const { win, runtime, transport } = await deps.resolve(channelId);
        if (!win || (!stop && !controlFor(runtime, transport).preemptOnHumanMessage)) return { fired: false, why: "not_allowed" };
        if (deps.allow && !deps.allow(channelId, runtime, stop)) return { fired: false, why: "not_allowed" };
        if (await deps.wallWait?.(win)) return { fired: false, why: "wall_wait" };
        const shouldFire = (m: TurnState["main"]) => m === "busy" || (stop && m === "unknown");
        // 事件态在按停之后、bridge 重启后、终端里自己开的回合上都不准；中止本身幂等（wf2 pi-3）
        const askRuntime = stop && controlFor(runtime, transport).abortVia === "extension";
        const { main } = askRuntime ? { main: "busy" as const } : await deps.probe(win, runtime, agent, channelId);
        if (main === "unknown" && !stop) console.warn(`⚠️ ${win} 忙闲判据失效（TUI 文案可能已变），跳过自动打断`);
        if (!shouldFire(main)) return { fired: false, why: "not_busy" };
        // 只对看画面的运行时（CC）复核：撞墙菜单 / 倒计时只有 CC 有，Codex / Pi 的忙闲来自 hook，多等这一拍没有用
        if (deps.wallWait && controlFor(runtime).paneHeuristics && !askRuntime) {
          await deps.sleep(RECHECK_MS);
          if (await deps.wallWait(win)) return { fired: false, why: "wall_wait" };
          if (!shouldFire((await deps.probe(win, runtime, agent, channelId)).main)) return { fired: false, why: "not_busy" };
        }
        if (opts.wanted && !opts.wanted()) return { fired: false, why: "withdrawn" }; // 等的这段时间里不需要了；发键那一刻 interrupt 自己再问一次
        lastKeyAt.set(channelId, now());
        lastManual.delete(channelId);
        const keys = await deps.interrupt(win, runtime, channelId, "preempt", opts.wanted);
        if (!keys.length) return { fired: false, why: "no_keys" };
        deps.onPreempted(agent, channelId);
        await deps.sleep(SETTLE_MS);
        // 只对看画面的运行时（CC）复核：Codex / Pi 的忙闲来自 hook，打断回报可能晚于这一拍，复核会误判成没打断
        if (controlFor(runtime).paneHeuristics && (await deps.probe(win, runtime, agent, channelId)).main === "busy") {
          console.warn(`⚠️ ${win} 发了 ${keys.join(" ")} 画面仍在忙（焦点可能在浮层 / copy-mode），不当成已打断`);
          return { fired: false, why: "ineffective" };
        }
        return { fired: true };
      });
    },

    /**
     * 手动打断（停止按钮 / /interrupt / API）：人明确要停，不看画面判据，按运行时发键（Codex 自己只在忙时发 Esc）。
     * 离上一次发键不足 MANUAL_GAP_MS：上一次也是停止（双击、按钮 + API 同时到）就去重；上一次是自动抢占就等够再发
     * （和停字一样）——抢占后紧接着按停，要停的是插话刚开的那一回合，去重掉就一个键都没发。发键出错原样抛给调用方回报。
     * 停在额度菜单 / 撞墙倒计时上谁按都不发（wall: true）：Esc 会取消 owner 排好的自动续跑（adv3 P2-4），调用方如实回报
     */
    manual(channelId: string, win: string, runtime: string | undefined): Promise<{ keys: readonly string[]; deduped?: true; wall?: true }> {
      return serial(channelId, async () => {
        if (deps.wallWait && (await deps.wallWait(win))) return { keys: [], wall: true as const };
        const since = sinceKey(channelId);
        if (since <= MANUAL_GAP_MS && lastManual.has(channelId)) return { keys: [], deduped: true as const };
        if (since <= gapAfter(channelId)) await deps.sleep(gapAfter(channelId) - since + 50);
        const keys = await deps.interrupt(win, runtime, channelId, "manual");
        if (keys.length) lastKeyAt.set(channelId, now()), lastManual.add(channelId);
        return { keys };
      });
    },
  };
}
