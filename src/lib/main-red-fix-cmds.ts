/**
 * `ledger scheduler-main-red-fix <project> --op observe|rerun-claim|rerun-result|fix|bind --facts <JSON>`: main-red-fix's only write
 * door (manager/ledger.ts spreads MAIN_RED_FIX_CMDS and lets the scheduler identity run MAIN_RED_FIX_SERVICE, as PMAUTO1 does).
 * Scheduler identity with a live lease only, for a project under auto dispatch; every facts field is validated here and the writes
 * re-read the ledger in their own transaction (main-red-fix-write.ts). tests/main-red-fix-cmds.test.ts.
 */
import type { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import { realScrub } from "./dag-write-scrub.js";
import type { WriteCtx } from "./ledger-checks.js";
import { LedgerError } from "./ledger-store.js";
import { MAIN_RED_WORKFLOWS, type MainRedFacts } from "./main-red-fix.js";
import { bindMainRedRepair, claimMainRedRerun, recordMainRedObserve, recordMainRedRerunResult, writeMainRedFix } from "./main-red-fix-write.js";
import { statePath } from "./paths.js";
import { recoveryPolicy, type RecoveryPolicyPort } from "./recovery-policy.js";
import { readSchedulerConfig } from "./scheduler-config.js";
import { projectRepo } from "./scheduler-foreign-repo.js";
import type { SharedLedgerScrubContext } from "./shared-ledger-scrub.js";

const CMD = "scheduler-main-red-fix";
export const MAIN_RED_FIX_SERVICE: ReadonlySet<string> = new Set([CMD]);
const USAGE = `${CMD} <project> --op observe|rerun-claim|rerun-result|fix|bind --facts <JSON>（调度身份 + 租约）`;

interface Cli {
  db: Database;
  p: { pos: string[]; flags: Record<string, string> };
  ctx(): WriteCtx;
  deps: { actor: string; projectIds: readonly string[]; assertLease?(): void; autoDispatch?(): boolean; autoProjects?(): string[] };
}
/** Tests only: the docs root, the repo, the scrub context and the policy without scheduler.json / the install repo. */
interface CliPorts { ledgerDir?: string; repo?: (project: string) => string | null; scrub?: (heads: string[]) => Promise<SharedLedgerScrubContext>; policy?: RecoveryPolicyPort }
let ports: CliPorts = {};
export function setMainRedFixCliForTest(p: CliPorts | null): void { ports = p ?? {}; }

type Obj = Record<string, unknown>;
const bad = (what: string): never => { throw new LedgerError("invalid", `--facts ${what}`); };
const SHA = /^[0-9a-f]{40}$/;
const str = (o: Obj, k: string, re: RegExp, max = 300): string => typeof o[k] === "string" && (o[k] as string).length <= max && re.test(o[k] as string) ? o[k] as string : bad(`${k} 不合法`);
const int = (o: Obj, k: string): number => Number.isSafeInteger(o[k]) && (o[k] as number) >= 1 ? o[k] as number : bad(`${k} 要是正整数`);
const LINE = /^[^\p{Cc}\p{Cf}\u2028\u2029]*$/u;
const list = (o: Obj, k: string, max: number, re: RegExp = LINE): string[] => {
  const v = o[k];
  if (!Array.isArray(v) || v.length > max || v.some((x) => typeof x !== "string" || x.length > 400 || !re.test(x))) bad(`${k} 要是不超过 ${max} 项的单行文字列表`);
  return v as string[];
};
const workflow = (o: Obj) => MAIN_RED_WORKFLOWS.some((w) => w.id === o.workflow) ? o.workflow as MainRedFacts["workflow"] : bad("workflow 只能是 push / nightly");
const URL_RE = /^https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/actions\/runs\/\d+(?:\/attempts\/\d+)?$/;

function parseFacts(raw: string | undefined): Obj {
  if (!raw) return bad("缺");
  let v: unknown;
  try { v = JSON.parse(raw); } catch { return bad("不是 JSON"); }
  return v && typeof v === "object" && !Array.isArray(v) ? v as Obj : bad("要是 JSON 对象");
}

function fixFacts(o: Obj): MainRedFacts {
  const responsible = o.responsibleTask === null ? null : str(o, "responsibleTask", /^[A-Za-z0-9][A-Za-z0-9_.-]{0,59}$/);
  const faultKey = o.faultKey === null ? null : str(o, "faultKey", LINE, 4000);
  if (typeof o.rerun !== "boolean") bad("rerun 要是布尔");
  if (!Number.isSafeInteger(o.greenBefore) || (o.greenBefore as number) < 0) bad("greenBefore 要是非负整数");
  return { workflow: workflow(o), runId: int(o, "runId"), attempt: int(o, "attempt"), mainSha: str(o, "mainSha", SHA), url: str(o, "url", URL_RE),
    checks: list(o, "checks", 50), cases: list(o, "cases", 50), files: list(o, "files", 50, /^[\w./-]{1,200}$/), snippet: list(o, "snippet", 40),
    responsibleTask: responsible, faultKey, rerun: o.rerun as boolean, greenBefore: o.greenBefore as number };
}

function gate(c: Cli): string {
  if (c.deps.actor !== "scheduler" || !c.deps.assertLease) throw new LedgerError("forbidden", `${CMD} 只给有租约的调度身份`);
  c.deps.assertLease();
  const [, project, ...extra] = c.p.pos;
  if (!project || extra.length) throw new LedgerError("invalid", USAGE);
  if (!c.deps.projectIds.includes(project)) throw new LedgerError("not_found", `projects.json 里没有项目 ${project}`);
  if (c.deps.autoDispatch?.() !== true || !c.deps.autoProjects?.().includes(project)) throw new LedgerError("forbidden", "本项目未启用自动调度");
  return project;
}

function repoOf(project: string): string {
  const repo = ports.repo ? ports.repo(project) : (() => { const p = readSchedulerConfig().projects[project]; return p ? projectRepo(p) : null; })();
  if (!repo) throw new LedgerError("not_found", `scheduler.json 里没有项目 ${project} 的仓库`);
  return repo;
}

async function run(c: Cli): Promise<Record<string, unknown>> {
  const project = gate(c), o = parseFacts(c.p.flags.facts), ctx = c.ctx(), now = ctx.now ?? Date.now(), policy = ports.policy ?? recoveryPolicy;
  switch (c.p.flags.op) {
    case "observe": {
      const action = o.action === "rerun" || o.action === "node" ? o.action : bad("action 只能是 rerun / node");
      if (policy(project, "mainRedFix").mode !== "observe") throw new LedgerError("forbidden", "mainRedFix 不是 observe");
      const r = recordMainRedObserve(c.db, project, { workflow: workflow(o), mainSha: str(o, "mainSha", SHA), action, text: str(o, "text", LINE, 400) }, now);
      return { ok: true, recorded: r.recorded };
    }
    case "rerun-claim": {
      const f = fixFacts(o);
      return { ok: true, claimed: claimMainRedRerun(c.db, ctx, project, f, policy) };
    }
    case "rerun-result": {
      if (typeof o.green !== "boolean") bad("green 要是布尔");
      const r = recordMainRedRerunResult(c.db, ctx, project, { workflow: workflow(o), runId: int(o, "runId"), url: str(o, "url", URL_RE) }, o.green as boolean);
      return { ok: true, duplicate: r.duplicate };
    }
    case "fix": {
      // the SHA was read from this project's repo on GitHub: a commit there, whatever the install repo has fetched
      const f = fixFacts(o), base = await (ports.scrub ?? realScrub)([f.mainSha]), scrub = { ...base, commits: new Set([...base.commits ?? [], f.mainSha]) };
      c.deps.assertLease?.();
      return { ok: true, ...writeMainRedFix(c.db, ctx, project, f, { ledgerDir: ports.ledgerDir ?? statePath("ledger"), scrub, exists: existsSync, repo: repoOf(project), policy, now }) };
    }
    case "bind": {
      const r = bindMainRedRepair(c.db, ctx, { project, taskId: str(o, "taskId", /^[A-Za-z0-9][A-Za-z0-9_.-]{0,59}$/), head: str(o, "head", SHA),
        mainSha: str(o, "mainSha", SHA), faultKey: str(o, "faultKey", LINE, 4000) }, policy);
      return { ok: true, result: r };
    }
    default: throw new LedgerError("invalid", USAGE);
  }
}

export const MAIN_RED_FIX_CMDS = { [CMD]: { valued: ["op", "facts"], bools: [] as string[], usage: USAGE, run } };
