/**
 * `ledger verify <task>`：系统核对完成检查单（lib/ledger-probes.ts 判定、lib/ledger-verify-facts.ts 采事实），
 * 全部通过（或没过的项被 PM / owner 带理由豁免）才在同一事务里推 live → verified；否则记一条 verify 事件、不推、退出码 1。
 * `stage --to verified` 已经堵死（lib/ledger-write.ts VERIFY_HINT），进 verified 只有这一条路。--dry-run 只看结果不写库，执行者也能跑。
 */
import { LedgerError } from "../lib/ledger-store.js";
import {
  blockingSummary,
  checklistVerdict,
  judgeProbe,
  parseExtraChecks,
  planChecklist,
  PROBE_IDS,
  type ProbeId,
} from "../lib/ledger-probes.js";
import { collectPrStage, collectVerifyFacts, realFactsDeps, type FactsDeps } from "../lib/ledger-verify-facts.js";
import { recordVerify } from "../lib/ledger-write.js";
import { REPO_ROOT } from "../lib/repo-root.js";
import type { LedgerCli, Result } from "./ledger-context.js";
import type { CommandSpec } from "./ledger-write-cmds.js";

/** --waive a,b --text <理由>：只给这次没过的项，理由必填（写进事件，网页标黄显示） */
function parseWaivers(c: LedgerCli): Partial<Record<ProbeId, string>> {
  const raw = c.p.flags.waive;
  if (raw === undefined) return {};
  const ids = raw.split(",").map((s) => s.trim()).filter(Boolean);
  const bad = ids.filter((id) => !(PROBE_IDS as readonly string[]).includes(id));
  if (!ids.length || bad.length) throw new LedgerError("invalid", `--waive 要是探针 id（${PROBE_IDS.join(" / ")}），收到 ${raw}`);
  const reason = c.p.flags.text?.trim();
  if (!reason) throw new LedgerError("invalid", "豁免要带 --text <理由>");
  return Object.fromEntries(ids.map((id) => [id, reason]));
}

/** 纯逻辑错误（extra.checks 写错、豁免给错项）转成 invalid，CLI 按同一格式打印 */
function asInvalid<T>(fn: () => T): T {
  try {
    return fn();
  } catch (e) {
    throw e instanceof LedgerError ? e : new LedgerError("invalid", (e as Error).message);
  }
}

async function verify(c: LedgerCli): Promise<Result> {
  const task = c.task(c.p.pos[1]);
  const dryRun = c.p.bools.has("dry-run");
  if (dryRun) c.requireOwnOrManager(task, "看完成检查单");
  else c.requireManager(task.project, "跑完成检查");
  if (!dryRun && task.stage !== "live") {
    throw new LedgerError("invalid", `任务 ${task.id} 在 ${task.stage}，不在 live，不能进 verified；只看检查结果用 --dry-run`, { stage: task.stage });
  }
  const waivers = parseWaivers(c);
  const extraChecks = asInvalid(() => parseExtraChecks(task.extra.checks));
  const fd: FactsDeps = c.deps.factsDeps?.() ?? realFactsDeps(REPO_ROOT);
  const evidence = c.p.flags.evidence ?? null;
  const prStage = await collectPrStage(fd, task.pr || null);
  const plan = planChecklist({ hasPr: !!task.pr, files: prStage.pr?.files ?? null, extraChecks });
  const facts = await collectVerifyFacts(fd, { prStage, probes: plan.probes, evidence });
  const v = asInvalid(() => checklistVerdict(plan, plan.probes.map((id) => judgeProbe(id, facts)), waivers));
  const summary = blockingSummary(v, plan);
  const out = { result: v.result, checks: v.checks, checklistSource: plan.source, ...(summary ? { blocking: summary } : {}) };
  if (dryRun) return { ok: true, dryRun: true, task: task.id, ...out };

  const data = { checks: v.checks, checklistSource: plan.source, incomplete: plan.incomplete, evidence };
  const r = recordVerify(c.db, c.ctx(), { taskId: task.id, result: v.result, data, text: c.p.flags.text });
  if (r.duplicate) return { ok: r.event.data.result === "pass", task: r.row, event: r.event, duplicate: true }; // 重放：结论以当时记下的为准
  if (v.result === "pass") return { ok: true, moved: true, task: r.row, event: r.event, ...out };
  return { ok: false, code: "unverified", error: `检查单没过，任务留在 live：${summary}`, moved: false, task: r.row, event: r.event, ...out };
}

export const VERIFY_CMD: CommandSpec = {
  valued: ["evidence", "waive", "text", "dedup"],
  bools: ["dry-run"],
  usage: "verify <task> [--evidence <path>] [--waive <probe,...> --text <理由>] [--dry-run]",
  run: verify,
};
