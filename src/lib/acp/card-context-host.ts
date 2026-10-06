/**
 * CTXA 宿主一侧：卡片会话的 usage / 接线代次 / 压缩记录，以及 card_context（查）、card_compact（申请）两个 acp_call 的处理。
 * 判定是 card-context.ts 的纯函数；这里保证「取状态 → 判定 → 交给回合循环」在同一段同步代码里完成（中间没有 await），
 * 所以查询之后开的回合、排的槽、换的接线都会让申请按代次对不上被拒，两个申请最多受理一个（受理的那一刻循环就忙了）。
 * 受理只经 AcpTurnLoop.submitCommand 带 opId 排一个独占槽，不发 session/cancel、不重启、不改模型；同一个 opId 再来只回原记录，
 * 记录淘汰了也只回 op-expired（opId 本身一直留着），不重放。
 * 两段受理（现行登记）：card_compact 核过后槽带 hold 占住调度器（prepared：不开别的回合，宿主状态冻住），回 bridge；bridge 重读台账登记
 * 发 card_commit，这里再核登记 / 接线才放行 /compact，否则作废（槽结局 revoked，不进模型）。等不到确认 commitMs 后作废。
 * 新回合受理边界（admit）：任何还没开、会进模型的一轮之前（/compact 命令本身除外），硬线以上先压缩一次；这一段超线已经压过一次
 * 还在线上（压缩失败 / 取消 / 没到完成边界）就拒开、给原因，直到预算恢复（线下 usage、压缩完成边界、换会话 / 接线）。
 * 单测 tests/acp-card-context-host.test.ts。
 */
import {
  bindingReject, CARD_COMPACT_TEXT, CARD_REJECT_TEXT, cardCompactVerdict, cardStatus, hardLineGate, hardOver, parseBinding, parseCardCompactRequest,
  type CardCtxMode, type CardReject, type CardCtxSnapshot, type CardIdentity, type CardOpRecord, type UsageSample,
} from "./card-context.js";
import type { AcpTurnLoop, AdmitHead, AdmitResult, SlotEnd } from "./turn.js";

export const CARD_OPS = new Set(["card_context", "card_compact", "card_commit"]);
const OPS_KEPT = 50;
/** prepared 之后等 bridge 确认的上限：bridge 回包 + 重读台账是毫秒级，超过就当确认丢了、作废 */
const COMMIT_MS = 10_000;
/** 预算恢复命令：用户 / 宿主自己的 /compact 不拦（拦了就永远恢复不了） */
const isCompactCommand = (h: AdmitHead) => h.kind === "command" && /^\/compact(\s|$)/i.test(h.text.trim());

/** 宿主此刻的连接 / 适配器状态（host.ts 现取现给） */
export interface CardHostState {
  sessionId: string;
  registered: boolean;
  capable: boolean;
  rotating: boolean;
  compacting: boolean;
  /** 适配器报线程 active（含它自发、还没被跟上的回合） */
  adapterRunning: boolean;
}

export interface CardHostDeps {
  hostId: string;
  loop: Pick<AcpTurnLoop, "busy" | "queued" | "turnGen" | "slotGen" | "running" | "idleSince" | "submitCommand">;
  identity: CardIdentity | null;
  mode: CardCtxMode;
  limits?: { idle?: number; hard?: number };
  /** 单测注入：prepared 等确认的上限，缺省 COMMIT_MS */
  commitMs?: number;
  now(): number;
  state(): CardHostState;
  log(msg: string): void;
}

export class CardContextHost {
  private attachGen = 0;
  private usage: UsageSample | null = null;
  /** 这一段超线已经发过的那次先压缩（预算恢复就清掉）：再超线就拒开，不再压 */
  private attempt: CardOpRecord | null = null;
  private observed: UsageSample | null = null;
  private readonly ops = new Map<string, CardOpRecord>();
  /** 受理过的全部 opId（完整记录淘汰了也留着）：防重放的依据，不随结果缓存一起删 */
  private readonly seen = new Set<string>();
  /** prepared、等 bridge 确认的那一个（受理时调度器空闲，确认前占住调度器，所以最多一个） */
  private pending: { r: CardOpRecord; release(ok: boolean): void; timer: ReturnType<typeof setTimeout> } | null = null;

  constructor(private readonly d: CardHostDeps) {}

  /** 适配器（重新）接上线程：接线代次加一，之前的 usage 一并作废 */
  noteAttach(): void {
    this.attachGen++;
  }

  /** 出站条目里的 context_usage / compact_boundary（updates.ts 翻出来的同形条目） */
  noteEntries(entries: readonly Record<string, unknown>[]): void {
    for (const e of entries) {
      if (e.type !== "system") continue;
      if (e.subtype === "context_usage" && typeof e.tokens === "number" && e.tokens > 0) {
        const size = typeof e.window === "number" && e.window > 0 ? e.window : null;
        const { sessionId } = this.d.state();
        this.usage = { used: e.tokens, size, sessionId, attachGen: this.attachGen, turnGen: this.d.loop.turnGen, at: this.d.now() };
      } else if (e.subtype === "compact_boundary") {
        if (this.usage) this.usage = { ...this.usage, compacted: true };
        for (const r of this.ops.values()) if (r.outcome === null) r.compacted = true;
      }
    }
  }

  onSlotEnd(e: SlotEnd): void {
    const r = this.ops.get(e.opId);
    if (r && r.outcome === null) r.outcome = e.outcome;
  }

  snapshot(): CardCtxSnapshot {
    const st = this.d.state();
    const loop = this.d.loop;
    return {
      mode: this.d.mode, identity: this.d.identity, hostId: this.d.hostId, attachGen: this.attachGen, sessionId: st.sessionId,
      turnGen: loop.turnGen, slotGen: loop.slotGen, registered: st.registered, capable: st.capable, rotating: st.rotating,
      compacting: st.compacting, running: loop.running || st.adapterRunning, queued: loop.queued,
      idleSince: st.adapterRunning ? null : loop.idleSince, usage: this.usage,
    };
  }

  /** card_context / card_compact；别的 op 回 null */
  call(m: Record<string, unknown>): Record<string, unknown> | null {
    if (m.op === "card_context") {
      const opId = typeof m.opId === "string" ? m.opId : undefined;
      const binding = parseBinding(m.binding) ?? null;
      const s = this.snapshot();
      const status = cardStatus(s, this.d.now(), this.d.limits, opId === undefined ? undefined : this.ops.get(opId) ?? null, binding);
      return { ok: true, status: { ...status, admission: this.admission(s) } };
    }
    if (m.op === "card_compact") return this.request(m);
    if (m.op === "card_commit") return this.commit(m);
    return null;
  }

  /** 申请：从取状态到交给回合循环全在这一段同步代码里 */
  private request(m: Record<string, unknown>): Record<string, unknown> {
    const req = parseCardCompactRequest(m);
    if (!req) return reject("bad-request");
    const prior = this.ops.get(req.opId);
    if (prior) return { ok: true, duplicate: true, op: { ...prior } };
    if (this.seen.has(req.opId)) return reject("op-expired");
    const s = this.snapshot();
    const now = this.d.now();
    const v = cardCompactVerdict(s, req, now, this.d.limits);
    if (!v.ok) return { ...reject(v.reason), ...(v.wouldFire ? { wouldFire: v.wouldFire } : {}), status: cardStatus(s, now, this.d.limits) };
    let release!: (ok: boolean) => void;
    const how = this.d.loop.submitCommand(CARD_COMPACT_TEXT, req.opId, new Promise<boolean>((res) => (release = res)));
    if (how !== "prompt") { // 判过空闲，到不了；防御：排进去的那个轮到时作废，不留排队的压缩
      release(false);
      return reject(how === "duplicate" ? "queued" : "running");
    }
    const r = this.record(req.opId, v.kind, s);
    r.commit = "pending";
    const timer = setTimeout(() => this.settle("commit-timeout"), this.d.commitMs ?? COMMIT_MS);
    (timer as { unref?(): void }).unref?.();
    this.pending = { r, release, timer };
    this.d.log(`卡片压缩已占住调度器 ${req.opId}（${v.kind}，${s.usage?.used} tokens），等 bridge 按现行登记确认`);
    return { ok: true, accepted: false, prepared: true, kind: v.kind, op: { ...r } };
  }

  /**
   * 确认：bridge 收到 prepared 后在同一段同步代码里重读台账登记带来。宿主状态从 prepared 起冻住（调度器占着），这里再核登记、
   * 接线 / 会话没换、适配器没自发开回合，才放行；任何一项不对就作废（不压缩）。同一个 opId 再确认只回已定的结论。
   */
  private commit(m: Record<string, unknown>): Record<string, unknown> {
    const binding = parseBinding(m.binding);
    if (typeof m.opId !== "string" || binding === undefined) return reject("bad-request");
    if (m.hostId !== this.d.hostId) return reject("old-host");
    const r = this.ops.get(m.opId);
    if (!r || !r.commit) return reject(this.seen.has(m.opId) ? "op-expired" : "not-prepared");
    if (r.commit === "committed") return { ok: true, accepted: true, duplicate: true, kind: r.kind, op: { ...r } };
    if (r.commit !== "pending") return { ...reject(r.commit), op: { ...r } };
    const s = this.snapshot();
    const st = this.d.state();
    const why: CardReject | null = s.mode === "off" ? "mode-off" : bindingReject(s, binding)
      ?? (!s.capable ? "no-capability" : !s.registered ? "not-registered" : s.attachGen !== r.attachGen ? "old-attach"
        : s.sessionId !== r.sessionId ? "old-session" : s.rotating ? "rotating" : st.adapterRunning ? "running" : null);
    this.settle(why ?? "committed");
    if (why) return { ...reject(why), op: { ...r } };
    this.d.log(`卡片压缩已受理 ${r.opId}（${r.kind}）`);
    return { ok: true, accepted: true, kind: r.kind, op: { ...r } };
  }

  /** 定下等确认的那一个：committed 放行 /compact，否则作废（槽结局 revoked） */
  private settle(verdict: "committed" | CardReject): void {
    const p = this.pending;
    if (!p) return;
    this.pending = null;
    clearTimeout(p.timer);
    p.r.commit = verdict;
    if (verdict !== "committed") this.d.log(`卡片压缩 ${p.r.opId} 作废：${CARD_REJECT_TEXT[verdict]}`);
    p.release(verdict === "committed");
  }

  /** 新回合受理边界的此刻状态（查询回包里给，供 bridge / 排障看）：blocked = 下一轮会被拒开的原因 */
  private admission(s: CardCtxSnapshot): { over: boolean; blocked: string | null } {
    const g = hardLineGate(s, this.d.limits);
    return { over: g !== null, blocked: g === "enforce" && this.attempt ? this.blockText(s) : null };
  }

  private blockText(s: CardCtxSnapshot): string {
    const o = hardOver(s, this.d.limits)!;
    const a = this.attempt!;
    const how = a.outcome === null ? "还没结束" : a.compacted ? `结局 ${a.outcome}，之后又超线` : `结局 ${a.outcome}，没到压缩完成边界`;
    return `卡片硬线：上下文 ${o.used} tokens ≥ ${o.hard}，先压缩（${a.opId}）${how}；这一轮不开。发 /compact 压下来（或 /clear）后再发`;
  }

  /**
   * 新回合受理边界（AcpTurnLoop.admit）：队首是 /compact 不管；预算恢复了（不再超线）清掉这一段的尝试、放行；
   * 超线且这一段还没压过 → 先压缩一次；压过了还超线 → 拒开（block），不重试、不放行。observe 只记一次日志。
   */
  admit(head: AdmitHead): AdmitResult {
    if (isCompactCommand(head)) return null;
    const s = this.snapshot();
    const g = hardLineGate(s, this.d.limits);
    if (!g) {
      if (!hardOver(s, this.d.limits)) this.attempt = null; // 只有真的不超线才算恢复（轮换 / 压缩中只是暂不判）
      return null;
    }
    if (g === "observe") {
      if (this.observed !== this.usage) this.d.log(`卡片硬线（observe）：${this.usage!.used} tokens，on 模式会在这一轮前先压缩`);
      this.observed = this.usage;
      return null;
    }
    if (this.attempt && this.attempt.attachGen === s.attachGen && this.attempt.sessionId === s.sessionId) {
      const block = this.blockText(s);
      this.d.log(`${block}（拒开 ${head.kind}）`);
      return { block };
    }
    const opId = `card-gate-${this.d.hostId}-${s.attachGen}-${s.turnGen}-${s.slotGen}`;
    this.attempt = this.record(opId, "gate", s);
    this.d.log(`卡片硬线：${this.usage!.used} tokens，下一轮前先压缩（${opId}）`);
    return { text: CARD_COMPACT_TEXT, opId };
  }

  private record(opId: string, kind: CardOpRecord["kind"], s: CardCtxSnapshot): CardOpRecord {
    const r: CardOpRecord = { opId, kind, acceptedAt: this.d.now(), hostId: s.hostId, attachGen: s.attachGen, sessionId: s.sessionId, outcome: null, compacted: false };
    this.ops.set(opId, r);
    this.seen.add(opId);
    for (const k of this.ops.keys()) if (this.ops.size > OPS_KEPT) this.ops.delete(k);
    return r;
  }
}

function reject(reason: keyof typeof CARD_REJECT_TEXT): Record<string, unknown> {
  return { ok: false, reason, error: CARD_REJECT_TEXT[reason] };
}
