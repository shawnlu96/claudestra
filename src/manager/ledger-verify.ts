/**
 * `ledger verify <task>`：系统核对完成检查单（lib/ledger-probes.ts 判定、lib/ledger-verify-facts.ts 采事实），
 * 全部通过（或没过的项被 PM / owner 带理由豁免）才在同一事务里推 live → verified；否则记一条 verify 事件、不推、退出码 1。
 * `stage --to verified` 已经堵死（lib/ledger-write.ts VERIFY_HINT），进 verified 只有这一条路。--dry-run 只看结果不写库，执行者也能跑。
 * 探针（PR / 网页 / daemon）只认得本仓库：明确判定任务不属于本仓库时只核证据文件；判断不了按推断不全处理（不放行）。
 */
import { daemonsOfFromRepo } from "../lib/ledger-daemon-map.js";
import {
  blockingSummary,
  checklistVerdict,
  judgeProbe,
  parseExtraChecks,
  parseExtraRepo,
  planChecklist,
  PROBE_IDS,
  type ChecklistPlan,
  type ProbeId,
} from "../lib/ledger-probes.js";
import { getEventByDedup, LedgerError } from "../lib/ledger-store.js";
import type { LedgerTask } from "../lib/ledger-stages.js";
import { collectPrStage, collectVerifyFacts, ghPrArg, mainRepoRoot, originRepo, prRepo, realFactsDeps, type FactsDeps } from "../lib/ledger-verify-facts.js";
import { recordVerify } from "../lib/ledger-write.js";
import { dirKey } from "../lib/project-dirs.js";
import { normalizeDir, resolveProjectForRealDir } from "../lib/projects.js";
import { REPO_ROOT } from "../lib/repo-root.js";
import { schedulerCanVerify } from "../lib/scheduler-verify-gate.js";
import { readSchedulerConfig } from "../lib/scheduler-config.js";
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

type Note = { tpl: string; params: Record<string, string> };
type Ownership = { owns: "yes" } | { owns: "no"; note: Note } | { owns: "unknown"; note?: Note };
type Owns = Ownership["owns"];

const projectDirs = (c: LedgerCli, task: LedgerTask) => (c.deps.projects?.().find((p) => p.id === task.project)?.dirs ?? []).map(normalizeDir);

/**
 * 按 projects.json 的目录：本仓库主树按最具体的目录命中的项目（伞形根只精确匹配，lib/projects.ts）就是任务所属项目 → yes；
 * 所属项目登记了目录却没命中 → no。以下判断不了（unknown）：没登记目录、git 读不到主树、登记的目录有不存在的或不是绝对路径
 * （配置漂移，不能据此说「不含本仓库」）、登记的目录就是本仓库却被别的项目占了（两个项目登记同一目录）。不给项目清单（测试）按拥有算。
 */
async function dirOwnership(c: LedgerCli, fd: FactsDeps, task: LedgerTask): Promise<Owns> {
  const projects = c.deps.projects?.();
  if (!projects) return "yes";
  const repo = await mainRepoRoot(fd);
  if (!repo) return "unknown";
  if (resolveProjectForRealDir(projects, repo)?.id === task.project) return "yes";
  const dirs = projectDirs(c, task);
  if (!dirs.length || dirs.some((d) => !d.startsWith("/") || !fd.isDir(d) || dirKey(d) === dirKey(repo))) return "unknown";
  return "no";
}

/** 一个项目登记了多个仓库：PR 的仓库是任务所属项目里哪个目录的 origin（本仓库探针核不了那边，只核证据） */
async function siblingRepoDir(c: LedgerCli, fd: FactsDeps, task: LedgerTask, pr: string): Promise<string | null> {
  for (const d of projectDirs(c, task)) {
    if (d.startsWith("/") && fd.isDir(d) && (await originRepo(fd, d)) === pr) return d;
  }
  return null;
}

/** 跑一条 gh --json：退出码非 0 或输出不是 JSON → 返回错误原文（调用方按判断不了处理） */
async function ghJson(fd: FactsDeps, args: string[]): Promise<{ ok: true; value: unknown } | { ok: false; error: string }> {
  const r = await fd.run(["gh", ...args]);
  try {
    if (r.code === 0) return { ok: true, value: JSON.parse(r.stdout) as unknown };
  } catch {
    // 输出不是 JSON：和失败一样按查不了处理，下面带上原文
  }
  return { ok: false, error: (r.stderr || r.stdout).trim().slice(0, 200) || `exit ${r.code}` };
}

/**
 * PR 指向项目里另一个仓库时的反证：那边 PR 的分支要等于 task.branch，本仓库 origin 上也查不到这个分支的 PR，
 * 否则是本仓库的活挂错了 PR。查不了（没记分支、gh 失败 / 超时 / 输出形状不对）一律按反证成立处理（fail-closed），返回原因；
 * 确认没问题 → null。分支执行者也能改，所以这只是 PM 声明之外的第二道：两处一起改错才会漏。
 */
async function siblingCounterEvidence(fd: FactsDeps, task: LedgerTask, origin: string): Promise<Note | null> {
  const branch = task.branch ?? "";
  const params = { branch, origin, task: task.id, link: task.pr ?? "", head: "", pr: "", error: "" };
  if (!branch) return { tpl: "任务没记分支，核对不了本仓库 {origin} 上有没有它的 PR：PM 先 ledger task-set {task} --branch <分支> 再重跑", params };
  const view = await ghJson(fd, ["pr", "view", ghPrArg(params.link) ?? "", "--json", "headRefName"]); // ownership 已确认认得出
  const head = view.ok ? (view.value as { headRefName?: unknown } | null)?.headRefName : undefined;
  if (typeof head !== "string") return { tpl: "查不了 PR {link} 的分支（{error}），按判断不了处理", params: { ...params, error: view.ok ? "no headRefName" : view.error } };
  if (head !== branch) return { tpl: "PR {link} 的分支是 {head}，任务记的分支是 {branch}：对不上就核不了是不是这个任务的，改对 PR 链接或分支后重跑", params: { ...params, head } };
  const list = await ghJson(fd, ["pr", "list", "--repo", origin, "--head", branch, "--state", "all", "--json", "number", "--limit", "5"]);
  const nums = list.ok && Array.isArray(list.value) ? list.value.map((p) => (p as { number?: unknown } | null)?.number) : null;
  if (!nums || !nums.every((n) => typeof n === "number")) {
    return { tpl: "查不了本仓库 {origin} 上有没有分支 {branch} 的 PR（{error}），按判断不了处理", params: { ...params, error: list.ok ? "unexpected output" : list.error } };
  }
  if (!nums.length) return null;
  const pr = nums.map((n) => `#${n}`).join(" ");
  return { tpl: "本仓库 {origin} 上有分支 {branch} 的 PR {pr}：这是本仓库的活，PR 链接应该指向它", params: { ...params, pr } };
}

/**
 * PR 指向项目里另一个仓库：PM 在 extra.repo 声明过同一个仓库 → no（只核证据，还要过 siblingCounterEvidence）；
 * 没声明 → unknown 并提示怎么声明（项目目录明确不含本仓库时 ownership 照旧按目录判，也要过反证）。声明了别的仓库在 ownership 先拦下。
 * 执行者能改 PR 链接、改不了 extra，本仓库的活挂错另一个仓库的 PR 就停在这里。
 */
function siblingOwnership(task: LedgerTask, pr: string, dir: string): Ownership {
  const declared = asInvalid(() => parseExtraRepo(task.extra.repo));
  const params = { project: task.project, prRepo: pr, dir, task: task.id, declared: declared ?? "" };
  if (declared === pr) return { owns: "no", note: { tpl: "PR 属于项目 {project} 的另一个仓库 {prRepo}（{dir}），本仓库的探针核不了，只核证据文件（--evidence）", params } };
  const cmd = `ledger task-set ${task.id} --rev <rev> --extra '${JSON.stringify({ ...task.extra, repo: pr })}'`;
  return {
    owns: "unknown",
    note: { tpl: "PR 指向项目 {project} 的另一个仓库 {prRepo}（{dir}），PM 还没声明这个任务属于它：确实是那边的活就由 PM 跑 {cmd}，否则把 PR 改回本仓库的", params: { ...params, cmd } },
  };
}

/**
 * 任务所属项目是不是本仓库：PR 链接的 owner/repo 等于本仓库 origin → 拥有；等于项目里另一个目录的 origin → 看 PM 的声明
 * （siblingOwnership）；没有可比的链接就按项目目录判。链接指向别处时，粘错、打错一个字也长这样，所以只有目录也明确不含本仓库才判不拥有，
 * 否则判断不了（不放行）。
 */
async function ownership(c: LedgerCli, fd: FactsDeps, task: LedgerTask): Promise<Ownership> {
  const pr = task.pr ? prRepo(task.pr) : null;
  const origin = pr ? await originRepo(fd) : null;
  if (pr && !origin) return { owns: "unknown" };
  // PM 写了声明就必须和 PR 对得上，哪条路都一样（包括 PR 在本仓库、目录明确不含本仓库），对不上不能静默忽略
  const declared = asInvalid(() => parseExtraRepo(task.extra.repo));
  if (pr && declared && declared !== pr) {
    return { owns: "unknown", note: { tpl: "PR 指向 {prRepo}，但 PM 声明的仓库是 {declared}：改对 PR 链接或 extra.repo 后重跑", params: { prRepo: pr, declared } } };
  }
  if (pr && origin === pr) return { owns: "yes" };
  const project = task.project;
  const sib = pr ? await siblingRepoDir(c, fd, task, pr) : null;
  const sibling = pr && sib ? siblingOwnership(task, pr, sib) : null;
  const dirs = await dirOwnership(c, fd, task);
  if (sibling && sibling.owns !== "no" && dirs !== "no") return sibling; // 目录没排除本仓库：可能是本仓库的活挂了那边的 PR，要 PM 声明
  // 声明过、或目录明确不含本仓库（不要求声明）：都要过反证，本仓库上有这个分支的 PR（或查不了）就不放行
  const own = sibling ? await siblingCounterEvidence(fd, task, origin as string) : null;
  if (own) return { owns: "unknown", note: own };
  if (sibling?.owns === "no") return sibling;
  if (!pr || !origin) {
    return dirs === "no" ? { owns: "no", note: { tpl: "项目 {project} 的目录里没有本仓库，只核证据文件（--evidence）", params: { project } } } : { owns: dirs };
  }
  if (dirs === "no") return { owns: "no", note: { tpl: "PR 属于 {prRepo}，不是本仓库 {origin}，只核证据文件（--evidence）", params: { prRepo: pr, origin } } };
  const params = { prRepo: pr, origin, project };
  return { owns: "unknown", note: { tpl: "PR 链接和项目对不上：链接指向 {prRepo}，本仓库是 {origin}，项目 {project} 的目录却没排除本仓库——改对链接或登记好项目目录后重跑", params } };
}

async function plan(c: LedgerCli, fd: FactsDeps, task: LedgerTask) {
  const extraChecks = asInvalid(() => parseExtraChecks(task.extra.checks));
  const own = await ownership(c, fd, task);
  // 按目录明确不属于本仓库的项目（可能根本不在 GitHub 上）不强制挂 PR；属于或判断不了的，代码改动要按 PR 核对上线
  if (task.kind === "code" && !task.pr && own.owns !== "no") {
    throw new LedgerError("invalid", `code 任务 ${task.id} 没挂 PR（ledger task-set --pr）：代码改动要按 PR 核对上线`);
  }
  const none = await collectPrStage(fd, null);
  if (own.owns === "unknown") {
    const p: ChecklistPlan = { probes: [], source: "files", incomplete: true, incompleteReason: "ownership" };
    return { plan: p, prStage: none, note: own.note ?? null };
  }
  if (own.owns === "no") {
    const p: ChecklistPlan = { probes: ["manual-evidence"], source: "evidence", incomplete: false };
    return { plan: p, prStage: none, note: own.note };
  }
  const prStage = await collectPrStage(fd, task.pr || null);
  const daemonsOf = daemonsOfFromRepo((rel) => fd.readRepoFile(rel));
  return { plan: planChecklist({ hasPr: !!task.pr, files: prStage.pr?.files ?? null, extraChecks, daemonsOf }), prStage, note: null };
}

const fillNote = (n: Note) => n.tpl.replace(/\{(\w+)\}/g, (m, k: string) => n.params[k] ?? m);

/** 带 --dedup 的正式核对先按幂等键重放：第一次已推进 verified 后，重试不能因为「不在 live」报错 */
function replayed(c: LedgerCli, task: LedgerTask): Result | null {
  const key = c.p.flags.dedup;
  const prev = key ? getEventByDedup(c.db, key) : null;
  if (!prev) return null;
  if (prev.kind !== "verify" || prev.target !== task.id) throw new LedgerError("dedup_mismatch", `dedupKey ${key} 已用于 ${prev.target || "(项目)"} 的 ${prev.kind} 事件`);
  return { ok: prev.data.result === "pass", task, event: prev, duplicate: true }; // 结论以当时记下的为准
}

async function verify(c: LedgerCli): Promise<Result> {
  const task = c.task(c.p.pos[1]);
  const dryRun = c.p.bools.has("dry-run");
  if (c.deps.actor === "scheduler") {
    if (dryRun || c.p.flags.waive || !schedulerCanVerify(c.db, task.id, c.p.flags.dedup)) {
      throw new LedgerError("forbidden", "调度服务只可核对已部署的本卡合并运行，不可豁免检查");
    }
  } else if (dryRun) c.requireOwnOrManager(task, "看完成检查单");
  else c.requireManager(task.project, "跑完成检查");
  const dup = dryRun ? null : replayed(c, task);
  if (dup) return dup;
  if (!dryRun && task.stage !== "live") {
    throw new LedgerError("invalid", `任务 ${task.id} 在 ${task.stage}，不在 live，不能进 verified；只看检查结果用 --dry-run`, { stage: task.stage });
  }
  const waivers = parseWaivers(c);
  const injected = c.deps.factsDeps?.();
  const repoRoot = injected ? null : c.deps.actor === "scheduler" ? readSchedulerConfig().projects[task.project]?.deploy.cwd : REPO_ROOT;
  if (!injected && !repoRoot) throw new LedgerError("conflict", `调度配置缺项目 ${task.project} 的部署仓库`);
  const fd: FactsDeps = injected ?? realFactsDeps(repoRoot as string);
  const evidence = c.p.flags.evidence ?? null;
  const { plan: pl, prStage, note } = await plan(c, fd, task);
  const facts = await collectVerifyFacts(fd, { prStage, probes: pl.probes, evidence, taskBranch: task.branch });
  const v = asInvalid(() => checklistVerdict(pl, pl.probes.map((id) => judgeProbe(id, facts)), waivers));
  const summary = blockingSummary(v, pl);
  const noteOut = note ? { note: fillNote(note), noteTpl: note.tpl, noteParams: note.params } : {};
  const out = { result: v.result, checks: v.checks, checklistSource: pl.source, ...noteOut, ...(summary ? { blocking: summary } : {}) };
  if (dryRun) return { ok: true, dryRun: true, task: task.id, ...out };

  const data = { checks: v.checks, checklistSource: pl.source, incomplete: pl.incomplete, ...(pl.incompleteReason ? { incompleteReason: pl.incompleteReason } : {}), evidence, ...noteOut };
  const r = recordVerify(c.db, c.ctx(), { taskId: task.id, result: v.result, data, text: c.p.flags.text });
  if (r.duplicate) return { ok: r.event.data.result === "pass", task: r.row, event: r.event, duplicate: true }; // 并发重放：结论以当时记下的为准
  if (v.result === "pass") return { ok: true, moved: true, task: r.row, event: r.event, ...out };
  return { ok: false, code: "unverified", error: `检查单没过，任务留在 live：${summary}${note ? `；${fillNote(note)}` : ""}`, moved: false, task: r.row, event: r.event, ...out };
}

export const VERIFY_CMD: CommandSpec = {
  valued: ["evidence", "waive", "text", "dedup"],
  bools: ["dry-run"],
  usage: "verify <task> [--evidence <path>] [--waive <probe,...> --text <理由>] [--dry-run]",
  run: verify,
};
