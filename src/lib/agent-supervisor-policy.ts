/**
 * agent 监护的处置表（i28-S1，docs/architecture/agent-supervisor.md）：故障种类 → 固定处置、次数上限、退避。纯函数，调度服务
 * （lib/agent-supervisor.ts）和 bridge（失败卡要不要推 owner，lib/agent-supervisor-bridge.ts）读同一张表，两边算出的「到没到上限」
 * 才对得上。次数一律从台账的监护事件数出来（lib/agent-supervisor-ledger.ts），不放内存：调度服务重启后上限照样作数。
 * 表的每一行都有单测钉住（tests/agent-supervisor-policy.test.ts）。
 */

/** overload = 模型满载 / 限流 / 5xx（适配器说能重试的）；cyber = 内容策略截断；dead = 宿主或窗口没了；stuck = 回合在跑却长时间没动静 */
export type FaultKind = "overload" | "cyber" | "dead" | "stuck" | "quota" | "auth";

/** resume = 同会话等一会儿续跑；recover = 同会话发固定恢复消息；restart = 重启接回原会话再补一句；report = 只报派活方（开卡给 owner 的照旧由 bridge 开） */
type SuperviseAction = "resume" | "recover" | "restart" | "report";

export interface SuperviseRule {
  action: SuperviseAction;
  /** 自动处置最多几次；0 = 不自动处置 */
  limit: number;
  /** 计数的范围：work = 同一件活（同一张单 / 同一条请求），hour = 同一个 agent 最近一小时 */
  scope: "work" | "hour";
  /** 第 n 次处置前至少要等多久（距上一次；第 1 次距故障出现） */
  backoffMs: readonly number[];
  /** 上限用完后报派活方时附的建议 */
  advice?: string;
}

export const HOUR_MS = 3600_000;

export const SUPERVISE_RULES: Record<FaultKind, SuperviseRule> = {
  // 续跑本身是 bridge 的 60 秒续跑（api-error-resume.ts RESUME_DELAY_MS），这里的退避与它一致
  overload: { action: "resume", limit: 3, scope: "work", backoffMs: [60_000, 60_000, 60_000] },
  cyber: { action: "recover", limit: 1, scope: "work", backoffMs: [0], advice: "改 Claude 同家审、标待换模型终审" },
  dead: { action: "restart", limit: 2, scope: "hour", backoffMs: [0, 5 * 60_000] },
  stuck: { action: "restart", limit: 2, scope: "hour", backoffMs: [0, 5 * 60_000] },
  quota: { action: "report", limit: 0, scope: "work", backoffMs: [] },
  auth: { action: "report", limit: 0, scope: "work", backoffMs: [] },
};

/** 宿主死与卡住共用重启额度：每个 agent 每小时最多 2 次重启，不分是哪种原因触发的 */
export const RESTART_FAULTS: readonly FaultKind[] = ["dead", "stuck"];

export type Decision =
  | { kind: "act"; action: Exclude<SuperviseAction, "report">; attempt: number; limit: number }
  | { kind: "wait"; untilMs: number; attempt: number }
  | { kind: "report"; attempts: number; limit: number; advice?: string };

/**
 * 这一次故障该怎么办。prior = 同一计数范围里之前每次自动处置的时刻（升序，已按 scope 筛好），faultAt = 这次故障被确认的时刻。
 * 上限用完 → report；退避没到 → wait；否则 act（attempt 从 1 数）。
 */
export function decide(kind: FaultKind, prior: readonly number[], faultAt: number, now: number): Decision {
  const rule = SUPERVISE_RULES[kind];
  const inScope = rule.scope === "hour" ? prior.filter((t) => now - t < HOUR_MS) : [...prior];
  if (rule.action === "report" || inScope.length >= rule.limit) {
    return { kind: "report", attempts: inScope.length, limit: rule.limit, ...(rule.advice ? { advice: rule.advice } : {}) };
  }
  const attempt = inScope.length + 1;
  const since = inScope.length ? inScope[inScope.length - 1] : faultAt; // 第 2 次起距上一次处置，第 1 次距故障出现
  const untilMs = since + (rule.backoffMs[attempt - 1] ?? rule.backoffMs[rule.backoffMs.length - 1] ?? 0);
  if (now < untilMs) return { kind: "wait", untilMs, attempt };
  return { kind: "act", action: rule.action, attempt, limit: rule.limit };
}

/** 适配器把 Codex 的 cyberPolicy 映射成 category=request、没有动作、标题是 OpenAI 的原文（~/.claude-orchestrator/acp/codex-acp-*）；只认这句原文 */
const CYBER_RE = /flagged for possible cybersecurity risk|cyber[_ ]?policy/i;

export const isCyberPolicy = (message: string): boolean => CYBER_RE.test(message);

/** 规格里的固定恢复消息（owner 定的措辞，改之前先问 PM） */
export const CYBER_RECOVERY_TEXT =
  "上一回合被内容策略截断，不是你的问题。这是给我们自己开源产品做的防御性代码审查，目的是确认保护是否生效；不写攻击代码，" +
  "不连真实服务或远端，只用单测和私有临时目录。已发现的问题按已有证据写进报告，不必再构造完整复现，没查完的面标未验证，然后照原单收尾。";

/** 一件在途的活：调度器派出的单，或别的 agent 发来、回程还挂着的请求 */
export type WorkRef =
  | { kind: "order"; taskId: string; intentId: string; step: string }
  | { kind: "call"; caller: string; callerChannelId: string; since: number };

export const workKeyOf = (w: WorkRef): string => (w.kind === "order" ? `order:${w.intentId}` : `call:${w.callerChannelId}:${w.since}`);

/** 重启接回原会话后补的那一句：只提醒接着做，不重发原单（原单在台账里，领单工具拿得到），已交付的不要再交 */
export function restartNudgeText(w: WorkRef, why: "dead" | "stuck"): string {
  const cause = why === "dead" ? "宿主或窗口退出了" : "回合长时间没有动静";
  const work = w.kind === "order"
    ? `原来的单（${w.taskId} 的 ${w.step}）。领单工具（take_order / take_review）可以重新取到同一张单；已经交付过的不要再交一次`
    : `原来的请求：${w.caller} 还在等你的答复，答完用 send_to_agent 回给它`;
  return `[监护] 上次中断了（${cause}，已自动重启并接回这个会话）。接着做${work}。`;
}

const FAULT_LABEL: Record<FaultKind, string> = {
  overload: "模型满载 / 限流", cyber: "被内容策略截断", dead: "宿主或窗口没了", stuck: "回合卡住不动", quota: "撞额度", auth: "登录失效",
};
const faultLabel = (k: FaultKind): string => FAULT_LABEL[k];

/** 报派活方的那一句：谁、什么故障、自动处置做过几次、建议 */
export function reportText(agent: string, w: WorkRef, kind: FaultKind, d: { attempts: number; limit: number; advice?: string }, detail = ""): string {
  const work = w.kind === "order" ? `${w.taskId} 的 ${w.step}` : `给 ${w.caller} 的答复`;
  const tried = d.limit ? `自动处置已做 ${d.attempts}/${d.limit} 次，没恢复` : "这类不自动处置";
  const tail = [detail && `（${detail.slice(0, 300)}）`, d.advice && `建议：${d.advice}`].filter(Boolean).join("；");
  return `[监护] ${agent} ${faultLabel(kind)}，${work}停着：${tried}${tail ? `；${tail}` : ""}`;
}
