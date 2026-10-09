/**
 * MQWATCH1：合并待 PM 处置的台账巡检兜底。候选只认 MQWAKE1 的正规事实入口 mergePmCandidate（scheduler-merge-pm-wait.ts），不另判请求 / 截图；
 * 开关同一个 autostart.mergePmWait（mergePmMode）。on：同一阻塞实例（卡 + head + specRev + 轮次 + 请求 + 候选阻塞键）满 10 分钟报一条任务级发现，
 * 建议照抄候选正文里的「下一步」；计时从进 merge 与最后一条非 note / memory / ask 事件里晚的那个算，note、memory 不重置。observe：只算候选，
 * 有候选写进 skipped 做本机诊断、不 evaluated、不报（没有候选照常 evaluated）；off（含开关读不了，本机记一行诊断）：本规则不写不发。候选 / 交接配置 / 旧发现读不了 → skipped。
 * 不 evaluated 的几条路（off / observe 有候选 / 读不了）都把本规则开着的旧发现 keep 住：保持打开、但不进 pending——on 时落库没送达的，切到 off / observe 后也不再发。
 * 发现只看候选与时长，跟有没有 audit_baseline 无关（dry-run 也照出）；on 时恒 evaluated。上线首轮不吞提醒、也不卡对账：本规则在
 * ledger-audit-store.ts 的 NO_SILENCE_RULES 里，第一次 evaluated 照建基线、但不把没推过的发现记成已推——没送达 / PM 不在的一直留在 pending
 * 等真实 ack（重启不丢），已解的当轮结清。
 * 落库 / 去重 / 发送走原巡检（ledger-audit-store.ts、bridge/ledger-audit-service.ts），收件人与调度主提醒同一位（mergePmTarget）。
 * 只读：不改请求、审批、截图、审查、阶段、意图、槽或权限。tests/ledger-audit-merge-pm.test.ts；docs/architecture/ledger-audit.md。
 */
import type { Database } from "bun:sqlite";
import type { AuditFinding, AuditRule, AuditSnapshot } from "./ledger-audit.js";
import { currentStageMark, stageTimeline } from "./ledger-metrics.js";
import { isAskEvent, type LedgerEvent } from "./ledger-stages.js";
import { openFindings } from "./ledger-audit-store.js";
import { listTasks } from "./ledger-store.js";
import type { HandoffPort } from "./manual-merge-queue-facts.js";
import { readSchedulerConfig } from "./scheduler-config.js";
import { mergePmMode, type MergePmMode } from "./scheduler-merge-pm-ledger.js";
import { mergePmCandidate, mergePmTarget } from "./scheduler-merge-pm-wait.js";

const MIN = 60_000;
export const MERGE_PM_RULES = ["merge_pm_blocked"] as const;
export const MERGE_PM_AUDIT_MS = 10 * MIN;

/** 一张卡的候选（mergePmCandidate 原样带过来）；to = 调度主提醒的收件 PM（null = 按巡检通用收件人） */
interface MergePmFact {
  taskId: string; key: string; request: number | null; head: string; specRev: number; round: number; text: string; to: string | null;
}
/** 本规则在本项目还开着的发现 */
interface MergePmOpen { key: string }
/** undefined = 快照没带（规则不跑）；unreadable = 候选 / 配置 / 旧发现读不了（skipped，旧发现不关也不推） */
export type MergePmInputs = {
  mergePm?: ({ mode: MergePmMode; why?: string; candidates: readonly MergePmFact[] } | { unreadable: string })
    & { open: readonly MergePmOpen[] };
};

type Emit = (f: Omit<AuditFinding, "project" | "notify" | "key"> & { keyParts: (string | number)[]; notify?: string | null }) => void;
interface Out {
  emit: Emit; evaluated: AuditRule[]; skip: (reason: string, ...rules: AuditRule[]) => void; keep: (rule: AuditRule, keyParts: (string | number)[]) => void;
}

/** 阻塞从哪一刻算：进 merge 与之后最后一条「改状态」的事件（note / memory / ask 一族不算）里晚的；导入近似时间 = null（不判） */
function mergePmSince(events: readonly LedgerEvent[], now: number): number | null {
  if (currentStageMark(events)?.data.approxTime === true) return null;
  const from = stageTimeline(events, now).at(-1)?.from ?? null;
  if (from === null) return null;
  return Math.max(from, events.findLast((e) => e.ts >= from && e.kind !== "note" && !isAskEvent(e))?.ts ?? from);
}

/** 调度主提醒对这一实例记到哪了（只读台账里的 merge_pm_wait note）；只写进正文，不当阻塞已解 */
function told(events: readonly LedgerEvent[], key: string): string {
  const mine = events.filter((e) => e.kind === "note" && e.data.op === "merge_pm_wait" && e.data.key === key).map((e) => e.data.kind);
  return mine.includes("sent") ? "调度主提醒已送达过，阻塞仍在" : mine.includes("try") ? "调度主提醒记了发送意图、未确认送达"
    : mine.includes("would") ? "调度主提醒只有 observe 记录" : "调度主提醒没有记录";
}

/** 候选正文拆成现象与「下一步」（同源，不另写步骤） */
function split(text: string): { what: string; steps: string } {
  const m = /^\[合并待处置\] ([\s\S]*?)。下一步：([\s\S]*)。阻塞键 [0-9a-f]+$/.exec(text);
  return m ? { what: m[1]!, steps: m[2]! } : { what: text, steps: "按合并待处置提醒核对请求 / 截图 / 审查" };
}

export function mergePmAudit(s: AuditSnapshot & MergePmInputs, now: number, out: Out): void {
  const m = s.mergePm;
  if (m === undefined) return;
  const pre = `${s.project}|merge_pm_blocked|`; // 同 ledger-audit.ts 的 keyOf
  // 不 evaluated 的路：旧发现保持打开，且 keep 住不进 pending（off / observe / 读不了都不发本规则的通知）
  const hold = (reason: string) => {
    for (const o of m.open) out.keep("merge_pm_blocked", [o.key.slice(pre.length)]);
    out.skip(reason, "merge_pm_blocked");
  };
  if ("unreadable" in m) return hold(m.unreadable);
  if (m.mode === "off") return hold(m.why ?? "mergePmWait 为 off：本规则不写不发");
  // observe：一张候选都没有 = 可核实没有阻塞，照常 evaluated（建基线、结清旧的）；有候选只写诊断不报，旧发现保持打开不推
  if (m.mode === "observe" && !m.candidates.length) return void out.evaluated.push("merge_pm_blocked");
  if (m.mode === "observe") return hold(`mergePmWait 为 observe：只诊断不报，候选 ${m.candidates.map((c) => c.taskId).join("、")}`);
  const byId = new Map(s.tasks.map((t) => [t.task.id, t]));
  const unknown = new Set(s.mergeUnknown?.map((r) => r.taskId));
  for (const c of m.candidates) {
    const t = byId.get(c.taskId);
    const since = t && !unknown.has(c.taskId) ? mergePmSince(t.events, now) : null;
    if (!t || since === null) continue;
    const keyParts = [c.taskId, c.head, `s${c.specRev}`, `r${c.round}`, c.request ?? "none", c.key];
    if (now - since <= MERGE_PM_AUDIT_MS) { out.keep("merge_pm_blocked", keyParts); continue; }
    const { what, steps } = split(c.text);
    out.emit({ rule: "merge_pm_blocked", taskId: c.taskId, since, keyParts, ...(c.to ? { notify: c.to } : {}),
      detail: `${what}；同一阻塞已 ${Math.floor((now - since) / MIN)} 分钟（note / memory 不重置）；${told(t.events, c.key)}；阻塞键 ${c.key}`,
      suggestion: steps });
  }
  out.evaluated.push("merge_pm_blocked");
}

/** 交接配置读不了就抛（候选读不全，整条规则 skipped），不像 configHandoff 那样按非交接继续 */
const strictHandoff: HandoffPort = (project) => readSchedulerConfig().projects[project]?.mergeHandoff === true;

/** 快照来源（ledger-audit-snapshot.ts）：开关、各 merge 卡的候选与收件 PM，全从同一个只读连接现读 */
export function readMergePm(db: Database, project: string, now: number, handoff: HandoffPort = strictHandoff): NonNullable<MergePmInputs["mergePm"]> {
  let open: MergePmOpen[];
  try {
    open = openFindings(db, project).filter((f) => f.rule === "merge_pm_blocked")
      .map((f) => ({ key: f.key }));
  } catch (e) {
    console.error(`⚠️ [ledger-audit] ${project} 合并待处置旧发现读不了：${(e as Error).message}`);
    return { unreadable: "合并待处置旧发现读不了（本机日志有诊断），旧发现保持打开", open: [] };
  }
  let mode: MergePmMode;
  try {
    const raw = mergePmMode(db, project) as string;
    mode = raw === "on" || raw === "observe" ? raw : "off";
  } catch (e) {
    console.error(`⚠️ [ledger-audit] ${project} 读 mergePmWait 失败，按 off：${(e as Error).message}`);
    return { mode: "off", why: "mergePmWait 开关读不了，按 off（本机日志有诊断）", candidates: [], open };
  }
  if (mode === "off") return { mode, candidates: [], open };
  try {
    const candidates = listTasks(db, project).filter((t) => t.stage === "merge").flatMap((t): MergePmFact[] => {
      const c = mergePmCandidate(db, t.id, now, handoff);
      return c ? [{ taskId: c.taskId, key: c.key, request: c.request, head: c.head, specRev: c.specRev, round: c.round, text: c.text,
        to: mergePmTarget(db, t.id) }] : [];
    });
    return { mode, candidates, open };
  } catch (e) {
    console.error(`⚠️ [ledger-audit] ${project} 合并待处置候选取不到：${(e as Error).message}`);
    return { unreadable: "合并待处置候选 / 交接配置读不了（本机日志有诊断），旧发现保持打开", open };
  }
}
