/**
 * Codex 额度墙的运行时（T78；状态机在 lib/codex-wall.ts，生产依赖在 bridge/codex-wall-wiring.ts）。依赖全注入，
 * 单测 tests/codex-wall-runtime.test.ts 用假队列 / 假用量跑进墙、押后、出墙三个来源、恢复顺序、幂等与重启续做。
 *
 * 每 15 秒一拍：读一眼额度调度器的视图（不打接口）——没墙时用量满了就进墙；墙里重置卡变少（兑了卡）、每 5 分钟、
 * 到了 try-again 时刻各探一次 codex_usage（复用调度器的间隔与退避）；收 codex-wall clear 的请求。出墙后按
 * 「补投 → 续跑 → 收卡 → 告诉 caller → 告诉 owner」恢复，每步落盘，重启后从当前那步接着做。
 */
import { gatesAsHuman } from "../lib/quota-wall.js";
import {
  CODEX_WALL_TIMING, callersToTell, codexCallerText, codexExitVia, codexProbeDue, codexRecoveredNotice, codexResumeTargets, codexResumeText, codexWallActive, codexWallIdle,
  creditsDropped, enterFromUsage, isCodexAccountWall, markCodexExit, noteBelowAfterExit, noteCodexHit,
  type CodexExitVia, type CodexRecovery, type CodexUsageSignal, type CodexWall, type CodexWallState,
} from "../lib/codex-wall.js";
import type { Envelope } from "./router.js";

export interface CodexWallDeps {
  now(): number;
  newId(): string;
  load(): CodexWallState;
  save(s: CodexWallState): void;
  /** 这个频道的 agent 是不是 Codex（CC / Pi 不进这道墙） */
  isCodex(channelId: string): Promise<boolean>;
  /** 额度调度器视图里的 codex_usage；refresh = 先查一次（沿用调度器的间隔 / 退避）。null = 额度服务关着 / 没数据 */
  usage(refresh: boolean): Promise<CodexUsageSignal | null>;
  held: {
    /** 押着、原因是 Codex 额度墙的条数 */
    count(): number;
    /** 有墙押消息的频道（按最早入队排）/ 其中有自己人消息的（补投会叫醒它） */
    channels(): string[];
    wakers(): string[];
    /** 这个频道还押着自己人的消息（补投没送到、叫不醒它） */
    queuedFor(channelId: string): boolean;
    /** 墙押的消息转回普通押后（入队时间重置为现在），返回条数 */
    release(now: number): number;
  };
  flush(channelId: string): Promise<void>;
  mainTurnBusy(channelId: string, agent: string): Promise<boolean>;
  /** 投出去 true；不在线 / dropped false；被押住 "held"。afterTurn = 它正跑着刚补投的外人那一轮：等这一轮结束再送 */
  resume(channelId: string, agent: string, text: string, afterTurn?: boolean): Promise<boolean | "held">;
  /** 收起 Codex 未过期的额度卡，返回张数 */
  dismissCards(): Promise<number>;
  /** 推一条 notification 给 caller；不在线 / 没送到 false */
  tellCaller(callerChannelId: string, text: string): Promise<boolean>;
  notifyOwner(text: string): Promise<boolean>;
  takeClearRequest(): boolean;
  log(msg: string): void;
}

interface Ctx {
  d: CodexWallDeps;
  state: CodexWallState;
}

function set(c: Ctx, s: CodexWallState): void {
  c.state = s;
  c.d.save(s);
}

const patchWall = (c: Ctx, p: Partial<CodexWall>) => set(c, { v: 1, wall: { ...c.state.wall!, ...p } });

function exitWall(c: Ctx, via: CodexExitVia): void {
  if (!codexWallActive(c.state)) return;
  set(c, markCodexExit(c.state, via, c.d.now()));
  c.d.log(`🟢 Codex 额度墙出墙（${via}），开始恢复：补投 → 续跑 → 收卡 → 告诉 caller / owner`);
}

/** 恢复途中又撞墙会换成一道新墙（新 id、还没出墙）：旧恢复的进度不能写到新墙上 */
const stillRecovering = (c: Ctx, id: string): boolean => c.state.wall?.id === id && !!c.state.wall.exit;

function patchRecovery(c: Ctx, id: string, p: Partial<CodexRecovery>): boolean {
  if (!stillRecovering(c, id)) return false;
  patchWall(c, { recovery: { ...c.state.wall!.recovery!, ...p } });
  return true;
}

/** 墙里每一拍：兑卡 / 到点 / 每 5 分钟探一次，看出墙信号 */
async function watchWall(c: Ctx, now: number, seen: CodexUsageSignal | null): Promise<void> {
  const w = c.state.wall!;
  const cashed = !!seen && creditsDropped(w, seen.credits);
  if (cashed) c.d.log(`🎟 Codex 重置卡 ${w.credits} → ${seen!.credits}（兑了卡），马上复查用量`);
  let usage = seen;
  let probeDown: boolean | undefined;
  if (cashed || codexProbeDue(w, now)) {
    const atReset = w.resetsAt !== null && now >= w.resetsAt;
    patchWall(c, { lastProbeAt: now, ...(atReset ? { resetProbed: true } : {}) }); // 先记时刻：探失败也等下一个 5 分钟
    usage = await c.d.usage(true).catch(() => null); // 探失败 = 这次没有这个信号，clear / 到点照常
    probeDown = !usage || usage.observedAt < now - CODEX_WALL_TIMING.probeFreshMs; // 被间隔 / 冷却挡掉、只拿到旧快照也算没探成
    if (probeDown !== !!c.state.wall!.probeDown) {
      patchWall(c, { probeDown });
      c.d.log(probeDown ? "🔎 Codex 额度墙：用量探测不可用，只能等 try-again 时刻或人手 clear" : "🔎 Codex 额度墙：用量探测恢复了");
    }
  }
  if (usage && usage.credits !== null && usage.credits !== c.state.wall!.credits) patchWall(c, { credits: usage.credits });
  const via = codexExitVia(c.state.wall!, { now, usage, probeDown: probeDown ?? !!c.state.wall!.probeDown });
  if (via) exitWall(c, via);
}

async function deliverQueue(c: Ctx, id: string): Promise<void> {
  const channels = c.d.held.channels();
  // 先记账再转回普通押后：中途重启时条数不丢（已记过就不重记）
  if (c.state.wall!.recovery!.flushedTo === undefined && !patchRecovery(c, id, { flushed: c.d.held.count(), flushedTo: channels, wakers: c.d.held.wakers() })) return;
  c.d.held.release(c.d.now());
  for (const cid of c.state.wall!.recovery!.flushedTo ?? channels) {
    if (!stillRecovering(c, id)) return;
    await c.d.flush(cid).catch((e) => c.d.log(`Codex 额度墙补投 ${cid} 出错（留在队里，下一次触发再投）: ${(e as Error).message}`));
  }
  patchRecovery(c, id, { step: "resume" });
}

/** 续跑：补投了自己人消息、真送到了的不再续（那几条自会叫醒它）；在跑的不插话；补投的全是外人的照样续，押到那一轮结束（同 CC 闸） */
async function resumeAgents(c: Ctx, id: string): Promise<void> {
  const w = c.state.wall!;
  const woke = new Set(w.recovery!.wakers ?? w.recovery!.flushedTo ?? []);
  const flushed = new Set(w.recovery!.flushedTo ?? []);
  for (const cid of codexResumeTargets(w, (x) => woke.has(x) && !c.d.held.queuedFor(x))) {
    const h = w.hits[cid];
    const running = await c.d.mainTurnBusy(cid, h.agent).catch(() => true); // 判不出来按在跑：宁可少续一个，也不在它回合里插话
    const busy = running && !flushed.has(cid);
    if (!stillRecovering(c, id)) return;
    const r = structuredClone(c.state.wall!.recovery!);
    const got = busy ? null : await c.d.resume(cid, h.agent, codexResumeText(h.at), running).catch(() => false); // 没送到按没续：通知里不列它
    const add = (list: string[] = []) => (list.includes(h.agent) ? list : [...list, h.agent]);
    if (busy) r.running = add(r.running);
    else if (got === "held") r.held = add(r.held);
    else if (got) r.resumed = add(r.resumed);
    if (!patchRecovery(c, id, r)) return;
  }
  patchRecovery(c, id, { step: "cards" });
}

async function tellCallers(c: Ctx, id: string): Promise<void> {
  for (const [caller, agents] of callersToTell(c.state.wall!)) {
    const ok = await c.d.tellCaller(caller, codexCallerText(agents)).catch(() => false); // 没送到只记日志：它的回程还在，答复到了照常推
    if (!ok) c.d.log(`Codex 额度墙：告诉 caller ${caller} 没送到（不在线？），不重试`);
    if (!patchRecovery(c, id, { told: [...c.state.wall!.recovery!.told, caller] })) return;
  }
  patchRecovery(c, id, { step: "owner" });
}

/** 恢复五步，按 recovery.step 续做（重启后也从这里接上）；每步都核对还是同一道墙 */
async function recover(c: Ctx): Promise<void> {
  const id = c.state.wall!.id;
  const at = (step: CodexRecovery["step"]) => stillRecovering(c, id) && c.state.wall!.recovery?.step === step;
  if (at("flush")) await deliverQueue(c, id);
  if (at("resume")) await resumeAgents(c, id);
  if (at("cards")) {
    const n = await c.d.dismissCards().catch((e) => (c.d.log(`Codex 额度墙收卡出错（卡到点自己过期）: ${(e as Error).message}`), 0));
    patchRecovery(c, id, { cards: n, step: "callers" });
  }
  if (at("callers")) await tellCallers(c, id);
  if (!stillRecovering(c, id)) return c.d.log("Codex 额度墙：恢复途中又撞墙，旧恢复停下，名单里没续跑的带进新墙");
  if (!at("owner")) return;
  const text = codexRecoveredNotice(c.state.wall!);
  c.d.log(text.split("\n")[0]);
  if (await c.d.notifyOwner(text).catch(() => false)) patchRecovery(c, id, { step: "done" }); // 没发出去就下一拍重发
}

/** 没墙、上一道也恢复完了，队里却还有墙押的消息（状态文件丢了 / 手改过）：放回普通押后并补投，别让它们永远押着 */
async function releaseOrphans(c: Ctx): Promise<void> {
  if (!c.d.held.count()) return;
  const channels = c.d.held.channels();
  const n = c.d.held.release(c.d.now());
  c.d.log(`Codex 额度墙：没有墙却押着 ${n} 条墙消息，放回普通押后补投`);
  for (const cid of channels) await c.d.flush(cid).catch((e) => c.d.log(`补投 ${cid} 出错（留在队里）: ${(e as Error).message}`));
}

async function tickOnce(c: Ctx): Promise<void> {
  const now = c.d.now();
  if (c.d.takeClearRequest() && codexWallActive(c.state)) exitWall(c, "cli");
  const seen = await c.d.usage(false).catch(() => null); // 读不到视图：这一拍没有用量信号
  const below = noteBelowAfterExit(c.state, seen);
  if (below) set(c, below);
  if (codexWallIdle(c.state) && seen) {
    const r = enterFromUsage(c.state, seen, now, c.d.newId);
    if (r.entered) {
      set(c, r.state);
      c.d.log(`⛔ Codex 额度墙进墙（用量 ${seen.usedPct ?? "?"}%${seen.limitReached ? "，limitReached" : ""}）——发给 Codex agent 的 agent 消息押后，人类消息照投`);
    }
  }
  if (codexWallIdle(c.state)) await releaseOrphans(c);
  if (codexWallActive(c.state)) await watchWall(c, now, seen);
  if (c.state.wall?.exit && c.state.wall.recovery?.step !== "done") await recover(c);
}

export interface CodexHitEvent {
  channelId: string;
  agent: string;
  at: number;
  text: string;
  callers: string[];
}

export function createCodexWall(d: CodexWallDeps) {
  const c: Ctx = { d, state: d.load() };
  let ticking: Promise<void> | null = null;
  return {
    active: (): boolean => codexWallActive(c.state),
    snapshot: (): { active: boolean; wall: CodexWall | null; queued: number } => ({ active: codexWallActive(c.state), wall: c.state.wall, queued: d.held.count() }),

    /** 这个频道此刻在墙里：墙在、是 Codex agent */
    gates: async (channelId: string): Promise<boolean> => codexWallActive(c.state) && (await d.isCodex(channelId)),

    /** 这条消息此刻要不要押住：墙在、收件方是 Codex、不算人发的（与 CC 闸同口径 gatesAsHuman） */
    async holds(env: Envelope, channelId: string): Promise<boolean> {
      return !gatesAsHuman(env) && codexWallActive(c.state) && (await d.isCodex(channelId));
    },

    /** Codex agent 的回合以 ⛔ 结束（调用方已确认是 Codex 频道）。单个模型的额度不进墙，返回 false */
    async noteHit(e: CodexHitEvent): Promise<boolean> {
      if (!isCodexAccountWall(e.text)) return false;
      const account = (await d.usage(false).catch(() => null))?.account ?? null; // 读不到账号：墙不绑账号，换号认不出，其余照常
      const again = !!c.state.wall?.hits[e.channelId] && codexWallActive(c.state);
      const r = noteCodexHit(c.state, { ...e, account }, d.newId);
      set(c, r.state);
      const w = r.state.wall!;
      d.log(r.entered
        ? `⛔ Codex 额度墙进墙：${e.agent} 撞额度（try again ${w.resetsText ?? "未知"}）——发给 Codex agent 的 agent 消息押后，人类消息照投`
        : `⛔ Codex 额度墙：${e.agent} ${again ? "又撞了一次" : "也撞墙了"}（名单 ${Object.keys(w.hits).length} 个）`);
      return true;
    },

    /** 人工确认已恢复（CLI clear 之外的入口）；没墙返回 false */
    clear: (): boolean => codexWallActive(c.state) && (exitWall(c, "cli"), true),

    /** 上一拍还没做完就返回它（同一时刻只有一拍在跑：恢复步骤不会被并发做两遍） */
    tick: (): Promise<void> =>
      (ticking ??= tickOnce(c)
        .catch((e) => d.log(`Codex 额度墙 tick 出错（下一拍重试）: ${(e as Error).message}`))
        .finally(() => void (ticking = null))),
  };
}

export type CodexWallRuntime = ReturnType<typeof createCodexWall>;
