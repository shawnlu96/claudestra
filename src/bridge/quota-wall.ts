/**
 * 额度闸的运行时（T24；状态机在 lib/quota-wall.ts，生产依赖在 bridge/quota-wall-wiring.ts）。依赖全注入，单测
 * tests/quota-wall-runtime.test.ts 用假窗口 / 假队列跑进闸、押后、出闸三个来源、恢复顺序与重启续做。
 *
 * 每 15 秒一拍：没闸时只看一眼用量缓存（≥100 进闸）；闸内攒通知、扫窗口看「Limits reset」回显、每 5 分钟探一次用量、
 * 收 quota-wall clear 的请求；出闸后按「关菜单 → 补投 → 续跑」三步恢复，每步落盘，bridge 重启后从当前那步接着做。
 */
import {
  enterFromUsage, isHumanSender, exitVia, observeCache, wallUntil, markExit, noteOtherError, noteWallActivity, noteWallHit, notifyDue, probeDue, resumeTargets, wallActive,
  type UsageSignal, type Wall, type WallExitVia, type WallRecovery, type WallState,
} from "../lib/quota-wall.js";
import { recoveredNotice, wallNotice, wallResumeText } from "../lib/quota-wall-notice.js";
import { limitsResetEchoes, matchLimitMenu, wallHitOf } from "../lib/quota-wall-text.js";
import type { Envelope } from "./router.js";

/** 一个 Claude Code 窗口（含 master） */
export interface WallWindow {
  channelId: string;
  agent: string;
  win: string;
}

export interface QuotaWallDeps {
  now(): number;
  newId(): string;
  load(): WallState;
  save(s: WallState): void;
  /** 这个频道的 agent 是不是 Claude Code（Codex / Pi 不进闸）；查不到按是（master 不在 registry 里） */
  isClaudeCode(channelId: string): Promise<boolean>;
  /** 这个窗口开着 low-priority、照常在跑（状态栏「Lower priority until …」）：闸对它放行 */
  lowPriority?(channelId: string): Promise<boolean>;
  /** 此刻在册的 Claude Code 窗口（扫回显、关菜单用） */
  windows(): Promise<WallWindow[]>;
  /** 抓窗口画面（可见区 + 往上 historyLines 行历史，默认 30） */
  capture(win: string, historyLines?: number): Promise<string>;
  /** 关菜单前让窗口回到可交互（退出 copy-mode），tmux-helper 的 ensurePaneInteractive */
  prepare(win: string): Promise<unknown>;
  sendEsc(win: string): Promise<void>;
  mainTurnBusy(channelId: string, agent: string): Promise<boolean>;
  held: {
    /** 押着、原因是额度闸的条数 */
    wallCount(): number;
    /** 这个频道还有没投出去的消息 */
    queuedFor(channelId: string): boolean;
    /** 有额度闸消息的频道，按最早入队排序 */
    wallChannels(): string[];
    /** 额度闸消息转回普通押后（入队时间重置为现在，免得出闸后立刻按 30 分钟 / 24 小时老化），返回条数 */
    release(now: number): number;
  };
  flush(channelId: string): Promise<void>;
  /** 投出去了返回 true；不在线 / dropped 返回 false（不算续跑过）；被押住（窗口停在倒计时 / 菜单上）返回 "held" */
  resume(channelId: string, agent: string, text: string): Promise<boolean | "held">;
  notifyOwner(text: string): Promise<boolean>;
  /** T2b-2 只读用量接口；null = 这次没探成（关着 / 退避中 / 出错） */
  probe(): Promise<{ pct: number | null; observedAt: number } | null>;
  /** 持有的重置次数（只读，不触发查询）；拿不到 = null */
  credits(): Promise<number | null>;
  readCache(): UsageSignal | null;
  /** quota-wall clear 留下的请求：取走即删 */
  takeClearRequest(): boolean;
  sleep(ms: number): Promise<void>;
  log(msg: string): void;
}

/** 错误条目自己带出的「活动」（那句报错文本 / thinking 状态）在这么久内不算它又动了（同 lib/api-error-resume.ts） */
const ACTIVITY_GRACE_MS = 3_000;
/** Esc 之后等 CC 收起菜单、回到提示符，再补投 */
const MENU_SETTLE_MS = 1_500;

/** 闸的进程内上下文：状态（每次 set 同步落盘）、回显基线、出闸回调 */
interface Ctx {
  d: QuotaWallDeps;
  state: WallState;
  /** 每个窗口进闸后第一次看到的回显条数：之后变多才算 owner 用了卡（画面上旧的回显不算）。进程内，重启后重新取基线 */
  /** 窗口 → 进闸时画面上已有的「Limits reset」回显内容（limitsResetEchoes） */
  echoBase: Map<string, Set<string>>;
  exitListeners: ((via: WallExitVia) => void)[];
}

function set(c: Ctx, s: WallState): void {
  c.state = s;
  c.d.save(s);
}

/** 改当前闸（浅拷贝一层再落盘） */
const patchWall = (c: Ctx, p: Partial<Wall>) => set(c, { v: 1, wall: { ...c.state.wall!, ...p } });

function exitWall(c: Ctx, via: WallExitVia): void {
  if (!c.state.wall || c.state.wall.exit) return;
  set(c, markExit(c.state, via, c.d.now()));
  c.d.log(`🟢 额度闸出闸（${via}），开始恢复：关菜单 → 补投 → 续跑`);
  for (const cb of c.exitListeners) {
    try { cb(via); } catch (e) { c.d.log(`额度闸 onExit 回调出错: ${(e as Error).message}`); }
  }
}

/** 基线往上多抓这么多行历史：之后窗口变高、每拍的抓屏范围变大时露出来的旧回显，基线里已经有了 */
const ECHO_BASE_HISTORY = 2_000;

/** 进闸那一刻就给每个窗口记回显基线：等到第一拍（最多 15 秒后）才记，这期间用卡的回显会被当成旧的 */
async function baselineEchoes(c: Ctx): Promise<void> {
  c.echoBase.clear();
  for (const w of await c.d.windows()) {
    const seen = limitsResetEchoes(await c.d.capture(w.win, ECHO_BASE_HISTORY).catch(() => "")); // 抓不到当没有：之后真有回显只会更早出闸
    if (!c.echoBase.has(w.win)) c.echoBase.set(w.win, new Set(seen));
  }
}

async function sawLimitsReset(c: Ctx): Promise<boolean> {
  let seen = false;
  for (const w of await c.d.windows()) {
    const now = limitsResetEchoes(await c.d.capture(w.win).catch(() => "")); // 抓屏失败当画面空：这一拍看不到回显，下一拍再看
    const base = c.echoBase.get(w.win);
    if (base === undefined) c.echoBase.set(w.win, new Set(now));
    else if (now.some((e) => !base.has(e))) {
      c.d.log(`🎟 ${w.agent} 窗口出现「Limits reset」回显（用了重置卡）`);
      seen = true;
    }
  }
  return seen;
}

/** 闸内每一拍：到点发进闸通知、到点探用量、看出闸信号 */
async function watchWall(c: Ctx, now: number): Promise<void> {
  const w = c.state.wall!;
  if (notifyDue(w, now)) {
    const credits = await c.d.credits().catch(() => null); // 读不到卡数：通知里不写重置卡那行，别的照发
    const text = wallNotice(w, { now, queued: c.d.held.wallCount(), credits });
    c.d.log(`📣 额度闸通知 owner：${text.split("\n").join(" / ")}`);
    if (await c.d.notifyOwner(text).catch(() => false)) patchWall(c, { notifiedAt: now }); // 没发出去就不记，下一拍重发
  }
  let probe: { pct: number | null; observedAt: number } | null = null;
  if (probeDue(c.state.wall!, now)) {
    patchWall(c, { lastProbeAt: now }); // 先记时刻：探失败也等下一个 5 分钟，退避交给 T2b-2 的调度器
    probe = await c.d.probe().catch(() => null); // 探失败 = 这次没有这个信号，别的出闸来源照常
  }
  const cache = c.d.readCache();
  const seen = observeCache(c.state, cache);
  if (seen) set(c, seen);
  const via = exitVia(c.state.wall!, { now, limitsReset: await sawLimitsReset(c), probe, cache });
  if (via) exitWall(c, via);
}

/** 恢复途中又撞墙会换成一道新闸（新 id、还没出闸）：旧恢复的进度不能写到新闸上，也不能拿新闸押的消息去补投 */
const stillRecovering = (c: Ctx, id: string): boolean => c.state.wall?.id === id && !!c.state.wall.exit;

function patchRecovery(c: Ctx, id: string, p: Partial<WallRecovery>): boolean {
  if (!stillRecovering(c, id)) return false;
  patchWall(c, { recovery: { ...c.state.wall!.recovery!, ...p } });
  return true;
}

const ESC_RECHECK_MS = 300;

async function gatedNow(c: Ctx, channelId: string): Promise<boolean> {
  return wallActive(c.state) && (await c.d.isClaudeCode(channelId)) && !(await c.d.lowPriority?.(channelId));
}

async function closeMenus(c: Ctx, id: string): Promise<void> {
  const r = structuredClone(c.state.wall!.recovery!);
  const sent: WallWindow[] = [];
  for (const win of await c.d.windows()) {
    if (r.escSent.includes(win.channelId)) continue;
    const pane = await c.d.capture(win.win).catch(() => ""); // 抓不到画面就不发键：宁可留给人关，也不盲按（copy-mode 下抓到的也是实时画面）
    if (matchLimitMenu(pane)) {
      // copy-mode 里 Esc 只会让 tmux 退出 copy-mode：只对要发键的窗口先退出来，别把正在翻屏的别的窗口踢出去（T24 r2 P2-7）
      await c.d.prepare(win.win).catch((e) => c.d.log(`额度闸：${win.agent} 退出 copy-mode 失败（照发 Esc，之后复查）: ${(e as Error).message}`));
      await c.d.sleep(ESC_RECHECK_MS); // 发键前再看一眼：这段时间里 owner 自己关了 / 选了别的，就不发
      const again = await c.d.capture(win.win).catch(() => ""); // 抓不到就不发：宁可留给人关，也不盲按
      if (!matchLimitMenu(again)) {
        c.d.log(`额度闸：${win.agent} 的菜单在发 Esc 前已经变了，不发键`);
        continue;
      }
      await c.d.sendEsc(win.win);
      r.escSent.push(win.channelId);
      sent.push(win);
      c.d.log(`⎋ 关掉 ${win.agent} 的撞墙菜单（Esc，不选任何一项）`);
      if (!patchRecovery(c, id, { escSent: r.escSent })) return;
    } else if (/What do you want to do\?/.test(pane) && !r.manual.includes(win.agent)) {
      r.manual.push(win.agent);
      c.d.log(`⚠️ ${win.agent} 画面上有菜单但对不上已知撞墙菜单，不发键，留给人处理`);
    }
  }
  if (sent.length) await c.d.sleep(MENU_SETTLE_MS);
  // 发完再看一眼：菜单还在就不算关了（只发一次 Esc，不重试），列进通知让人处理
  r.escFailed = r.escFailed ?? [];
  for (const win of sent) {
    if (!matchLimitMenu(await c.d.capture(win.win).catch(() => ""))) continue; // 抓不到按已关：Esc 发出去了，下一次 owner 看屏自会发现
    r.escFailed.push(win.agent);
    c.d.log(`⚠️ ${win.agent} 发了 Esc 之后菜单还在，留给人处理`);
  }
  patchRecovery(c, id, { ...r, step: "flush" });
}

async function deliverQueue(c: Ctx, id: string): Promise<void> {
  const channels = c.d.held.wallChannels();
  // 先记账再转回普通押后：中途重启时条数不丢（已记过就不重记，否则重启后记成 0）；转回之后 Stop / 扫描也能投
  if (c.state.wall!.recovery!.flushedTo === undefined && !patchRecovery(c, id, { flushed: c.d.held.wallCount(), flushedTo: channels })) return;
  c.d.held.release(c.d.now());
  for (const cid of c.state.wall!.recovery!.flushedTo ?? channels) {
    if (!stillRecovering(c, id)) return;
    await c.d.flush(cid).catch((e) => c.d.log(`额度闸补投 ${cid} 出错（留在队里，下一次触发再投）: ${(e as Error).message}`));
  }
  patchRecovery(c, id, { step: "resume" });
}

async function resumeAgents(c: Ctx, id: string): Promise<void> {
  const w = c.state.wall!;
  const got = new Set(w.recovery!.flushedTo ?? []);
  // 补投真送到了（队空了）的不再续跑：那几条消息自会叫醒它。补投了还押着的（它停在撞墙等待画面、被判成忙）照样续跑，
  // 续跑是 bridge 消息、不因「回合中」押后，它跑完一轮 Stop 时押着的也就投了
  for (const cid of resumeTargets(w, (x) => got.has(x) && !c.d.held.queuedFor(x))) {
    const h = w.hits[cid];
    const busy = await c.d.mainTurnBusy(cid, h.agent).catch(() => true); // 判不出来按在跑：宁可少续一个，也不在它回合里插话
    if (!stillRecovering(c, id)) return;
    const r = structuredClone(c.state.wall!.recovery!);
    const got = busy ? null : await c.d.resume(cid, h.agent, wallResumeText(h.at, h.error));
    if (busy) r.running.push(h.agent);
    else if (got === "held") r.held = [...(r.held ?? []), h.agent];
    else if (got) r.resumed.push(h.agent);
    if (!patchRecovery(c, id, r)) return;
  }
  patchRecovery(c, id, { step: "done" });
}

/** 恢复三步，按 recovery.step 续做（重启后也从这里接上）；每步都核对还是同一道闸（途中又撞墙就停，交给新闸）；做完发出闸通知 */
async function recover(c: Ctx): Promise<void> {
  const id = c.state.wall!.id;
  if (stillRecovering(c, id) && c.state.wall!.recovery?.step === "menus") await closeMenus(c, id);
  if (stillRecovering(c, id) && c.state.wall!.recovery?.step === "flush") await deliverQueue(c, id);
  if (stillRecovering(c, id) && c.state.wall!.recovery?.step === "resume") await resumeAgents(c, id);
  if (!stillRecovering(c, id)) return c.d.log("额度闸：恢复途中又撞墙，旧恢复停下，名单里没续跑的带进新闸");
  const w = c.state.wall!;
  if (w.recovery?.step !== "done" || w.recoveredNotifiedAt !== undefined) return;
  const text = recoveredNotice(w);
  c.d.log(text.split("\n")[0]);
  if (await c.d.notifyOwner(text).catch(() => false)) patchWall(c, { recoveredNotifiedAt: c.d.now() }); // 没发出去就下一拍重发
}

async function tickOnce(c: Ctx): Promise<void> {
  const now = c.d.now();
  if (c.d.takeClearRequest() && wallActive(c.state)) exitWall(c, "cli");
  // 用量缓存 ≥100 也进闸；上一道闸恢复还在做时不看（它自己的旧缓存值）
  if (!wallActive(c.state) && (!c.state.wall || c.state.wall.recovery?.step === "done")) {
    const cache = c.d.readCache();
    const r = cache ? enterFromUsage(c.state, cache, now, c.d.newId) : null;
    if (r?.entered) {
      set(c, r.state);
      await baselineEchoes(c);
      c.d.log(`⛔ 额度闸进闸（用量缓存 ${cache!.weekPct ?? "?"}% / ${cache!.sessionPct ?? "?"}%）`);
    }
  }
  if (wallActive(c.state)) await watchWall(c, now);
  if (c.state.wall?.exit && c.state.wall.recoveredNotifiedAt === undefined) await recover(c);
}

/**
 * 一个回合以 API 错误结束（jsonl-watcher 的 api_error_turn）。返回 true = 闸接手了（记进续跑名单，不走 60 秒续跑、不升级报错）。
 * 撞墙原文才进闸；临时 429 之类在闸外照旧；闸内的任何 API 错误都等出闸再续跑。
 */
async function noteApiErrorIn(c: Ctx, e: { channelId: string; agent: string; at: number; error: string; text: string }): Promise<boolean> {
  if (!(await c.d.isClaudeCode(e.channelId))) return false;
  const parsed = wallHitOf(e.error, e.text, e.at);
  if (parsed) {
    const again = !!c.state.wall?.hits[e.channelId] && wallActive(c.state);
    const r = noteWallHit(c.state, { ...e, parsed }, c.d.newId);
    set(c, r.state);
    if (r.entered) await baselineEchoes(c).catch((err) => c.d.log(`额度闸取回显基线出错（第一拍再取）: ${(err as Error).message}`));
    c.d.log(r.entered
      ? `⛔ 额度闸进闸：${e.agent} 撞到 ${parsed.kind} 额度（重置 ${parsed.resetsText ?? "未知"}）——agent 消息押后，人类消息照投`
      : `⛔ 额度闸：${e.agent} ${again ? "又撞了一次" : "也撞墙了"}（名单 ${Object.keys(r.state.wall!.hits).length} 个）`);
    return true;
  }
  const other = noteOtherError(c.state, e);
  if (!other) return false;
  set(c, other);
  c.d.log(`⏸ 额度闸内 ${e.agent} 的回合以 API 错误结束（${e.error || "API Error"}）→ 出闸后续跑`);
  return true;
}

export function createQuotaWall(d: QuotaWallDeps) {
  const c: Ctx = { d, state: d.load(), echoBase: new Map(), exitListeners: [] };
  let ticking = false;
  return {
    /** 闸开着（出闸后恢复中不算：新消息照常投，押着的由恢复补投） */
    active: (): boolean => wallActive(c.state),
    /** 闸预计什么时候开（T14 调度器取下一次唤醒用）；没闸 / 重置时刻不明 = null */
    until: (): number | null => (wallActive(c.state) ? wallUntil(c.state.wall!) : null),
    /** 出闸时回调（T14 据此马上重排唤醒） */
    onExit(cb: (via: WallExitVia) => void): void {
      c.exitListeners.push(cb);
    },
    snapshot: (): { active: boolean; wall: Wall | null; queued: number } => ({ active: wallActive(c.state), wall: c.state.wall, queued: d.held.wallCount() }),

    /** 这个频道此刻在闸里：闸开着、是 Claude Code agent、没开 low-priority（开了的照常在跑）。Autopilot 据此让位、flush 据此只投人的 */
    gates: (channelId: string): Promise<boolean> => gatedNow(c, channelId),

    /** 这条消息此刻要不要押住：闸开着、收件方在闸里（gates）、不是人发的 */
    async holds(env: Envelope, channelId: string): Promise<boolean> {
      return !isHumanSender(env.from) && (await gatedNow(c, channelId));
    },

    noteApiError: (e: { channelId: string; agent: string; at: number; error: string; text: string }): Promise<boolean> => noteApiErrorIn(c, e),

    /** 它又真的动了：从续跑名单里拿掉，返回拿掉的那条（外人触发的那一轮不算数时要放回去：quota-wall-wiring rearmResume） */
    noteActivity(channelId: string, ts: number): { agent: string; error: string } | null {
      const hit = c.state.wall?.hits[channelId];
      const s = noteWallActivity(c.state, channelId, ts, ACTIVITY_GRACE_MS);
      if (!s || !hit) return null;
      set(c, s);
      return hit;
    },

    /** CLI clear 之外的人工出闸（网页按钮）；没闸返回 false */
    clear(): boolean {
      if (!wallActive(c.state)) return false;
      exitWall(c, "cli");
      return true;
    },

    async tick(): Promise<void> {
      if (ticking) return;
      ticking = true;
      try {
        await tickOnce(c);
      } catch (e) {
        d.log(`额度闸 tick 出错（下一拍重试）: ${(e as Error).message}`);
      } finally {
        ticking = false;
      }
    },
  };
}

export type QuotaWall = ReturnType<typeof createQuotaWall>;
