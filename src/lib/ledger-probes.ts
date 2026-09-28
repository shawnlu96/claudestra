/**
 * 完成检查单（docs/architecture/ledger-verify.md）：任务进 verified 之前由系统核对的探针。这里只有纯函数——
 * 按改动的文件推断要跑哪些探针、按采集好的事实（ledger-verify-facts.ts）逐项判 pass / fail / unknown、再算总结论。
 * 不信 agent 自报：事实全部现采（gh / git / 本机与中继的 build-info / 进程启动时间），判定规则只此一份（tests/ledger-probes.test.ts）。
 */

export const PROBE_IDS = ["pr-merged", "web-local", "web-relay", "daemon-bridge", "daemon-cron", "daemon-launcher", "manual-evidence"] as const;
export type ProbeId = (typeof PROBE_IDS)[number];
type ProbeStatus = "pass" | "fail" | "unknown";

export interface ProbeResult {
  id: ProbeId;
  status: ProbeStatus;
  detail: string;
  evidence: Record<string, unknown>;
  /** PM / owner 豁免了这一项（status 保持原样，只是不再挡 verified）：理由原文 */
  waived?: string;
}

/** task extra.checks 可写的组名；写了就替换按文件推断出的那部分（pr-merged / manual-evidence 由有没有 PR 决定，不受它影响） */
const CHECK_GROUPS: Record<string, readonly ProbeId[]> = {
  web: ["web-local", "web-relay"],
  bridge: ["daemon-bridge"],
  cron: ["daemon-cron"],
  launcher: ["daemon-launcher"],
};

export const DAEMONS = ["bridge", "cron", "launcher"] as const;
export type Daemon = (typeof DAEMONS)[number];

/** 与 WEB_PATHSPEC（lib/web-build.ts）同一口径：web/ 下除了 .md 都进 bundle */
const isWebFile = (f: string): boolean => f.startsWith("web/") && !f.endsWith(".md");

/** src/lib 也算 bridge：bridge 加载它，宁可多要求一次重启。channel-server 随会话重启，不归这里管 */
function daemonOf(f: string): Daemon | null {
  if (f === "src/bridge.ts" || f.startsWith("src/bridge/") || f.startsWith("src/lib/")) return "bridge";
  if (f === "src/cron.ts") return "cron";
  if (f === "src/launcher.ts") return "launcher";
  return null;
}

export function inferGroups(files: readonly string[]): string[] {
  const groups = new Set<string>();
  for (const f of files) {
    if (isWebFile(f)) groups.add("web");
    const d = daemonOf(f);
    if (d) groups.add(d);
  }
  return Object.keys(CHECK_GROUPS).filter((g) => groups.has(g));
}

export interface ChecklistPlan {
  probes: ProbeId[];
  source: "files" | "extra";
  /** 有 PR 但拿不到文件列表、也没手工指定：推断不出该跑什么，结论只能是 unknown，而且不能靠豁免放行 */
  incomplete: boolean;
}

/** extra.checks：不写 → null；写了必须是已知组名的数组，否则抛错（打错一个字就少核一项，不能静默忽略） */
export function parseExtraChecks(raw: unknown): string[] | null {
  if (raw === undefined || raw === null) return null;
  const known = Object.keys(CHECK_GROUPS);
  if (!Array.isArray(raw) || raw.some((g) => typeof g !== "string" || !known.includes(g))) {
    throw new Error(`task extra.checks 要是 ${known.join(" / ")} 组成的数组，收到 ${JSON.stringify(raw)}`);
  }
  return [...new Set(raw as string[])];
}

export function planChecklist(input: { hasPr: boolean; files: readonly string[] | null; extraChecks: string[] | null }): ChecklistPlan {
  const base: ProbeId[] = input.hasPr ? ["pr-merged"] : ["manual-evidence"];
  const inferred = input.hasPr && input.files ? inferGroups(input.files) : [];
  const groups = input.extraChecks ?? inferred;
  const probes = [...base, ...groups.flatMap((g) => CHECK_GROUPS[g] ?? [])];
  return { probes, source: input.extraChecks ? "extra" : "files", incomplete: input.hasPr && !input.files && !input.extraChecks };
}

/** 已部署的网页版本：commit 是 build-info 的 webCommit；contains = 期望的提交是它自己或它的祖先（本机 git 认不出为 null） */
export interface DeployedWeb {
  commit: string | null;
  contains: boolean | null;
  error?: string;
}

export interface VerifyFacts {
  /** null = 任务没挂 PR（走 manual-evidence） */
  pr: {
    ref: string;
    state: string | null;
    head: string | null;
    mergeCommit: string | null;
    mergedAt: number | null;
    files: string[] | null;
    error?: string;
  } | null;
  /** head 在 origin/main 里（fetch 之后判）；判不了为 null */
  headInMain: boolean | null;
  fetchError?: string;
  /** 合并提交里最后一次动 web/ 的提交（git log -1 <merge> -- web 排除 md） */
  expectedWeb: string | null;
  webLocal: DeployedWeb;
  /** applicable = 本机配了中继（没配就不适用） */
  webRelay: DeployedWeb & { applicable: boolean };
  daemons: Partial<Record<Daemon, { pid: string | null; startedAt: number | null; error?: string }>>;
  evidence: { path: string | null; bytes: number | null };
}

const short = (s: string | null | undefined) => (s ? s.slice(0, 9) : "?");
/** 跑 verify 那台机器的本地时间（台账是单机的，看的人和跑的人在同一时区）；精确值在 evidence 里 */
const when = (ms: number | null | undefined) => (ms ? new Date(ms).toLocaleString("sv-SE").slice(0, 16) : "?");
/** PR 链接显示成 #141；不是 GitHub 链接就原样 */
function prName(ref: string): string {
  const n = ref.match(/\/pull\/(\d+)\/?$/)?.[1];
  return n ? `#${n}` : ref;
}

function result(id: ProbeId, status: ProbeStatus, detail: string, evidence: Record<string, unknown> = {}): ProbeResult {
  return { id, status, detail, evidence };
}

function judgePr(f: VerifyFacts): ProbeResult {
  const pr = f.pr;
  if (!pr) return result("pr-merged", "unknown", "任务没挂 PR");
  const ev = { pr: pr.ref, state: pr.state, head: pr.head, mergeCommit: pr.mergeCommit, mergedAt: pr.mergedAt, ...(f.fetchError ? { fetchError: f.fetchError } : {}) };
  if (pr.error) return result("pr-merged", "unknown", `查不到 PR ${prName(pr.ref)}：${pr.error}`, ev);
  if (pr.state !== "MERGED") return result("pr-merged", "fail", `PR ${prName(pr.ref)} 状态是 ${pr.state ?? "?"}，还没合并`, ev);
  if (f.headInMain === true) return result("pr-merged", "pass", `PR ${prName(pr.ref)} 已合并，head ${short(pr.head)} 在 origin/main 里`, ev);
  if (f.headInMain === false && !f.fetchError) return result("pr-merged", "fail", `PR 显示已合并，但 head ${short(pr.head)} 不在 origin/main 里`, ev);
  return result("pr-merged", "unknown", `判断不了 head ${short(pr.head)} 在不在 origin/main 里${f.fetchError ? `（git fetch 失败：${f.fetchError}）` : ""}`, ev);
}

function judgeWeb(id: "web-local" | "web-relay", where: string, d: DeployedWeb, expected: string | null): ProbeResult {
  const ev = { expected, deployed: d.commit, ...(d.error ? { error: d.error } : {}) };
  if (!expected) return result(id, "unknown", "找不到合并提交里动 web/ 的提交", ev);
  if (d.error) return result(id, "unknown", `读不到${where}的网页版本：${d.error}`, ev);
  if (!d.commit) return result(id, "fail", `${where}没有托管的网页版本（build-info.json 里没有 webCommit）`, ev);
  if (d.contains === true) return result(id, "pass", `${where}网页 ${short(d.commit)} 已包含 ${short(expected)}`, ev);
  if (d.contains === false) return result(id, "fail", `${where}网页是 ${short(d.commit)}，不包含 ${short(expected)}——还没部署`, ev);
  return result(id, "unknown", `本机 git 认不出${where}的网页版本 ${short(d.commit)}，判断不了是否包含 ${short(expected)}`, ev);
}

function judgeRelay(f: VerifyFacts): ProbeResult {
  if (!f.webRelay.applicable) return result("web-relay", "pass", "本机没配中继，不适用", { applicable: false });
  return judgeWeb("web-relay", "中继", f.webRelay, f.expectedWeb);
}

function judgeDaemon(id: ProbeId, daemon: Daemon, f: VerifyFacts): ProbeResult {
  const d = f.daemons[daemon];
  const mergedAt = f.pr?.mergedAt ?? null;
  const ev = { daemon, pid: d?.pid ?? null, startedAt: d?.startedAt ?? null, mergedAt, ...(d?.error ? { error: d.error } : {}) };
  if (!d || d.error) return result(id, "unknown", `查不到 ${daemon} 进程：${d?.error ?? "没采集"}`, ev);
  if (!d.pid) return result(id, "fail", `${daemon} 没在跑`, ev);
  if (!d.startedAt) return result(id, "unknown", `读不到 ${daemon}（pid ${d.pid}）的启动时间`, ev);
  if (!mergedAt) return result(id, "unknown", "不知道合并时间，比不了", ev);
  if (d.startedAt > mergedAt) return result(id, "pass", `${daemon} 启动于 ${when(d.startedAt)}，晚于合并 ${when(mergedAt)}`, ev);
  return result(id, "fail", `${daemon} 启动于 ${when(d.startedAt)}，早于合并 ${when(mergedAt)}——还没重启`, ev);
}

function judgeEvidence(f: VerifyFacts): ProbeResult {
  const { path, bytes } = f.evidence;
  const ev = { path, bytes };
  if (!path) return result("manual-evidence", "fail", "任务没挂 PR，要带 --evidence <证据文件>", ev);
  if (bytes === null) return result("manual-evidence", "fail", `证据文件不存在：${path}`, ev);
  if (bytes === 0) return result("manual-evidence", "fail", `证据文件是空的：${path}`, ev);
  return result("manual-evidence", "pass", `证据 ${path}（${bytes} 字节）`, ev);
}

export function judgeProbe(id: ProbeId, f: VerifyFacts): ProbeResult {
  switch (id) {
    case "pr-merged": return judgePr(f);
    case "web-local": return judgeWeb("web-local", "本机", f.webLocal, f.expectedWeb);
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
 * 豁免只能给这次检查单里、且没通过的项；给了别的一律报错（写错 id 就等于没豁免，静默吞掉会让人以为放行了）。
 * 检查单推断不全时总结论恒为 unknown，豁免也救不了——不知道该核什么，就不能说核过了。
 */
export function checklistVerdict(plan: ChecklistPlan, results: ProbeResult[], waivers: Partial<Record<ProbeId, string>> = {}): ChecklistVerdict {
  for (const id of Object.keys(waivers) as ProbeId[]) {
    const r = results.find((x) => x.id === id);
    if (!r) throw new Error(`豁免的 ${id} 不在这次的检查单里（${plan.probes.join(", ")}）`);
    if (r.status === "pass") throw new Error(`${id} 已经通过，不需要豁免`);
  }
  const checks = results.map((r) => (waivers[r.id] ? { ...r, waived: waivers[r.id] } : r));
  const blocking = checks.filter((r) => r.status !== "pass" && !r.waived);
  const status: ProbeStatus = plan.incomplete || blocking.some((r) => r.status === "unknown") ? "unknown" : blocking.length ? "fail" : "pass";
  // fail 比 unknown 更确定：有一项明确没过就报 fail，免得人去等一个「查不到」的项
  return { result: blocking.some((r) => r.status === "fail") ? "fail" : status, checks, blocking };
}

/** CLI / 报错里的一句话：哪些项没过 */
export function blockingSummary(v: ChecklistVerdict, plan: ChecklistPlan): string {
  const parts = v.blocking.map((r) => `${r.id}（${r.status}）：${r.detail}`);
  if (plan.incomplete) parts.unshift("拿不到 PR 的文件列表，推断不出检查单——gh 恢复后重跑，或在 task extra.checks 里手工指定");
  return parts.join("；");
}
