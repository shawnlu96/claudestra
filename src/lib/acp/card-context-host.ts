/**
 * CTXA 宿主一侧：卡片会话的 usage / 接线代次 / 压缩记录，以及 card_context（查）、card_compact（申请）两个 acp_call 的处理。
 * 判定是 card-context.ts 的纯函数；这里保证「取状态 → 判定 → 交给回合循环」在同一段同步代码里完成（中间没有 await），
 * 所以查询之后开的回合、排的槽、换的接线都会让申请按代次对不上被拒，两个申请最多受理一个（受理的那一刻循环就忙了）。
 * 受理只经 AcpTurnLoop.submitCommand 带 opId 排一个独占槽，不发 session/cancel、不重启、不改模型；同一个 opId 再来只回原记录，不重放。
 * 新回合受理边界（admit）：硬线以上先压缩再放行，同一份 usage 只给一次。单测 tests/acp-card-context-host.test.ts。
 */
import {
  CARD_COMPACT_TEXT, CARD_REJECT_TEXT, cardCompactVerdict, cardStatus, hardLineGate, parseCardCompactRequest,
  type CardCtxMode, type CardCtxSnapshot, type CardIdentity, type CardOpRecord, type UsageSample,
} from "./card-context.js";
import type { AcpTurnLoop, SlotEnd } from "./turn.js";

export const CARD_OPS = new Set(["card_context", "card_compact"]);
const OPS_KEPT = 50;

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
  now(): number;
  state(): CardHostState;
  log(msg: string): void;
}

export class CardContextHost {
  private attachGen = 0;
  private usage: UsageSample | null = null;
  private gated: UsageSample | null = null;
  private observed: UsageSample | null = null;
  private readonly ops = new Map<string, CardOpRecord>();

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
      return { ok: true, status: cardStatus(this.snapshot(), this.d.now(), this.d.limits, opId === undefined ? undefined : this.ops.get(opId) ?? null) };
    }
    if (m.op === "card_compact") return this.request(m);
    return null;
  }

  /** 申请：从取状态到交给回合循环全在这一段同步代码里 */
  private request(m: Record<string, unknown>): Record<string, unknown> {
    const req = parseCardCompactRequest(m);
    if (!req) return reject("bad-request");
    const prior = this.ops.get(req.opId);
    if (prior) return { ok: true, duplicate: true, op: { ...prior } };
    const s = this.snapshot();
    const now = this.d.now();
    const v = cardCompactVerdict(s, req, now, this.d.limits);
    if (!v.ok) return { ...reject(v.reason), ...(v.wouldFire ? { wouldFire: v.wouldFire } : {}), status: cardStatus(s, now, this.d.limits) };
    const how = this.d.loop.submitCommand(CARD_COMPACT_TEXT, req.opId);
    if (how !== "prompt") return reject(how === "duplicate" ? "queued" : "running"); // 判过空闲，到不了；防御：不留排队的压缩
    const r = this.record(req.opId, v.kind, s);
    this.d.log(`卡片压缩已受理 ${req.opId}（${v.kind}，${s.usage?.used} tokens）`);
    return { ok: true, accepted: true, kind: v.kind, op: { ...r } };
  }

  /** 新回合受理边界（AcpTurnLoop.admit）：硬线以上先压缩；同一份 usage 只给一次，observe 只记一次日志 */
  admit(): { text: string; opId: string } | null {
    const s = this.snapshot();
    const g = hardLineGate(s, this.d.limits);
    if (!g || !this.usage) return null;
    if (g === "observe") {
      if (this.observed !== this.usage) this.d.log(`卡片硬线（observe）：${this.usage.used} tokens，on 模式会在这一轮前先压缩`);
      this.observed = this.usage;
      return null;
    }
    if (this.gated === this.usage) return null;
    this.gated = this.usage;
    const opId = `card-gate-${this.d.hostId}-${this.attachGen}-${s.turnGen}`;
    this.record(opId, "gate", s);
    this.d.log(`卡片硬线：${this.usage.used} tokens，下一轮前先压缩（${opId}）`);
    return { text: CARD_COMPACT_TEXT, opId };
  }

  private record(opId: string, kind: CardOpRecord["kind"], s: CardCtxSnapshot): CardOpRecord {
    const r: CardOpRecord = { opId, kind, acceptedAt: this.d.now(), hostId: s.hostId, attachGen: s.attachGen, sessionId: s.sessionId, outcome: null, compacted: false };
    this.ops.set(opId, r);
    for (const k of this.ops.keys()) if (this.ops.size > OPS_KEPT) this.ops.delete(k);
    return r;
  }
}

function reject(reason: keyof typeof CARD_REJECT_TEXT): Record<string, unknown> {
  return { ok: false, reason, error: CARD_REJECT_TEXT[reason] };
}
