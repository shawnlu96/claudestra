import type { FeatureProposalsPort, ProposalInput } from "./feature-proposals-api";
import {
  canDecide, cardExpired, parseOperations, parseReview, replyEntry, type ProposalEntry, type ProposerStatus, type ReviewCard,
} from "./feature-proposals-model";

/** owner 决定之后给的固定提示；unconfirmed = 503 / 断网，不自动重发，等 owner 手动重读 */
export type DecisionNotice = { kind: "done"; state: string } | { kind: "conflict" | "unconfirmed" | "forbidden" | "unsupported" | "failed" };
export type ReviewLoad = "idle" | "loading" | "ready" | "forbidden" | "unsupported" | "failed";
export interface ProposalsState {
  mine: ProposalEntry[]; latest: ProposalEntry | null; submitting: boolean; formError: ProposerStatus | null;
  access: "loading" | "ready" | "forbidden" | "failed"; role: "owner" | "member" | null; localProjectId: string | null;
  cards: (ReviewCard & { expired: boolean; decidable: boolean })[]; review: ReviewLoad;
  deciding: string | null; notice: DecisionNotice | null; unconfirmed: readonly string[];
}
const INITIAL: ProposalsState = { mine: [], latest: null, submitting: false, formError: null, access: "loading", role: null,
  localProjectId: null, cards: [], review: "idle", deciding: null, notice: null, unconfirmed: [] };
const failedLoad = (status: number): ReviewLoad => status === 403 ? "forbidden" : status === 502 ? "unsupported" : "failed";

/** 一个团队身份一份：表单提交、提案人状态、owner 待审列表共用；时钟只在轮询和回调里读 */
export class ProposalsController {
  private state = INITIAL;
  private raw: ReviewCard[] = [];
  private listeners = new Set<() => void>();
  private users = 0;
  private timer: ReturnType<typeof setInterval> | null = null;
  private ctrl = new AbortController();
  constructor(private port: FeatureProposalsPort, private project: string, private clock: () => number = Date.now, private pollMs = 15_000) {}
  subscribe = (fn: () => void) => { this.listeners.add(fn); return () => { this.listeners.delete(fn); }; };
  get = () => this.state;
  private set(patch: Partial<ProposalsState>) { this.state = { ...this.state, ...patch }; for (const fn of this.listeners) fn(); }
  /** 卡片的过期 / 可决定性按这一刻的时钟重算（打开期间到期的卡在下一次轮询变灰） */
  private regrade(patch: Partial<ProposalsState> = {}) {
    const now = this.clock(), next = { ...this.state, ...patch };
    this.set({ ...patch, cards: this.raw.map(c => ({ ...c, expired: cardExpired(c, now), decidable: canDecide(c, next.role, now, next.unconfirmed) })) });
  }

  start(): () => void {
    if (this.users++ === 0) {
      if (this.ctrl.signal.aborted) this.ctrl = new AbortController();
      void this.poll();
      this.timer = setInterval(() => void this.poll(), this.pollMs);
    }
    return () => {
      if (--this.users > 0) return;
      if (this.timer) clearInterval(this.timer);
      this.timer = null; this.ctrl.abort();
    };
  }

  async poll(): Promise<void> {
    this.regrade();
    const signal = this.ctrl.signal;
    if (this.state.access !== "ready") {
      const a = await this.port.access(signal);
      if (signal.aborted) return;
      if (a.status === 200) this.regrade({ access: "ready", role: a.role, localProjectId: a.localProjectId });
      else this.regrade({ access: a.status === 403 ? "forbidden" : "failed", review: a.status === 403 ? "forbidden" : this.state.review });
    }
    await Promise.all([this.loadMine(signal), this.loadReview(signal)]);
  }
  private async loadMine(signal: AbortSignal) {
    const r = await this.port.operations(signal);
    const mine = signal.aborted ? null : parseOperations(r, this.project);
    if (mine) this.set({ mine });
  }
  private async loadReview(signal: AbortSignal) {
    const local = this.state.localProjectId;
    if (this.state.access !== "ready" || !local) return;
    if (this.state.review === "idle") this.set({ review: "loading" });
    const r = await this.port.review(local, signal);
    if (signal.aborted) return;
    const cards = parseReview(r);
    if (cards) this.raw = cards;
    this.regrade({ review: cards ? "ready" : failedLoad(r.status) });
  }

  /** 返回 true = 本机已留记录（表单可以关）；没有 operation 的失败留在表单里显示 */
  async submit(input: ProposalInput): Promise<boolean> {
    if (this.state.submitting) return false;
    this.set({ submitting: true, formError: null });
    const entry = replyEntry(await this.port.submit(input, new AbortController().signal), input.title);
    if (!entry.operationId) { this.set({ submitting: false, formError: entry.status }); return false; }
    this.set({ submitting: false, latest: entry, mine: [entry, ...this.state.mine.filter(e => e.operationId !== entry.operationId)] });
    void this.loadMine(this.ctrl.signal);
    return true;
  }
  /** 提案人手动查一次：bridge 先问中心再回 */
  async check(operationId: string): Promise<void> {
    const old = this.state.mine.find(e => e.operationId === operationId);
    const entry = replyEntry(await this.port.operation(operationId, this.ctrl.signal), old?.title ?? "");
    if (this.ctrl.signal.aborted || entry.operationId !== operationId) return;
    this.set({ mine: this.state.mine.map(e => e.operationId === operationId ? entry : e),
      latest: this.state.latest?.operationId === operationId ? entry : this.state.latest });
  }

  /** 漂移 / 过期 / 非 owner / 结果未确认的卡不发请求；驳回必须有理由；409 重读列表；503 / 断网只提示，不重发 */
  async decide(proposalId: string, decision: "approve" | "reject", reason = ""): Promise<void> {
    this.regrade();
    const c = this.state.cards.find(x => x.proposalId === proposalId), local = this.state.localProjectId;
    if (!c?.decidable || !local || this.state.deciding || (decision === "reject" && !reason.trim())) return;
    this.set({ deciding: proposalId, notice: null });
    const r = await this.port.decide(local, { proposalId, decision, proposalDigest: c.proposalDigest, proposalRev: c.proposalRev,
      reason: decision === "reject" ? reason.trim() : "" }, this.ctrl.signal);
    if (this.ctrl.signal.aborted) return;
    if (r.status === 200 && r.body.ok === true) {
      this.set({ deciding: null, notice: { kind: "done", state: typeof r.body.state === "string" ? r.body.state : "" } });
      await Promise.all([this.loadReview(this.ctrl.signal), this.loadMine(this.ctrl.signal)]);
    } else if (r.status === 409) {
      this.set({ deciding: null, notice: { kind: "conflict" } });
      await this.loadReview(this.ctrl.signal);
    } else if (r.status === 0 || r.status === 503 || r.status === 202) {
      this.regrade({ deciding: null, notice: { kind: "unconfirmed" }, unconfirmed: [...this.state.unconfirmed, proposalId] });
    } else this.set({ deciding: null, notice: { kind: r.status === 403 ? "forbidden" : r.status === 502 ? "unsupported" : "failed" } });
  }
  /** owner 手动重读：清掉「结果未确认」的锁，按中心最新列表重新决定 */
  async reread(): Promise<void> {
    this.regrade({ unconfirmed: [], notice: null, ...(this.state.review === "failed" ? { review: "loading" as const } : {}) });
    await (this.state.access === "ready" ? this.loadReview(this.ctrl.signal) : this.poll());
  }
}

const registry = new Map<string, ProposalsController>();
/** 表单和面板挂在团队视图的不同位置，按团队身份共用同一份控制器 */
export function proposalsController(key: string, make: () => ProposalsController): ProposalsController {
  let c = registry.get(key);
  if (!c) { c = make(); registry.set(key, c); }
  return c;
}
