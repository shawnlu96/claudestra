/**
 * 完成检查单（docs/architecture/ledger-verify.md）：任务进 verified 之前由系统核对的探针。这里只有纯函数——
 * 按改动的文件推断要跑哪些探针、按采集好的事实（ledger-verify-facts.ts）逐项判 pass / fail / unknown、再算总结论。
 * 不信 agent 自报：事实全部现采（gh / git / 本机与中继的 build-info / 进程与其代码目录），判定规则只此一份（tests/ledger-probes.test.ts）。
 * detail 由模板 + 参数拼成，网页按模板查英文词条（web/lib/i18n-dict-collab.ts），改模板要同步那边。
 */
import { conservativeDaemonsOf, type DaemonsOf } from "./ledger-daemon-map.js";

export const PROBE_IDS = ["pr-merged", "web-local", "web-relay", "daemon-bridge", "daemon-cron", "daemon-launcher", "manual-evidence"] as const;
export type ProbeId = (typeof PROBE_IDS)[number];
type ProbeStatus = "pass" | "fail" | "unknown";
type Params = Record<string, string | number>;

export interface ProbeResult {
  id: ProbeId;
  status: ProbeStatus;
  /** 中文全文（CLI 与老网页用）= tpl 填上 params */
  detail: string;
  tpl: string;
  params: Params;
  evidence: Record<string, unknown>;
  /** PM / owner 豁免了这一项（status 保持原样，只是不再挡 verified）：理由原文 */
  waived?: string;
}

/** task extra.checks 可写的组名：只能在按文件推断的基础上加项；要去掉推断出的项只能 --waive 带理由 */
const CHECK_GROUPS: Record<string, readonly ProbeId[]> = {
  web: ["web-local", "web-relay"],
  bridge: ["daemon-bridge"],
  cron: ["daemon-cron"],
  launcher: ["daemon-launcher"],
};

export const DAEMONS = ["bridge", "cron", "launcher"] as const;
export type Daemon = (typeof DAEMONS)[number];

/** 不能豁免的项：PR 没合并 / 不是这个任务的 PR，就没有「上线」可言 */
const UNWAIVABLE: readonly ProbeId[] = ["pr-merged"];

/** 与 WEB_PATHSPEC（lib/web-build.ts）同一口径：web/ 下除了 .md 都进 bundle */
const isWebFile = (f: string): boolean => f.startsWith("web/") && !f.endsWith(".md");

export function inferGroups(files: readonly string[], daemonsOf: DaemonsOf = conservativeDaemonsOf): string[] {
  const groups = new Set<string>();
  for (const f of files) {
    if (isWebFile(f)) groups.add("web");
    for (const d of daemonsOf(f)) groups.add(d);
  }
  return Object.keys(CHECK_GROUPS).filter((g) => groups.has(g));
}

/** files = 按 PR 文件推断；files+extra = 推断再加手工项；extra = 文件列表拿不到时手工指定；evidence = 没挂 PR / 非本仓库项目，只核证据 */
type ChecklistSource = "files" | "files+extra" | "extra" | "evidence";

export interface ChecklistPlan {
  probes: ProbeId[];
  source: ChecklistSource;
  /** 推断不出该跑什么，结论只能是 unknown，豁免也救不了 */
  incomplete: boolean;
  /** files = 有 PR 但拿不到文件列表（或为空）又没手工指定；ownership = 判断不了任务所属项目是不是本仓库 */
  incompleteReason?: IncompleteReason;
}

export type IncompleteReason = "files" | "ownership";

/** 推断不全的原因（CLI 报错与网页共用字面量，网页按它查英文词条） */
export const INCOMPLETE_TEXT: Record<IncompleteReason, string> = {
  files: "拿不到 PR 的文件列表，推断不出检查单——gh 恢复后重跑，或在 task extra.checks 里手工指定",
  ownership: "判断不了任务所属项目是不是本仓库（git 读不到本仓库、项目没登记目录，或 PR 链接和项目对不上），不知道该核什么",
};

/** extra.checks：不写 → null；写了必须是已知组名的非空数组，否则抛错（打错一个字就少核一项；空数组没有意义） */
export function parseExtraChecks(raw: unknown): string[] | null {
  if (raw === undefined || raw === null) return null;
  const known = Object.keys(CHECK_GROUPS);
  if (!Array.isArray(raw) || !raw.length || raw.some((g) => typeof g !== "string" || !known.includes(g))) {
    throw new Error(`task extra.checks 要是 ${known.join(" / ")} 组成的非空数组（只能加项；去掉推断出的项请用 --waive 带理由），收到 ${JSON.stringify(raw)}`);
  }
  return [...new Set(raw as string[])];
}

const probesOf = (groups: readonly string[]) => Object.keys(CHECK_GROUPS).filter((g) => groups.includes(g)).flatMap((g) => CHECK_GROUPS[g]);

export function planChecklist(input: { hasPr: boolean; files: readonly string[] | null; extraChecks: string[] | null; daemonsOf?: DaemonsOf }): ChecklistPlan {
  const extra = input.extraChecks ?? [];
  if (!input.hasPr) return { probes: ["manual-evidence", ...probesOf(extra)], source: "evidence", incomplete: false };
  if (input.files?.length) {
    const groups = [...new Set([...inferGroups(input.files, input.daemonsOf), ...extra])];
    return { probes: ["pr-merged", ...probesOf(groups)], source: extra.length ? "files+extra" : "files", incomplete: false };
  }
  if (extra.length) return { probes: ["pr-merged", ...probesOf(extra)], source: "extra", incomplete: false };
  return { probes: ["pr-merged"], source: "files", incomplete: true, incompleteReason: "files" };
}

/** 已部署的网页版本：commit 是 build-info 的 webCommit；contains = 期望的提交是它自己或它的祖先（本机 git 认不出为 null） */
export interface DeployedWeb {
  commit: string | null;
  contains: boolean | null;
  error?: string;
}

export interface DaemonFacts {
  pid: string | null;
  /** launchd 里有没有这个服务（bridge 按端口找到时视为有）；false = 这台机器没装 */
  installed?: boolean;
  startedAt: number | null;
  /** 进程的工作目录（它加载代码的仓库） */
  cwd?: string | null;
  /** cwd 的 HEAD 包含合并提交；认不出为 null */
  codeHasMerge?: boolean | null;
  /** cwd 的 HEAD 从什么时候起一直包含合并提交（reflog）；查不到为 null */
  headSince?: number | null;
  /** cwd 的工作区里 PR 改到的源码与 HEAD 一致（没有 reset --soft / 手改留下的旧文件）；没核为 null */
  worktreeClean?: boolean | null;
  /** cwd 不是 git 仓库等：核对不了代码的原因 */
  codeError?: string;
  error?: string;
}

export interface VerifyFacts {
  /** null = 任务没挂 PR（走 manual-evidence） */
  pr: {
    ref: string;
    state: string | null;
    head: string | null;
    /** PR 的源分支 */
    branch: string | null;
    /** PR 的目标分支提交（本地推文件列表用） */
    base?: string | null;
    mergeCommit: string | null;
    mergedAt: number | null;
    files: string[] | null;
    error?: string;
  } | null;
  /** 台账里记的任务分支：PR 必须是这个分支发的 */
  taskBranch: string | null;
  /** 合并提交在 origin/main 里（fetch 之后判；squash / rebase 合并时 head 不在 main，只能看合并提交）；判不了为 null */
  mergeInMain: boolean | null;
  fetchError?: string;
  /** 合并提交里最后一次动 web/ 的提交（git log -1 <merge> -- web 排除 md） */
  expectedWeb: string | null;
  webLocal: DeployedWeb;
  /** applicable = 本机配了中继（没配就不适用） */
  webRelay: DeployedWeb & { applicable: boolean };
  daemons: Partial<Record<Daemon, DaemonFacts>>;
  evidence: { path: string | null; bytes: number | null };
}

const short = (s: string | null | undefined) => (s ? s.slice(0, 9) : "?");
/** 跑 verify 那台机器的本地时间（台账是单机的，看的人和跑的人在同一时区）；两个时刻落在同一分钟就显示到秒，免得「00:19 早于 00:19」 */
function whenPair(a: number, b: number): [string, string] {
  const fmt = (ms: number, sec: boolean) => new Date(ms).toLocaleString("sv-SE").slice(0, sec ? 19 : 16);
  const sec = Math.floor(a / 60_000) === Math.floor(b / 60_000);
  return [fmt(a, sec), fmt(b, sec)];
}

/** PR 链接显示成 #141；不是 GitHub 链接就原样 */
function prName(ref: string): string {
  const n = ref.match(/\/pull\/(\d+)\/?$/)?.[1];
  return n ? `#${n}` : ref;
}

const fill = (tpl: string, p: Params) => tpl.replace(/\{(\w+)\}/g, (m, k: string) => (k in p ? String(p[k]) : m));

function result(id: ProbeId, status: ProbeStatus, tpl: string, params: Params = {}, evidence: Record<string, unknown> = {}): ProbeResult {
  return { id, status, detail: fill(tpl, params), tpl, params, evidence };
}

function judgePr(f: VerifyFacts): ProbeResult {
  const pr = f.pr;
  if (!pr) return result("pr-merged", "unknown", "任务没挂 PR");
  const ev = { pr: pr.ref, state: pr.state, head: pr.head, branch: pr.branch, taskBranch: f.taskBranch, mergeCommit: pr.mergeCommit, mergedAt: pr.mergedAt,
    ...(f.fetchError ? { fetchError: f.fetchError } : {}) };
  const p = { pr: prName(pr.ref) };
  if (pr.error) return result("pr-merged", "unknown", "查不到 PR {pr}：{error}", { ...p, error: pr.error }, ev);
  if (pr.state !== "MERGED") return result("pr-merged", "fail", "PR {pr} 状态是 {state}，还没合并", { ...p, state: pr.state ?? "?" }, ev);
  if (!f.taskBranch) return result("pr-merged", "fail", "任务没记分支（ledger task-set --branch），核对不了 PR {pr} 是不是它的", p, ev);
  if (pr.branch !== f.taskBranch) {
    return result("pr-merged", "fail", "PR {pr} 来自分支 {branch}，不是任务的分支 {taskBranch}", { ...p, branch: pr.branch ?? "?", taskBranch: f.taskBranch }, ev);
  }
  const m = { ...p, merge: short(pr.mergeCommit) };
  if (f.mergeInMain === true) return result("pr-merged", "pass", "PR {pr} 已合并，合并提交 {merge} 在 origin/main 里", m, ev);
  if (f.mergeInMain === false && !f.fetchError) return result("pr-merged", "fail", "PR 显示已合并，但合并提交 {merge} 不在 origin/main 里", m, ev);
  if (f.fetchError) return result("pr-merged", "unknown", "判断不了合并提交 {merge} 在不在 origin/main 里（git fetch 失败：{error}）", { ...m, error: f.fetchError }, ev);
  return result("pr-merged", "unknown", "判断不了合并提交 {merge} 在不在 origin/main 里", m, ev);
}

function judgeWeb(id: "web-local" | "web-relay", d: DeployedWeb, expected: string | null): ProbeResult {
  const ev = { expected, deployed: d.commit, ...(d.error ? { error: d.error } : {}) };
  const local = id === "web-local";
  const p = { expected: short(expected), deployed: short(d.commit) };
  if (!expected) return result(id, "unknown", "找不到合并提交里动 web/ 的提交", {}, ev);
  if (d.error) return result(id, "unknown", local ? "读不到本机的网页版本：{error}" : "读不到中继的网页版本：{error}", { error: d.error }, ev);
  if (!d.commit) {
    const tpl = local ? "本机没有托管的网页版本（build-info.json 里没有 webCommit）" : "中继没有托管的网页版本（build-info.json 里没有 webCommit）";
    return result(id, "fail", tpl, {}, ev);
  }
  if (d.contains === true) return result(id, "pass", local ? "本机网页 {deployed} 已包含 {expected}" : "中继网页 {deployed} 已包含 {expected}", p, ev);
  if (d.contains === false) {
    return result(id, "fail", local ? "本机网页是 {deployed}，不包含 {expected}——还没部署" : "中继网页是 {deployed}，不包含 {expected}——还没部署", p, ev);
  }
  const tpl = local
    ? "本机 git 认不出本机的网页版本 {deployed}，判断不了是否包含 {expected}"
    : "本机 git 认不出中继的网页版本 {deployed}，判断不了是否包含 {expected}";
  return result(id, "unknown", tpl, p, ev);
}

function judgeRelay(f: VerifyFacts): ProbeResult {
  if (!f.webRelay.applicable) return result("web-relay", "pass", "本机没配中继，不适用", {}, { applicable: false });
  return judgeWeb("web-relay", f.webRelay, f.expectedWeb);
}

/** 进程要同时满足：代码目录的 HEAD 已包含合并提交，且进程启动晚于「HEAD 开始包含它」的时刻（也晚于合并） */
function judgeDaemon(id: ProbeId, daemon: Daemon, f: VerifyFacts): ProbeResult {
  const d = f.daemons[daemon];
  const mergedAt = f.pr?.mergedAt ?? null;
  const ev = { daemon, pid: d?.pid ?? null, startedAt: d?.startedAt ?? null, cwd: d?.cwd ?? null, codeHasMerge: d?.codeHasMerge ?? null,
    headSince: d?.headSince ?? null, mergedAt, ...(d?.error ? { error: d.error } : {}) };
  const p: Params = { daemon, pid: d?.pid ?? "?", cwd: d?.cwd ?? "?", merge: short(f.pr?.mergeCommit) };
  if (!d || d.error) return result(id, "unknown", "查不到 {daemon} 进程：{error}", { ...p, error: d?.error ?? "没采集" }, ev);
  if (d.installed === false) return result(id, "fail", "{daemon} 没装（launchd 里没有它）——这台机器不用它就 --waive 带理由", p, ev);
  if (!d.pid) return result(id, "fail", "{daemon} 装了但没在跑", p, ev);
  if (!d.startedAt) return result(id, "unknown", "读不到 {daemon}（pid {pid}）的启动时间", p, ev);
  if (!mergedAt) return result(id, "unknown", "不知道合并时间，比不了", p, ev);
  if (!d.cwd) return result(id, "unknown", "查不到 {daemon}（pid {pid}）的工作目录，核对不了它跑的代码", p, ev);
  if (d.codeError) return result(id, "unknown", "{daemon} 的工作目录 {cwd} 核对不了：{error}", { ...p, error: d.codeError }, ev);
  if (d.codeHasMerge === false) return result(id, "fail", "{daemon} 的代码目录 {cwd} 还不含合并提交 {merge}——先把那里更新到 main 再重启", p, ev);
  if (d.codeHasMerge !== true) return result(id, "unknown", "判断不了 {daemon} 的代码目录 {cwd} 是否包含合并提交 {merge}", p, ev);
  if (d.worktreeClean === false) {
    return result(id, "fail", "{daemon} 的代码目录 {cwd} 里 PR 改到的文件和 HEAD 不一致（工作区还是旧文件或有改动）——先让工作区回到 HEAD 再重启", p, ev);
  }
  if (!d.headSince) return result(id, "unknown", "reflog 里找不到 {cwd} 从何时起包含合并提交，比不了重启时间", p, ev);
  const since = Math.max(mergedAt, d.headSince);
  const [started, sinceText] = whenPair(d.startedAt, since);
  const t = { ...p, started, since: sinceText };
  if (d.startedAt > since) return result(id, "pass", "{daemon} 启动于 {started}，晚于代码更新到合并提交的 {since}", t, ev);
  return result(id, "fail", "{daemon} 启动于 {started}，早于代码更新到合并提交的 {since}——还没重启", t, ev);
}

function judgeEvidence(f: VerifyFacts): ProbeResult {
  const { path, bytes } = f.evidence;
  const ev = { path, bytes };
  if (!path) return result("manual-evidence", "fail", "要带 --evidence <证据文件>", {}, ev);
  if (bytes === null) return result("manual-evidence", "fail", "证据文件不存在：{path}", { path }, ev);
  if (bytes === 0) return result("manual-evidence", "fail", "证据文件是空的：{path}", { path }, ev);
  return result("manual-evidence", "pass", "证据 {path}（{bytes} 字节）", { path, bytes }, ev);
}

export function judgeProbe(id: ProbeId, f: VerifyFacts): ProbeResult {
  switch (id) {
    case "pr-merged": return judgePr(f);
    case "web-local": return judgeWeb("web-local", f.webLocal, f.expectedWeb);
    case "web-relay": return judgeRelay(f);
    case "daemon-bridge": return judgeDaemon(id, "bridge", f);
    case "daemon-cron": return judgeDaemon(id, "cron", f);
    case "daemon-launcher": return judgeDaemon(id, "launcher", f);
    case "manual-evidence": return judgeEvidence(f);
  }
}

export interface ChecklistVerdict {
  result: ProbeStatus;
  checks: ProbeResult[];
  /** 挡住 verified 的项（没过也没豁免） */
  blocking: ProbeResult[];
}

/**
 * 豁免只能给这次检查单里、没通过、且允许豁免的项；给错一律报错（写错 id 就等于没豁免，静默吞掉会让人以为放行了）。
 * 检查单推断不全时总结论恒为 unknown，豁免也救不了——不知道该核什么，就不能说核过了。
 */
export function checklistVerdict(plan: ChecklistPlan, results: ProbeResult[], waivers: Partial<Record<ProbeId, string>> = {}): ChecklistVerdict {
  for (const id of Object.keys(waivers) as ProbeId[]) {
    const r = results.find((x) => x.id === id);
    if (!r) throw new Error(`豁免的 ${id} 不在这次的检查单里（${plan.probes.join(", ")}）`);
    if (UNWAIVABLE.includes(id)) throw new Error(`${id} 不能豁免：PR 没合并或不是这个任务的，就谈不上上线`);
    if (r.status === "pass") throw new Error(`${id} 已经通过，不需要豁免`);
  }
  const checks = results.map((r) => (waivers[r.id] ? { ...r, waived: waivers[r.id] } : r));
  const blocking = checks.filter((r) => r.status !== "pass" && !r.waived);
  // fail 比 unknown 更确定：有一项明确没过就报 fail，免得人去等一个「查不到」的项
  const result: ProbeStatus = blocking.some((r) => r.status === "fail") ? "fail" : plan.incomplete || blocking.length ? "unknown" : "pass";
  return { result, checks, blocking };
}

/** recordVerify 在事务里再核一遍：检查单完整、非空，且每项都通过或带了豁免理由（调用方传错 result 也推不进 verified） */
export function checksAllClear(checks: unknown, incomplete?: unknown): boolean {
  if (incomplete === true || !Array.isArray(checks) || !checks.length) return false;
  return checks.every((c) => {
    const r = c as Partial<ProbeResult>;
    if (!PROBE_IDS.includes(r.id as ProbeId)) return false;
    return r.status === "pass" || (typeof r.waived === "string" && r.waived.trim() !== "" && !UNWAIVABLE.includes(r.id as ProbeId));
  });
}

/** CLI / 报错里的一句话：哪些项没过 */
export function blockingSummary(v: ChecklistVerdict, plan: ChecklistPlan): string {
  const parts = v.blocking.map((r) => `${r.id}（${r.status}）：${r.detail}`);
  if (plan.incomplete) parts.unshift(INCOMPLETE_TEXT[plan.incompleteReason ?? "files"]);
  return parts.join("；");
}
