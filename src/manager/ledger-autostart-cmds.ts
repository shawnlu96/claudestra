import { requireLocalSharedLedgerPlanning } from "../lib/shared-ledger-gate.js";
import { liveClaim } from "../lib/ledger-autostart.js";
/**
 * 自动开卡 / 自动交回（i28-A1，docs/architecture/scheduler-autostart.md）的 ledger 子命令：这里只解析参数，事务与权限在 lib。
 * - `scheduler-autostart claim|step|settle`、`scheduler-auto-resume`：只给调度身份（manager/ledger.ts SCHEDULER_SERVICE_COMMANDS）。
 * - `autostart-set`：项目 PM / master / owner 改开关（owner 点 PM 发的按钮，PM 代为执行）。
 * - feature-show 的 `autostart` 字段（autostartShow）：开关状态，以及每个计划节点此刻卡在哪道门（额度门只在调度服务里看）。
 */
import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { claimNode, setAutostartSwitch, settleClaim, SETTLE_OUTCOMES, type SettleOutcome } from "../lib/ledger-autostart.js";
import { autoResume } from "../lib/ledger-autostart-resume.js";
import { autostartStep } from "../lib/ledger-autostart-step.js";
import { resolveFeature, type Feature } from "../lib/ledger-feature.js";
import { storedOrigin } from "../lib/ledger-origin.js";
import { LedgerError } from "../lib/ledger-store.js";
import { statePath } from "../lib/paths.js";
import { featureLanes } from "../lib/dag-tools-lanes.js";
import { readSchedulerConfig } from "../lib/scheduler-config.js";
import { specWaitCli } from "../lib/scheduler-spec-wait-ledger.js";
import { postVerifyCli } from "../lib/scheduler-post-verify-ledger.js";
import {
  currentViews, featureGate, isStop, nodeCandidate, readSwitch, TEMPLATE_VERSION, weeklyLine, type AutostartTemplate, type ServiceFacts, type SpecFile,
} from "../lib/scheduler-autostart.js";
import type { LedgerCli, Result } from "./ledger-context.js";
import { intFlag } from "./ledger-identity.js";
import type { CommandSpec } from "./ledger-write-cmds.js";

/** step 透传 runStart 发出的各条台账写的旗标（task-new / task-set / stage / workflow-set / dag-bind） */
const STEP_FLAGS = ["title", "kind", "item", "branch", "spec", "pm", "project", "extra", "rev", "agent", "from", "to", "text", "workflow-rev", "template",
  "version", "mode", "author-family", "fallback", "reason", "dedup", "replaces"];

function int(c: LedgerCli, name: string): number {
  const v = intFlag(c.p, name);
  if (v === undefined) throw new LedgerError("invalid", `缺 --${name}`);
  return v;
}

const svcOf = (c: LedgerCli, maxWorkers: (p: string) => number): ServiceFacts => ({
  autoDispatch: c.deps.autoDispatch?.() === true, projects: c.deps.autoProjects?.() ?? [], maxWorkers,
});

function claim(c: LedgerCli): Result {
  const [featureId, key] = c.p.pos.slice(2);
  if (!featureId || !key) throw new LedgerError("invalid", "claim <feature> <节点> --arm <hash> --template code|ui|security|invalid --max-workers N");
  const t = c.need("template");
  if (t !== "invalid" && !Object.hasOwn(TEMPLATE_VERSION, t)) throw new LedgerError("invalid", "--template 只能是 code / ui / security / invalid");
  const max = int(c, "max-workers");
  const r = claimNode(c.db, c.ctx(), { featureId, key, arm: c.need("arm"), template: t === "invalid" ? null : (t as AutostartTemplate), svc: svcOf(c, () => max),
    expectedPm: c.p.flags.pm, peer: c.p.flags.peer ? JSON.parse(c.p.flags.peer) : null, ownerVisual: c.p.bools.has("owner-visual") });
  return { ok: true, ...r };
}

function step(c: LedgerCli): Result {
  const seq = Number(c.p.pos[2]);
  if (!Number.isInteger(seq) || seq <= 0) throw new LedgerError("invalid", "step <claim> <子命令> <目标> …");
  if (c.p.pos[3] === "task-new") requireLocalSharedLedgerPlanning(liveClaim(c.db, seq).featureId);
  const flags: Record<string, string | undefined> = { ...c.p.flags };
  return autostartStep(c.db, c.ctx(), { claim: seq, sub: c.p.pos[3] ?? "", pos: c.p.pos.slice(4), flags });
}

function settle(c: LedgerCli): Result {
  const seq = Number(c.p.pos[2]);
  if (!Number.isInteger(seq) || seq <= 0) throw new LedgerError("invalid", "settle <claim> --outcome done|failed|unknown");
  const outcome = c.need("outcome") as SettleOutcome;
  if (!SETTLE_OUTCOMES.includes(outcome)) throw new LedgerError("invalid", "--outcome 只能是 done / failed / unknown");
  const list = (name: string): string[] | undefined => {
    const v = c.p.flags[name];
    if (v === undefined) return undefined;
    const parsed = JSON.parse(v) as unknown;
    if (!Array.isArray(parsed) || !parsed.every((x) => typeof x === "string")) throw new LedgerError("invalid", `--${name} 要是字符串数组的 JSON`);
    return parsed;
  };
  const r = settleClaim(c.db, { ...c.ctx(), dedupKey: undefined }, {
    claim: seq, outcome, code: c.p.flags.code, failedStep: c.p.flags["failed-step"], rolledBack: list("rolled-back"), leftovers: list("leftovers"), text: c.p.flags.text,
  });
  return { ok: true, ...r };
}

const AUTOSTART_SUBS: Record<string, (c: LedgerCli) => Result> = {
  claim, step, settle, "spec-wait": (c) => specWaitCli(c.db, { ...c.ctx(), dedupKey: undefined }, c.p.pos.slice(2), c.p.flags, svcOf(c, () => 0)) };
AUTOSTART_SUBS["post-verify"] = (c) => postVerifyCli(c.db, c.ctx(), c.p.pos.slice(2), c.p.flags, svcOf(c, () => 0));

function autoResumeCmd(c: LedgerCli): Result {
  const task = c.task(c.p.pos[1]);
  const max = int(c, "max-workers");
  return autoResume(c.db, c.ctx(), { taskId: task.id, taskRev: int(c, "rev"), workflowRev: int(c, "workflow-rev"), maxWorkers: max, svc: svcOf(c, () => max) });
}

function autostartSet(c: LedgerCli): Result {
  const v = c.p.pos[1];
  if (v !== "on" && v !== "off") throw new LedgerError("invalid", "autostart-set on|off [--feature <id>] [--line <50–100>] [--codex-line <50–100>] --reason <为什么>");
  const project = c.project();
  const featureId = c.p.flags.feature === undefined ? undefined : resolveFeature(c.db, c.p.flags.feature, storedOrigin(c.db)).id;
  const value = setAutostartSwitch(c.db, c.ctx(), { project, on: v === "on", featureId, line: intFlag(c.p, "line"),
    codexLine: intFlag(c.p, "codex-line"), reason: c.need("reason"), pm: c.p.flags.pm, specWait: c.p.flags["spec-wait"] });
  return { ok: true, project, autostart: value };
}

function readSpec(path: string): SpecFile | null {
  if (!existsSync(path)) return null;
  return { mtimeMs: statSync(path).mtimeMs, text: readFileSync(path, "utf8") };
}

/** feature-show 的 autostart 字段：开关，以及每个还没绑卡的计划节点此刻卡在哪道门（gate 为 null = 下一轮就会开） */
export function autostartShow(c: LedgerCli, f: Feature): Record<string, unknown> {
  let max = 0;
  try { max = readSchedulerConfig().projects[f.project]?.maxActiveWorkers ?? 0; } catch (e) { return { error: `读 scheduler.json 失败：${(e as Error).message}` }; }
  const sw = readSwitch(c.db, f.project);
  const svc = svcOf(c, () => max);
  const shared = featureGate(c.db, f, svc);
  const views = currentViews(c.db, f);
  const lanes = featureLanes(c.db, f);
  const ledgerDir = statePath("ledger");
  const nodes = views.filter((n) => !n.taskId).map((n) => {
    const r = shared ?? nodeCandidate(c.db, f, n.key, lanes, views, (id) => readSpec(join(ledgerDir, "docs", "tasks", `${id}.md`)), c.deps.now());
    return isStop(r) ? { key: n.key, gate: r.gate, why: r.why } : { key: n.key, gate: null, template: r.head.template };
  });
  return { switch: { project: sw.off ?? "on", feature: sw.features?.[f.id] ?? "on", weeklyLinePct: weeklyLine(sw) }, nodes };
}

export const AUTOSTART_CMDS: Record<string, CommandSpec> = {
  "scheduler-autostart": {
    valued: [...STEP_FLAGS, "peer", "arm", "max-workers", "outcome", "code", "failed-step", "rolled-back", "leftovers"], bools: ["owner-visual"],
    usage: "scheduler-autostart claim <feature> <节点> --arm --template --max-workers [--owner-visual] | step <claim> <子命令> … | settle <claim> --outcome done|failed|unknown（调度服务专用）",
    run(c) {
      const sub = AUTOSTART_SUBS[c.p.pos[1] ?? ""];
      if (!sub) throw new LedgerError("invalid", "scheduler-autostart claim|step|settle");
      return sub(c);
    },
  },
  "scheduler-auto-resume": {
    valued: ["rev", "workflow-rev", "max-workers"],
    usage: "scheduler-auto-resume <task> --rev N --workflow-rev N --max-workers N（调度服务专用：合并撤销后执行者交了新 head，自动交回）",
    run: autoResumeCmd,
  },
  "autostart-set": {
    valued: ["feature", "line", "codex-line", "reason", "project", "dedup", "pm", "spec-wait"],
    usage: "autostart-set on|off [--feature <id> [--pm <agent>|-]] [--line <50–100>] [--codex-line <50–100>] [--spec-wait on|observe|off] --reason <为什么> [--project <id>]" +
      "（自动开卡 / 自动交回开关，PM / master / owner；项目关着时，之后单独打开的 feature 仍自动开卡；--pm 定 feature PM，--spec-wait 缺规格提醒，缺省 observe）",
    run: autostartSet,
  },
};
