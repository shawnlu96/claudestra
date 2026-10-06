/**
 * 宿主的回合循环：所有「开一轮」都经同一个调度器，保证同一时刻只有一轮（ACP 规定，重叠会让两轮抢同一个线程）。
 * 队列里按到达顺序放四种槽：prompt（空闲时到的，或插不进的）、steer（_session/steering 在途，归属未定）、
 * external（适配器拿 steer 的消息自己另起了一轮，或适配器自发的一轮——track，已经在跑）、nudge（补 reply 提示）。调度规则：
 * 1. 有 steer 在途就什么都不开、也不算空闲：它可能已经让适配器另起了一轮（startedNewTurn 在新回合开始时就回，
 *    回包到之前那一轮已经在跑），这时再 prompt 就重叠了（tests/acp-turn.test.ts「steer 在途」）；
 * 2. 有 external 就先等它：它在适配器里已经在跑，不管排在哪；
 * 3. 否则按队首：nudge / command / op 单独一轮，连续的 prompt 拼成一轮。
 * 忙时到的消息先试 steering（插进当前回合，和 Pi 的 steer 一样即时生效），插不进就在原位置变回 prompt——并发失败也不乱序。
 * 例外：在跑的是 command / op（独占槽，如 /compact）时不 steer，消息按到达顺序排在它后面——插进压缩那一轮会被并进压缩前的历史。
 * 带 opId 的独占槽有单调代次 gen，可查（slotStatus / waitSlot）、可撤（cancelSlot 只撤排队的）；在跑的一律 uncancellable：
 * codex-acp 2.1.1 回包后才到的 session/cancel 会不会落到下一轮未证实（docs/runtimes/codex-acp.md 末节），所以不发任何取消。
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

/** 适配器叫停时清掉的排队消息（_claudestra/cancel 的结果）：cleared = 正文；clearedIds = 其中带宿主 deliveryId 的那几条（老适配器不给） */
export interface ClearedQueue {
  cleared: readonly string[];
  clearedIds?: readonly string[];
}

export interface TurnIO {
  prompt(text: string): Promise<PromptOutcome>;
  /** 插进正在跑的回合。必须有结果（宿主给请求设超时）：在途期间调度器不开新回合。不支持 steering 就不给。deliveryId = 这条的宿主身份 */
  steer?(text: string, deliveryId: string): Promise<SteerResult>;
  reportStop(r: StopReport): Promise<{ block?: boolean; reason?: string }>;
  /** 回合失败（额度 / 未登录 / 其它）：宿主转成结构化帧给 bridge 出卡 */
  onFailure(f: AcpFailure): void;
  /** 带 opId 的槽结束（含排队时被撤）：在挑下一轮之前同步调用 */
  onSlotEnd?(e: SlotEnd): void;
  log(msg: string): void;
}

/** 独占槽：command = 斜杠命令原样一轮；op = 编排器的一轮普通 prompt（如保存交接）。都不和相邻 prompt 拼，在跑时入站不 steer */
type Owned = { kind: "command" | "op"; text: string; opId?: string; gen: number };
export type SlotOutcome = PromptOutcome["kind"] | "revoked";
export interface SlotEnd { opId: string; gen: number; outcome: SlotOutcome }
export type SlotState =
  | { state: "queued" | "running"; opId: string; gen: number }
  | { state: "ended"; opId: string; gen: number; outcome: SlotOutcome }
  | { state: "gone"; opId: string };
/** revoked = 排队的已删掉；uncancellable = 正在跑（不发取消）；gone = 不认识 / 已结束 / 代次对不上 */
export type CancelSlotResult = "revoked" | "uncancellable" | "gone";

export const hookPromptText = (reason: string) => `<hook_prompt>${reason}</hook_prompt>`;

type Slot =
  | { kind: "prompt"; text: string }
  | Owned
  | { kind: "steer" }
  | { kind: "external"; done: Promise<PromptOutcome> }
  | { kind: "nudge"; text: string };

type Pick = { kind: "prompt" | "nudge"; text: string } | Owned | { kind: "external"; done: Promise<PromptOutcome> };
const owned = (s: Slot | Pick | null): s is Owned => s?.kind === "command" || s?.kind === "op";

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
  /** steer 进在跑回合（injected）的消息，只留最近 50 条：叫停时适配器清掉的按 deliveryId（老适配器按正文）对回 message_id（voided） */
  private steered: { text: string; id: string; deliveryId: string }[] = [];
  /** 调度器正在跑一轮（含上报）。steer 在途、调度器停着等它时为 false，但 busy 仍为 true */
  private pumping = false;
  private suspended = false;
  /** 调度器在跑的这一轮（含它的 Stop 上报）；带 opId 的独占槽在这期间算 running */
  private current: Pick | null = null;
  private gen = 0;
  /** 最近结束的带 opId 槽（只留 50 个）：结局上报丢了，bridge 还能按 opId + gen 查到真实结局 */
  private ended: SlotEnd[] = [];
  private waiters = new Map<string, ((s: SlotState) => void)[]>();

  constructor(private readonly io: TurnIO) {}

  /** 有一轮在跑、或者还有没落定 / 没开的槽 */
  get busy(): boolean {
    return this.suspended || this.pumping || this.slots.length > 0;
  }

  /** 会话轮转只在完全空闲时开始；挂起后新入站留在本宿主队列，不送往旧线程。 */
  suspendIfIdle(): boolean {
    if (this.busy) return false;
    this.suspended = true;
    return true;
  }

  resume(): void {
    this.suspended = false;
    this.pump();
  }

  get queued(): number {
    return this.slots.length;
  }

  /** 斜杠命令要独占一轮 session/prompt；steering 会把它变成普通文字。opId 已有在排 / 在跑的槽 = duplicate，不入队 */
  submitCommand(text: string, opId?: string): "prompt" | "queued" | "duplicate" {
    return this.submitOwned("command", text, opId);
  }

  /** 编排器的一轮普通 prompt（保存交接等）：独占一轮，不和前后的入站拼 */
  submitOp(text: string, opId: string): "prompt" | "queued" | "duplicate" {
    return this.submitOwned("op", text, opId);
  }

  private submitOwned(kind: Owned["kind"], text: string, opId?: string): "prompt" | "queued" | "duplicate" {
    if (opId && this.liveSlot(opId)) return "duplicate";
    const idle = !this.busy;
    this.slots.push({ kind, text, gen: ++this.gen, ...(opId ? { opId } : {}) });
    this.pump();
    return idle ? "prompt" : "queued";
  }

  private liveSlot(opId: string): Owned | undefined {
    if (owned(this.current) && this.current.opId === opId) return this.current;
    return this.slots.find((s): s is Owned => owned(s) && s.opId === opId);
  }

  /** 给了 gen 就只认这一代：在排 / 在跑的是别的代次时查它自己的结局，查不到回 gone */
  slotStatus(opId: string, gen?: number): SlotState {
    const live = this.liveSlot(opId);
    if (live && (gen === undefined || live.gen === gen)) return { state: live === this.current ? "running" : "queued", opId, gen: live.gen };
    const e = this.ended.findLast((x) => x.opId === opId && (gen === undefined || x.gen === gen));
    return e ? { state: "ended", ...e } : { state: "gone", opId };
  }

  /** 槽（给了 gen 就是这一代）不在排 / 在跑时立即给状态，否则等它结束（或被撤）；绝不挂到同 opId 的别的代次上 */
  waitSlot(opId: string, gen?: number): Promise<SlotState> {
    const live = this.liveSlot(opId);
    if (!live || (gen !== undefined && live.gen !== gen)) return Promise.resolve(this.slotStatus(opId, gen));
    return new Promise((resolve) => this.waiters.set(opId, [...(this.waiters.get(opId) ?? []), resolve]));
  }

  /**
   * 同步：只撤排队中、归属（opId，给了 gen 还要 gen）对得上的槽，什么取消都不发。在跑的回 uncancellable——
   * 不调 session/cancel、也不提前报 cancelled；停止按钮（abort.ts）照旧只管当前回合，这里不扩大它。
   */
  cancelSlot(opId: string, gen?: number): CancelSlotResult {
    const live = this.liveSlot(opId);
    if (!live || (gen !== undefined && live.gen !== gen)) return "gone";
    if (live === this.current) return "uncancellable";
    this.slots.splice(this.slots.indexOf(live), 1);
    this.endSlot(live, "revoked");
    this.pump();
    return "revoked";
  }

  private endSlot(s: Owned, outcome: SlotOutcome): void {
    if (!s.opId) return;
    const e: SlotEnd = { opId: s.opId, gen: s.gen, outcome };
    this.ended = [...this.ended.slice(-49), e];
    try {
      this.io.onSlotEnd?.(e);
    } catch (err) {
      this.log(`槽结局上报出错：${errText(err)}`);
    }
    const ws = this.waiters.get(s.opId) ?? [];
    this.waiters.delete(s.opId);
    for (const w of ws) w({ state: "ended", ...e });
  }

  /** 适配器自己开的一轮（session.ts onSelfTurn）：当 external 槽跟到它结束，Stop 上报 / 补 reply 与宿主自己的回合同一套 */
  track(done: Promise<PromptOutcome>): void {
    this.slots.push({ kind: "external", done: call(() => done).catch(failedOutcome) });
    this.pump();
  }

  /**
   * 适配器叫停时清掉的排队消息里，宿主 steer 进去的那几条的 message_id（abort_ack 的 voided）。带了 clearedIds 就只认身份：
   * 正文相同的两条一条已执行、一条被清掉时只报被清掉的（tests/acp-self-turn.test.ts「R18」）；没带（老适配器）才按正文对
   */
  voided({ cleared, clearedIds }: ClearedQueue): string[] {
    const hit = clearedIds ? (s: { deliveryId: string }) => clearedIds.includes(s.deliveryId) : (s: { text: string }) => cleared.includes(s.text);
    return this.steered.filter(hit).map((s) => s.id);
  }

  /** 收到一条入站消息。返回它怎么进的会话（日志 / 单测用）；messageId 记下来供叫停时对回作废的消息 */
  async submit(text: string, messageId?: string): Promise<"prompt" | "steer" | "queued"> {
    const steering = this.io.steer && !owned(this.current) && (this.pumping || this.slots.some((s) => s.kind === "steer"));
    if (!steering) {
      const idle = !this.busy;
      this.slots.push({ kind: "prompt", text });
      this.pump();
      return idle ? "prompt" : "queued";
    }
    // 先占位（到达顺序），再发 steer；落定之前调度器不会开新回合
    const slot: Slot = { kind: "steer" };
    this.slots.push(slot);
    const deliveryId = crypto.randomUUID();
    const r = await call(() => this.io.steer!(text, deliveryId)).catch((e): SteerResult => (this.log(`steering 出错，改排队：${errText(e)}`), { outcome: "failed" }));
    const at = this.slots.indexOf(slot);
    if (r.outcome === "injected") {
      this.slots.splice(at, 1);
      if (messageId) this.steered = [...this.steered.slice(-49), { text, id: messageId, deliveryId }];
    } else if (r.outcome === "startedNewTurn") {
      // done 登记时就接住：排到它之前就 reject 的话，不能变成 unhandled rejection（Bun 进程会以 1 退出）
      this.slots[at] = { kind: "external", done: call(() => r.done).catch(failedOutcome) };
    } else this.slots[at] = { kind: "prompt", text };
    this.pump();
    return r.outcome === "failed" ? "queued" : "steer";
  }

  /** 按规则挑下一轮；null = 没东西可开，或者要等 steer 落定 */
  private next(): Pick | null {
    if (this.suspended || !this.slots.length || this.slots.some((s) => s.kind === "steer")) return null;
    const ext = this.slots.findIndex((s) => s.kind === "external");
    if (ext >= 0) return this.slots.splice(ext, 1)[0] as Pick;
    const head = this.slots[0];
    if (head.kind === "nudge" || owned(head)) return this.slots.shift() as Pick;
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
        for (let p: Pick | null = first; p; p = this.next()) {
          this.current = p;
          const kind = await this.run(p).catch((e) => (this.log(`回合调度出错：${errText(e)}`), "failed" as const));
          this.current = null;
          if (owned(p)) this.endSlot(p, kind); // 先报结局、再挑下一轮：迟到的 cancelSlot 只会看到 ended，碰不到下一轮
        }
      } finally {
        this.current = null;
        this.pumping = false;
      }
    })();
  }

  private async run(p: Pick): Promise<PromptOutcome["kind"]> {
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
    return outcome.kind;
  }
}

const OP_ID = /^[\w:.-]{1,128}$/;
export const SLOT_OPS = new Set(["slash", "op_turn", "slot_status", "cancel_slot"]);
/** 宿主回给 bridge 的槽信息：hostId 区分宿主进程（重起后 gen 从头数），bridge 带回来核对 */
export type HostSlotState = SlotState & { hostId: string };

/**
 * 宿主的 acp_call 里与槽有关的四个 op（host.ts 一行转进来）；不是这几个回 null。cancel_slot 在收到帧的同一段同步完成。
 * 请求带的 hostId 不是本宿主（宿主重起过）→ 不认旧槽，回 gone，也不重放；slot_status 带 wait 时等槽结束才回。
 */
export function acpSlotCall(loop: AcpTurnLoop, m: Record<string, unknown>, hostId: string): Promise<Record<string, unknown>> | null {
  if (!SLOT_OPS.has(String(m.op))) return null;
  const text = String(m.text ?? "");
  if (m.op === "slash" && m.opId === undefined) return (loop.submitCommand(text), Promise.resolve({ ok: true })); // 独占下一轮 prompt，适配器才会识别命令
  const opId = typeof m.opId === "string" && OP_ID.test(m.opId) ? m.opId : "";
  if (!opId) return Promise.resolve({ ok: false, error: "opId 不合法" });
  const slot = (s: SlotState) => ({ ok: true, slot: { ...s, hostId } });
  if (m.op === "slash" || m.op === "op_turn") {
    const how = m.op === "slash" ? loop.submitCommand(text, opId) : loop.submitOp(text, opId);
    return Promise.resolve(how === "duplicate" ? { ok: false, error: `op ${opId} 已有排着 / 在跑的槽` } : slot(loop.slotStatus(opId)));
  }
  const gen = Number.isInteger(m.gen) ? (m.gen as number) : undefined;
  const foreign = typeof m.hostId === "string" && m.hostId !== hostId;
  if (m.op === "cancel_slot") return Promise.resolve({ ok: true, cancel: foreign ? "gone" : loop.cancelSlot(opId, gen), opId, hostId });
  if (foreign) return Promise.resolve(slot({ state: "gone", opId }));
  return m.wait === true ? loop.waitSlot(opId, gen).then(slot) : Promise.resolve(slot(loop.slotStatus(opId, gen)));
}

const SLOT_STATES = new Set(["queued", "running", "ended", "gone"]);
const SLOT_OUTCOMES = new Set(["done", "cancelled", "failed", "revoked"]);
const CANCEL_RESULTS = new Set(["revoked", "uncancellable", "gone"]);

/** bridge 收到的槽回包：形状、opId（以及请求带的 gen）都要和请求对上，否则 null（当宿主答错，不当结局） */
export function parseSlotReply(msg: Record<string, any>, opId: string, gen?: number): { slot?: HostSlotState; cancel?: CancelSlotResult } | null {
  if ("cancel" in msg) return CANCEL_RESULTS.has(msg.cancel) && msg.opId === opId ? { cancel: msg.cancel } : null;
  const s = msg.slot;
  if (!s || typeof s !== "object" || s.opId !== opId || typeof s.hostId !== "string" || !SLOT_STATES.has(s.state)) return null;
  if (s.state === "gone") return { slot: { state: "gone", opId, hostId: s.hostId } };
  if (!Number.isInteger(s.gen) || (gen !== undefined && s.gen !== gen)) return null;
  if (s.state === "ended" && !SLOT_OUTCOMES.has(s.outcome)) return null;
  return { slot: s.state === "ended" ? { state: "ended", opId, gen: s.gen, outcome: s.outcome, hostId: s.hostId } : { state: s.state, opId, gen: s.gen, hostId: s.hostId } };
}
