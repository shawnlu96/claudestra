/**
 * `ledger verify <task>`：系统核对完成检查单（lib/ledger-probes.ts 判定、lib/ledger-verify-facts.ts 采事实），
 * 全部通过（或没过的项被 PM / owner 带理由豁免）才在同一事务里推 live → verified；否则记一条 verify 事件、不推、退出码 1。
 * `stage --to verified` 已经堵死（lib/ledger-write.ts VERIFY_HINT），进 verified 只有这一条路。--dry-run 只看结果不写库，执行者也能跑。
 * 探针（PR / 网页 / daemon）只认得本仓库：任务所属项目的目录里没有本仓库时只核证据文件。
 */
import { realpathSync } from "node:fs";
import { daemonsOfFromRepo } from "../lib/ledger-daemon-map.js";
import {
  blockingSummary,
  checklistVerdict,
  judgeProbe,
  parseExtraChecks,
  planChecklist,
  PROBE_IDS,
  type ChecklistPlan,
  type ProbeId,
} from "../lib/ledger-probes.js";
import { LedgerError } from "../lib/ledger-store.js";
import type { LedgerTask } from "../lib/ledger-stages.js";
import { collectPrStage, collectVerifyFacts, mainRepoRoot, realFactsDeps, type FactsDeps } from "../lib/ledger-verify-facts.js";
import { recordVerify } from "../lib/ledger-write.js";
import { REPO_ROOT } from "../lib/repo-root.js";
import type { LedgerCli, Result } from "./ledger-context.js";
import type { CommandSpec } from "./ledger-write-cmds.js";

/** --waive a,b --text <理由>：只给这次没过的项，理由必填（写进事件，网页标黄） */
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

const real = (p: string) => {
  try {
    return realpathSync(p);
  } catch {
    return p; // 目录不存在：按原样比（比不上就当不含本仓库）
  }
};

/** 项目目录里有没有本仓库的主工作树；拿不到项目目录（测试 / 老调用方）按有算 */
async function ownsRepo(c: LedgerCli, fd: FactsDeps, project: string): Promise<boolean> {
  const dirs = c.deps.projectDirs?.(project);
  if (!dirs) return true;
  const repo = await mainRepoRoot(fd);
  return !!repo && dirs.some((d) => real(d) === real(repo));
}

async function plan(c: LedgerCli, fd: FactsDeps, task: LedgerTask) {
  const extraChecks = asInvalid(() => parseExtraChecks(task.extra.checks));
  if (!(await ownsRepo(c, fd, task.project))) {
    const p: ChecklistPlan = { probes: ["manual-evidence"], source: "evidence", incomplete: false };
    return { plan: p, prStage: await collectPrStage(fd, null), note: `项目 ${task.project} 的目录里没有本仓库，只核证据文件（--evidence）` };
  }
  if (task.kind === "code" && !task.pr) throw new LedgerError("invalid", `code 任务 ${task.id} 没挂 PR（ledger task-set --pr）：代码改动要按 PR 核对上线`);
  const prStage = await collectPrStage(fd, task.pr || null);
  const daemonsOf = daemonsOfFromRepo((rel) => fd.readRepoFile(rel));
  return { plan: planChecklist({ hasPr: !!task.pr, files: prStage.pr?.files ?? null, extraChecks, daemonsOf }), prStage, note: null };
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
  const fd: FactsDeps = c.deps.factsDeps?.() ?? realFactsDeps(REPO_ROOT);
  const evidence = c.p.flags.evidence ?? null;
  const { plan: pl, prStage, note } = await plan(c, fd, task);
  const facts = await collectVerifyFacts(fd, { prStage, probes: pl.probes, evidence, taskBranch: task.branch });
  const v = asInvalid(() => checklistVerdict(pl, pl.probes.map((id) => judgeProbe(id, facts)), waivers));
  const summary = blockingSummary(v, pl);
  const out = { result: v.result, checks: v.checks, checklistSource: pl.source, ...(note ? { note } : {}), ...(summary ? { blocking: summary } : {}) };
  if (dryRun) return { ok: true, dryRun: true, task: task.id, ...out };

  const data = { checks: v.checks, checklistSource: pl.source, incomplete: pl.incomplete, evidence, ...(note ? { note } : {}) };
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
