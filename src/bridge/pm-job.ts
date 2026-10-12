/**
 * PM 处理员在 bridge 里的两头（agents-PMJOB1，docs/architecture/pm-job.md）：
 * - intake：bridge/pm-digest.ts deliver() 在 PMROUTE1 判 judge 之后调。只接「受信执行者的 blocker 提问」那条台账通知
 *   （messageId = ledger-ask:<askId>，asks 表核实）；审查问、design / scope 默认定、测试类扩围自动批准、人类消息、非当班 PM 都不接。
 *   先把单子和草稿占位原子落盘：on 且代码没判成必须升级 → 原通知不投（PM 不被叫醒）；其余原通知照常送，只在后面附草稿路径。
 *   off 什么都不读不写，落盘失败照旧路送原通知。
 * - sweep（启动一次 + 定时，不靠新流量）：只投递 drafted 的单、对账 sending 的单、把超时没出结果的单升级；不起 worker、不跑模型。
 *   直回前在锁里重核 ask 仍开着、单没结清、规格没变、PM 没换人、开关和模式世代没变，然后先写 sending 再发；确认送达才 sent 并以
 *   system:pm-job 结案（只答单子文件绑定的那一个 ask）；结果不明标 unknown、原问题和草稿升级 PM，绝不重发。
 */
import type { Database } from "bun:sqlite";
import { answerAsk, getAsk, hasAsksTable, type Ask } from "../lib/ledger-asks.js";
import { getMeta, getTask } from "../lib/ledger-store.js";
import { isTestScopeAsk } from "../lib/order-ask-default.js";
import { assertOrderTakesAsks } from "../lib/order-ask-terminal.js";
import { askNoticeText } from "../lib/order-ask.js";
import { PmDigestStore } from "../lib/pm-digest-store.js";
import { forbiddenOf } from "../lib/pm-job-rules.js";
import { PmJobStore } from "../lib/pm-job-store.js";
import { pmJobAnswerText, pmJobDraft, pmJobEscalateLine, pmJobHintText, pmJobPendingLine, pmJobSummaryLine } from "../lib/pm-job-text.js";
import { PM_JOB_OPEN, type PmJob, type PmJobState } from "../lib/pm-job-types.js";
import { specHashOf } from "../lib/pm-job-worker.js";
import { activeProjectPm } from "../lib/pm-role.js";
import { classifyPmRoute } from "../lib/pm-route.js";
import { readSchedulerConfig } from "../lib/scheduler-config.js";
import { readTextSoft, specPathFor } from "../lib/task-spec.js";
import { ledgerDb } from "./ledger-feed.js";
import type { Envelope } from "./router.js";

const TICK_MS = 30_000;
/** 排队 / 运行超过这么久没出结果：bridge 接手升级（worker 之后写的结果落空） */
export const PM_JOB_DEADLINE_MS = 20 * 60_000;
const KEEP_MS = 7 * 24 * 3600_000;
export const PM_JOB_PRINCIPAL = "system:pm-job";
const ASK_NOTICE = /^ledger-ask:(ask_[A-Za-z0-9]+)$/;
const PATH_RE = /(?:src|tests|docs|scripts|web|skills|roles)\/[\w./*-]*[\w*]/g;

type Handed = { handed: boolean; note: string };
export interface PmJobBridgeDeps {
  store: PmJobStore;
  digest: PmDigestStore;
  now(): number;
  /** 台账只读连接 */
  db(): Database | null;
  /** asks 写连接（结案用） */
  askDb(): Promise<Database | null>;
  /** 本机投递（提问者 / PM）：原有的台账通知路径，handed = 已送达或已进押后队列 */
  notify(to: string, text: string, messageId: string): Promise<Handed>;
  /** 远端 worker@peer：和 PM 回 worker@peer 同一条路，true = 对方收下 */
  tell(a: Ask, text: string): Promise<boolean>;
  repoDir(project: string): string | null;
  readSpec(path: string): string | null;
}

const repoDirOf = (project: string): string | null => {
  try { return readSchedulerConfig().projects[project]?.repoDir ?? null; } catch { return null; }
};
const liveDeps = (): PmJobBridgeDeps => ({
  store: new PmJobStore(), digest: new PmDigestStore(), now: Date.now, db: ledgerDb, repoDir: repoDirOf, readSpec: readTextSoft,
  // 写连接和远端发送用到时才加载：pm-digest.ts 静态引用本模块，不把它们拖进它的加载图
  askDb: async () => (await import("./asks.js")).askDbIfExists(),
  // 本机投递口由班子路由启动时交来（start）：本模块不反过来引用班子路由
  notify: async () => ({ handed: false, note: "班子路由还没启动，没投" }),
  tell: async (a, text) => (await import("./ask-default-tell.js")).tellAsker(a, text),
});

const isRemote = (target: string): boolean => /^[^@]+@.+$/.test(target);
const cleanPath = (p: unknown): p is string => typeof p === "string" && !!p && !p.startsWith("/") && !p.split("/").some((s) => s === ".." || s === ".");

/** 这条 ask 处理员接不接：执行者经 ask 工具开的、挂卡、还开着的 blocker 提问；带默认做法的和测试类扩围有自己的 15 分钟自动定，不碰 */
function eligible(db: Database, a: Ask | null): a is Ask & { taskId: string; fromAgent: string } {
  return !!a && a.state === "open" && a.source === "reply" && a.kind === "decide" && a.extra.via === "mcp_ask" && a.blocking !== false
    && a.extra.class === "blocker" && !!a.taskId && !!a.fromAgent && typeof a.extra.orderId === "string" && !isTestScopeAsk(db, a);
}

export class PmJobBridge {
  readonly deps: PmJobBridgeDeps;
  /** 本进程正在发的单：扫单时不把它们当成「上次发到一半」 */
  private readonly sending = new Set<string>();
  /** 状态写不进、已经按原文升级过的单（只在本进程记）：补投的原通知不再被压下 */
  private readonly gaveUp = new Set<string>();
  private timer?: ReturnType<typeof setInterval>;
  private sweeping = false;

  constructor(deps: Partial<PmJobBridgeDeps> = {}) { this.deps = { ...liveDeps(), ...deps }; }

  /** bridge 启动时调一次（initTeamRouter 里一行，交来台账通知的投递口）：立刻扫一遍未完成的单，之后定时扫 */
  start(notify?: PmJobBridgeDeps["notify"], timer = true): void {
    if (notify) this.deps.notify = notify;
    const run = () => {
      if (this.sweeping) return;
      this.sweeping = true;
      void this.sweep().catch((e) => console.error("[pm-job] 扫单出错:", (e as Error).message)).finally(() => (this.sweeping = false));
    };
    run();
    if (!timer || this.timer) return;
    this.timer = setInterval(run, TICK_MS);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  /** 同步的门：不是执行者提问的台账通知、或开关 off，就完全不进 intake（这些信封的路径和顺序与改前逐字相同） */
  wants(env: Envelope, project: string): boolean {
    return ASK_NOTICE.test(env.meta.messageId) && env.from.kind === "bridge" && env.from.label === "ledger" && this.deps.store.mode(project) !== "off";
  }

  /** true = 原通知不投（处理员接下了，on 直回候选）。永不抛出：任何一步不成就按旧路送原通知 */
  async intake(env: Envelope, project: string, pm: string | undefined): Promise<boolean> {
    try {
      const askId = ASK_NOTICE.exec(env.meta.messageId)?.[1];
      if (!askId || !pm || !this.wants(env, project)) return false;
      const { store } = this.deps, mode = store.mode(project);
      const had = store.get(askId);
      if (had) return had.direct && PM_JOB_OPEN.includes(had.state) && !this.gaveUp.has(askId); // 同一条通知的补投：还在办的直回候选继续不投，其余照常送
      const route = classifyPmRoute({ fromKind: "bridge", sender: "ledger", intent: env.intent, triggerKind: env.meta.triggerKind,
        oneShot: !!env.meta.skipInterAgentWatchdog, body: env.content });
      if (!route.tags.every((t) => t.route === "judge")) return false; // owner 类原路
      const job = this.build(askId, env.meta.messageId, project, pm, mode);
      if (!job) return false;
      await store.create(job, pmJobDraft(job));
      if (job.direct) return true;
      env.content = `${env.content}\n${pmJobPendingLine(job)}`;
      return false;
    } catch (e) {
      console.error("[pm-job] 接单失败，原通知照常送:", (e as Error).message);
      return false;
    }
  }

  private build(askId: string, messageId: string, project: string, pm: string, mode: PmJob["mode"]): PmJob | null {
    const { store, now } = this.deps, db = this.deps.db();
    if (!db || !hasAsksTable(db)) return null;
    const a = getAsk(db, askId);
    if (!eligible(db, a) || a.project !== project) return null;
    const task = getTask(db, a.taskId), specPath = task && specPathFor(task, getMeta(db, project).docsDir);
    const spec = specPath ? this.deps.readSpec(specPath) : null, repoDir = this.deps.repoDir(project);
    if (!task || task.project !== project || !specPath || spec === null || !repoDir) return null; // 材料缺：不接，PM 照旧处理
    const globs = Array.isArray(task.extra.fileGlobs) ? task.extra.fileGlobs : [];
    const mentioned = [...`${spec}\n${a.body}`.matchAll(PATH_RE)].map((m) => m[0]);
    const paths = [...new Set([...globs, ...mentioned, "src/lib/order-standard-answers.ts"].filter(cleanPath))].slice(0, 80);
    const options = Array.isArray(a.extra.options) ? a.extra.options.map(String) : [];
    const forbidden = forbiddenOf([a.body, ...options].join("\n")), at = now(); // 候选项也是提问的一部分
    return {
      v: 1, askId, messageId, project, card: a.taskId, orderId: String(a.extra.orderId), target: a.fromAgent, pm, specRev: task.specRev, specPath,
      specHash: specHashOf(spec), repoDir, paths, question: a.body, options,
      mode, modeGen: store.gen(project), direct: mode === "on" && !forbidden, forbidden, state: "queued", createdAt: at, updatedAt: at,
      draftPath: store.draftPath(askId),
    };
  }

  /** 这张单还能不能直回：null = 能；closed = ask 已不在等回答（不用再打扰谁）；其余（含单已结清而提问还开着）是要升级给 PM 的原因 */
  private stale(job: PmJob): { closed: boolean; why: string } | null {
    const db = this.deps.db(), a = db && hasAsksTable(db) ? getAsk(db, job.askId) : null;
    if (!db || !a) return { closed: false, why: "台账里读不到这条提问" };
    if (a.state !== "open") return { closed: true, why: `提问已是 ${a.state}` };
    if (a.project !== job.project || a.taskId !== job.card || a.fromAgent !== job.target || job.messageId !== `ledger-ask:${a.id}`
      || a.extra.orderId !== job.orderId || !eligible(db, a)) return { closed: false, why: "单子与提问对不上" };
    try { assertOrderTakesAsks(db, job.orderId); } catch { return { closed: false, why: "单已结清" }; }
    if (this.deps.store.mode(job.project) !== "on" || this.deps.store.gen(job.project) !== job.modeGen) return { closed: false, why: "处理员开关已切换" };
    if (activeProjectPm(db, job.project) !== job.pm) return { closed: false, why: "当班 PM 已换人" };
    const spec = this.deps.readSpec(job.specPath), task = getTask(db, job.card);
    if (spec === null || specHashOf(spec) !== job.specHash || task?.specRev !== job.specRev) return { closed: false, why: "规格在提问之后改过" };
    return null;
  }

  async sweep(): Promise<void> {
    const { store, now } = this.deps;
    for (const job of store.list()) {
      try {
        if ((job.state === "queued" || job.state === "running") && now() - job.createdAt >= PM_JOB_DEADLINE_MS) await this.expire(job);
        else if (job.state === "sending" && !this.sending.has(job.askId)) await this.settle(job, "unknown", "上次发送后没有收到回执（进程中断），结果不明");
        else if (job.state === "drafted") await this.deliver(job);
        else if (job.pmNotice === "pending") await this.tellPm(job);
        else if (!PM_JOB_OPEN.includes(job.state) && now() - job.updatedAt >= KEEP_MS) store.remove(job.askId);
      } catch (e) {
        console.error(`[pm-job] ${job.askId} 这轮没办成，下轮再试:`, (e as Error).message);
        await this.giveUp(job).catch(() => { /* 这次没交出去：下一轮扫单还会走到这里 */ });
      }
    }
  }

  /** 过了时限状态还写不进（落盘失败）：不再等，原问题直接交 PM 一次；单子文件留着，修好后照常收尾 */
  private async giveUp(job: PmJob): Promise<void> {
    if (!job.direct || !PM_JOB_OPEN.includes(job.state) || this.gaveUp.has(job.askId) || this.deps.now() - job.createdAt < PM_JOB_DEADLINE_MS) return;
    this.gaveUp.add(job.askId);
    await this.escalate({ ...job, note: "处理员状态写不进" });
  }

  /** 超时没出结果：记成要升级的草稿，接着按 drafted 办 */
  private async expire(job: PmJob): Promise<void> {
    const reason = "处理员超时没有出结果";
    const result = { verdict: "escalate" as const, type: "unknown", answer: "", evidence: [], reason, pending: [] };
    const next = await this.deps.store.update(job.askId, ["queued", "running"], this.deps.now(), (j) => {
      const drafted: PmJob = { ...j, state: "drafted", result, finishedAt: this.deps.now(), lease: undefined };
      try { this.deps.store.writeDraft(j.askId, pmJobDraft(drafted)); } catch { /* 草稿写不进不挡升级 */ }
      return drafted;
    });
    if (next) await this.deliver(next);
  }

  private async deliver(job: PmJob): Promise<void> {
    if (!job.direct) return this.settle(job, "observed", job.result?.reason ?? "");
    if (job.result?.verdict !== "answer") return this.settle(job, "escalated", job.result?.reason ?? "没有结果");
    let stale: ReturnType<PmJobBridge["stale"]> = null;
    // 发前在锁里重核，核过才写 sending；之后再发
    const sending = await this.deps.store.update(job.askId, ["drafted"], this.deps.now(), (j) => ((stale = this.stale(j)) ? null : { ...j, state: "sending" }));
    if (!sending) {
      const s = stale as { closed: boolean; why: string } | null;
      if (s) await this.settle(job, s.closed ? "dropped" : "escalated", s.why);
      return;
    }
    this.sending.add(job.askId);
    try {
      const outcome = await this.send(sending);
      if (outcome === "sent") await this.close(sending);
      await this.settle(sending, outcome, outcome === "unknown" ? "发给提问者之后结果不明，没有重发" : outcome === "escalated" ? "代答没能交到提问者手上" : "");
    } finally { this.sending.delete(job.askId); }
  }

  /** 发一次，绝不重试：本机走台账通知路径，远端走 PM 回 worker@peer 的同一条路；抛错 / 远端没明确收下 = 不明 */
  private async send(job: PmJob): Promise<"sent" | "escalated" | "unknown"> {
    const text = pmJobAnswerText(job);
    try {
      if (isRemote(job.target)) return (await this.deps.tell({ fromAgent: job.target } as Ask, text)) ? "sent" : "unknown";
      return (await this.deps.notify(job.target, text, `pm-job-answer:${job.askId}`)).handed ? "sent" : "escalated";
    } catch (e) {
      console.error(`[pm-job] ${job.askId} 代答发送出错，按结果不明处理:`, (e as Error).message);
      return "unknown";
    }
  }

  /** 送达之后以 system:pm-job 结案：只答这张单绑定的那个 ask；这期间已被别人答了 / 撤了就算了 */
  private async close(job: PmJob): Promise<void> {
    try {
      const db = await this.deps.askDb();
      if (!db || getAsk(db, job.askId)?.state !== "open") return;
      answerAsk(db, job.askId, { choices: [], labels: ["处理员代答"], text: pmJobAnswerText(job), principal: PM_JOB_PRINCIPAL, via: "terminal",
        at: this.deps.now(), final: true });
    } catch (e) {
      console.error(`[pm-job] ${job.askId} 代答已送达但结案没写上（提问留着，PM 可照常回）:`, (e as Error).message);
    }
  }

  /** 写终态（先写再发，补投的原通知才不会又被 intake 压下），然后把该给 PM 的那条交出去 */
  private async settle(job: PmJob, state: Exclude<PmJobState, "queued" | "running" | "drafted" | "sending">, note: string): Promise<void> {
    const next = await this.deps.store.update(job.askId, ["drafted", "sending"], this.deps.now(), (j) =>
      ({ ...j, state, ...(note ? { note } : {}), ...(state === "dropped" ? {} : { pmNotice: "pending" as const }) }));
    if (next?.pmNotice === "pending") await this.tellPm(next);
  }

  private async tellPm(job: PmJob): Promise<void> {
    const handed = job.state === "sent" ? this.summarize(job) : job.state === "observed" ? await this.hint(job) : await this.escalate(job);
    if (handed) await this.deps.store.update(job.askId, [job.state], this.deps.now(), (j) => ({ ...j, pmNotice: "handed" }));
  }

  /** on 直回成功：一行摘要进 PM 摘要队列（不单独叫醒）；同 id 不重复入队 */
  private summarize(job: PmJob): boolean {
    const { digest, now } = this.deps, at = now();
    digest.record({ at, project: job.project, send: "digest", reason: "处理员代答摘要", source: "pm-job", kind: "sync", mode: digest.mode(job.project) },
      { id: `pm-job-sum:${job.askId}`, project: job.project, at, kind: "sync", source: "pm-job", card: job.card, firstLine: pmJobSummaryLine(job) });
    return true;
  }

  private async hint(job: PmJob): Promise<boolean> {
    const db = this.deps.db(), pm = this.currentPm(job);
    if (db && hasAsksTable(db) && getAsk(db, job.askId)?.state !== "open") return true; // PM 已经答了 / 提问撤了：不再补提示
    return !!pm && (await this.deps.notify(pm, pmJobHintText(job), `pm-job-draft:${job.askId}`)).handed;
  }

  /** 原问题（按台账里的提问重写原通知，沿用原 messageId）加草稿附注交给当班 PM；提问已不在等回答就不用发了 */
  private async escalate(job: PmJob): Promise<boolean> {
    const db = this.deps.db(), a = db && hasAsksTable(db) ? getAsk(db, job.askId) : null, pm = this.currentPm(job);
    if (a && a.state !== "open") return true;
    if (!a || !pm) return false;
    const text = askNoticeText({ taskId: job.card, orderId: job.orderId, from: job.target, askId: job.askId, question: a.body, options: job.options, class: "blocker" });
    return (await this.deps.notify(pm, `${text}\n${pmJobEscalateLine(job, job.note ?? job.state)}`, job.messageId)).handed;
  }

  private currentPm(job: PmJob): string | null {
    const db = this.deps.db();
    return (db && activeProjectPm(db, job.project)) ?? job.pm;
  }
}

export const pmJob = new PmJobBridge();
