/**
 * 完成检查单的事实采集（判定在 ledger-probes.ts）：只采这次检查单用得到的项。每一步失败都记成 error 让对应探针判 unknown，
 * 不抛——一项查不到不能让别的项也没结果。外部命令经 `run` 注入，测试给假输出（tests/ledger-verify.test.ts）。
 * daemon 核的是进程的工作目录（它实际加载代码的仓库，从 lsof 取）：HEAD 含合并提交、且进程启动晚于 HEAD 开始含它的时刻；
 * 不用 CLI 自己的仓库（PM 常在 worktree 里跑），也不用 /api/v1/version（那里的 commit 是现取的 HEAD，不代表进程加载的代码）。
 */
import { readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { bridgePortOf } from "./bridge-port.js";
import { resolveBridgeUrl } from "./bridge-url.js";
import { fetchRelayStatus, type RelayStatusLike } from "./doctor-relay.js";
import { fetchRelayWebCommit } from "./doctor-relay-web.js";
import { DAEMONS, type Daemon, type DaemonFacts, type DeployedWeb, type ProbeId, type VerifyFacts } from "./ledger-probes.js";
import { runBounded } from "./run-bounded.js";
import { readBuildInfo } from "./static-site.js";
import { WEB_PATHSPEC } from "./web-build.js";
import { currentLink } from "./web-releases.js";

type RunFn = (argv: string[], opts?: { cwd?: string; timeoutMs?: number }) => Promise<{ code: number | null; stdout: string; stderr: string }>;

export interface FactsDeps {
  /** CLI 所在的仓库：gh / git fetch / 期望的网页提交都在这里查 */
  repoRoot: string;
  run: RunFn;
  /** 本机托管的网页版本（web-releases/current 的 build-info） */
  localWebCommit(): string | null;
  relayStatus(): Promise<RelayStatusLike | null>;
  relayWebCommit(base: string): Promise<string | null>;
  bridgePort(): number | null;
  fileSize(path: string): number | null;
  /** 仓库相对路径读源码（算 daemon 的 import 闭包） */
  readRepoFile(rel: string): string | null;
}

/**
 * LC_ALL=C：ps lstart 按 locale 出星期 / 月份名，zh_CN 下 Date.parse 认不出。
 * GIT_TERMINAL_PROMPT=0 与低速限制：凭据过期时 git fetch 不停在交互提示、网络半死时不无限拖；再兜底有 runBounded 的整组超时。
 */
const CMD_ENV = { LC_ALL: "C", GIT_TERMINAL_PROMPT: "0", GIT_HTTP_LOW_SPEED_LIMIT: "1000", GIT_HTTP_LOW_SPEED_TIME: "10" };

export function realFactsDeps(repoRoot: string): FactsDeps {
  return {
    repoRoot,
    run: (argv, o = {}) => runBounded(argv, { cwd: o.cwd ?? repoRoot, env: { ...process.env, ...CMD_ENV }, timeoutMs: o.timeoutMs ?? 20_000 }),
    localWebCommit: () => readBuildInfo(currentLink())?.webCommit ?? null,
    relayStatus: fetchRelayStatus,
    relayWebCommit: fetchRelayWebCommit,
    bridgePort: () => bridgePortOf(resolveBridgeUrl()),
    fileSize: (p) => {
      try {
        return statSync(resolve(p)).size;
      } catch {
        return null; // 不存在 / 读不了：探针按「证据文件不存在」判 fail，原因写在 detail 里
      }
    },
    readRepoFile: (rel) => {
      try {
        return readFileSync(join(repoRoot, rel), "utf8");
      } catch {
        return null; // 没有这个文件：import 解析时当它不存在，换下一个候选后缀
      }
    },
  };
}

const LABEL: Record<Daemon, string> = { bridge: "com.claudestra.bridge", cron: "com.claudestra.cron", launcher: "com.claudestra.launcher" };

const firstLine = (s: string) => s.trim().split("\n")[0]?.trim() || "";
const ancestry = (code: number | null) => (code === 0 ? true : code === 1 ? false : null);

async function git(d: FactsDeps, repo: string, ...args: string[]) {
  return d.run(["git", "-C", repo, ...args]);
}

/** PR 引用 → gh api 用的 {repo, number}：GitHub 链接带 owner/repo；#12 / 12 用当前仓库（gh 的 {owner}/{repo} 占位） */
function parsePrRef(ref: string): { repo: string; number: string } | null {
  const url = ref.match(/github\.com\/([^/]+\/[^/]+)\/pull\/(\d+)\/?$/);
  if (url) return { repo: url[1], number: url[2] };
  const n = ref.match(/^#?(\d+)$/)?.[1];
  return n ? { repo: "{owner}/{repo}", number: n } : null;
}

type PrFacts = NonNullable<VerifyFacts["pr"]>;

/** 文件列表走 REST 分页（gh pr view 的 files 最多 100 个；squash / rebase 合并时也不依赖合并提交的形状） */
async function prFacts(d: FactsDeps, ref: string): Promise<PrFacts> {
  const base: PrFacts = { ref, state: null, head: null, branch: null, mergeCommit: null, mergedAt: null, files: null };
  const id = parsePrRef(ref);
  if (!id) return { ...base, error: `认不出 PR 编号：${ref}` };
  const r = await d.run(["gh", "pr", "view", ref, "--json", "state,mergeCommit,mergedAt,headRefOid,headRefName"]);
  if (r.code !== 0) return { ...base, error: firstLine(r.stderr) || `gh 退出码 ${r.code}` };
  let pr: PrFacts;
  try {
    const o = JSON.parse(r.stdout) as { state?: string; mergeCommit?: { oid?: string } | null; mergedAt?: string | null; headRefOid?: string; headRefName?: string };
    const mergedAt = o.mergedAt ? Date.parse(o.mergedAt) : NaN;
    pr = { ...base, state: o.state ?? null, head: o.headRefOid ?? null, branch: o.headRefName ?? null, mergeCommit: o.mergeCommit?.oid ?? null,
      mergedAt: Number.isFinite(mergedAt) ? mergedAt : null };
  } catch (e) {
    return { ...base, error: `gh 输出解析不了：${(e as Error).message}` };
  }
  const f = await d.run(["gh", "api", "--paginate", `repos/${id.repo}/pulls/${id.number}/files?per_page=100`, "--jq", ".[].filename"]);
  pr.files = f.code === 0 ? f.stdout.split("\n").map((s) => s.trim()).filter(Boolean) : null;
  return pr;
}

/** expected 是 deployed 本身或其祖先；本机 git 认不出 deployed → null */
async function contains(d: FactsDeps, expected: string, deployed: string): Promise<boolean | null> {
  if ((await git(d, d.repoRoot, "cat-file", "-e", `${deployed}^{commit}`)).code !== 0) return null;
  return ancestry((await git(d, d.repoRoot, "merge-base", "--is-ancestor", expected, deployed)).code);
}

async function deployed(d: FactsDeps, commit: string | null, expected: string | null, error?: string): Promise<DeployedWeb> {
  if (error) return { commit, contains: null, error };
  return { commit, contains: commit && expected ? await contains(d, expected, commit) : null };
}

async function relayWeb(d: FactsDeps, expected: string | null): Promise<VerifyFacts["webRelay"]> {
  const st = await d.relayStatus();
  if (!st) return { applicable: true, commit: null, contains: null, error: "问不到本机 bridge 的中继状态（bridge 没在跑？）" };
  if (!st.enabled) return { applicable: false, commit: null, contains: null };
  let host = st.base ?? null;
  try {
    host ??= st.relayUrl ? new URL(st.relayUrl).hostname : null;
  } catch {
    host = null; // RELAY_URL 写坏了：下面按「不知道中继主机」报 unknown
  }
  if (!host) return { applicable: true, commit: null, contains: null, error: "不知道中继主机名" };
  const commit = await d.relayWebCommit(host);
  return { applicable: true, ...(await deployed(d, commit, expected, commit ? undefined : `https://${host}/build-info.json 拿不到`)) };
}

async function launchdPid(d: FactsDeps, label: string): Promise<{ pid: string | null; error?: string }> {
  const r = await d.run(["launchctl", "list"]);
  if (r.code !== 0) return { pid: null, error: "launchctl list 失败" };
  const line = r.stdout.split("\n").find((l) => l.split("\t")[2]?.trim() === label);
  if (!line) return { pid: null };
  const pid = line.split("\t")[0].trim();
  return { pid: /^\d+$/.test(pid) ? pid : null };
}

/** bridge 先按端口找监听者（沙箱里的 bridge 不归 launchd 管），找不到再问 launchd；cron / launcher 只问 launchd */
async function daemonPid(d: FactsDeps, daemon: Daemon): Promise<{ pid: string | null; error?: string }> {
  const port = daemon === "bridge" ? d.bridgePort() : null;
  if (port) {
    const pid = firstLine((await d.run(["lsof", "-nP", "-t", `-iTCP:${port}`, "-sTCP:LISTEN"])).stdout);
    if (/^\d+$/.test(pid)) return { pid };
  }
  return launchdPid(d, LABEL[daemon]);
}

/** reflog 从新到旧：HEAD 连续包含合并提交的最早一条的时刻（只看合并前 10 分钟以后的条目，最多 50 条） */
async function headSince(d: FactsDeps, repo: string, merge: string, mergedAt: number): Promise<number | null> {
  const r = await git(d, repo, "reflog", "--date=unix", "--format=%H %gd", "-n", "50", "HEAD");
  if (r.code !== 0) return null;
  let since: number | null = null;
  for (const line of r.stdout.split("\n")) {
    const m = line.match(/^([0-9a-f]{7,40}) HEAD@\{(\d+)\}/);
    if (!m) continue;
    const ts = Number(m[2]) * 1000;
    if (ts < mergedAt - 600_000) break;
    if (ancestry((await git(d, repo, "merge-base", "--is-ancestor", merge, m[1])).code) !== true) break;
    since = ts;
  }
  return since;
}

async function daemonFacts(d: FactsDeps, daemon: Daemon, pr: PrFacts | null): Promise<DaemonFacts> {
  const { pid, error } = await daemonPid(d, daemon);
  if (!pid) return { pid: null, startedAt: null, ...(error ? { error } : {}) };
  const ps = await d.run(["ps", "-o", "lstart=", "-p", pid]);
  const t = Date.parse(firstLine(ps.stdout)); // LC_ALL=C 下形如 "Mon Sep 28 21:03:26 2026"（本地时区，秒级）
  const startedAt = ps.code === 0 && Number.isFinite(t) ? t : null;
  const cwdLine = (await d.run(["lsof", "-a", "-d", "cwd", "-p", pid, "-Fn"])).stdout.split("\n").find((l) => l.startsWith("n/"));
  const cwd = cwdLine ? cwdLine.slice(1) : null;
  if (!cwd || !pr?.mergeCommit || !pr.mergedAt) return { pid, startedAt, cwd };
  const has = (await git(d, cwd, "cat-file", "-e", `${pr.mergeCommit}^{commit}`)).code === 0
    ? ancestry((await git(d, cwd, "merge-base", "--is-ancestor", pr.mergeCommit, "HEAD")).code)
    : false; // 那边的仓库里还没有这个提交对象：HEAD 不可能包含它
  return { pid, startedAt, cwd, codeHasMerge: has, headSince: has ? await headSince(d, cwd, pr.mergeCommit, pr.mergedAt) : null };
}

export type PrStage = Pick<VerifyFacts, "pr" | "mergeInMain" | "fetchError">;

/** 第一段：PR 状态、合并提交、文件列表（检查单按它推断）；fetch 之后判合并提交在不在 origin/main */
export async function collectPrStage(d: FactsDeps, ref: string | null): Promise<PrStage> {
  if (!ref) return { pr: null, mergeInMain: null };
  const pr = await prFacts(d, ref);
  if (pr.error) return { pr, mergeInMain: null };
  const out: PrStage = { pr, mergeInMain: null };
  const f = await git(d, d.repoRoot, "fetch", "--quiet", "origin", "main");
  if (f.code !== 0) out.fetchError = firstLine(f.stderr) || (f.code === null ? "超时" : `git fetch 退出码 ${f.code}`);
  if (pr.mergeCommit) out.mergeInMain = ancestry((await git(d, d.repoRoot, "merge-base", "--is-ancestor", pr.mergeCommit, "origin/main")).code);
  return out;
}

/** 第二段：只采检查单要的——没有网页探针就不问中继，没有 daemon 探针就不跑 ps */
export async function collectVerifyFacts(
  d: FactsDeps,
  input: { prStage: PrStage; probes: readonly ProbeId[]; evidence: string | null; taskBranch: string | null },
): Promise<VerifyFacts> {
  const want = (id: ProbeId) => input.probes.includes(id);
  const { pr } = input.prStage;
  const facts: VerifyFacts = {
    ...input.prStage, taskBranch: input.taskBranch, expectedWeb: null,
    webLocal: { commit: null, contains: null }, webRelay: { applicable: false, commit: null, contains: null },
    daemons: {}, evidence: { path: input.evidence, bytes: input.evidence ? d.fileSize(input.evidence) : null },
  };
  if (pr?.mergeCommit && (want("web-local") || want("web-relay"))) {
    const w = await git(d, d.repoRoot, "log", "-1", "--format=%H", pr.mergeCommit, ...WEB_PATHSPEC);
    facts.expectedWeb = w.code === 0 ? firstLine(w.stdout) || null : null;
  }
  if (want("web-local")) facts.webLocal = await deployed(d, d.localWebCommit(), facts.expectedWeb);
  if (want("web-relay")) facts.webRelay = await relayWeb(d, facts.expectedWeb);
  for (const daemon of DAEMONS) {
    if (want(`daemon-${daemon}` as ProbeId)) facts.daemons[daemon] = await daemonFacts(d, daemon, pr);
  }
  return facts;
}

/** 这个仓库的主工作树（worktree 里跑也返回主树）：判断任务所属项目是否拥有本仓库 */
export async function mainRepoRoot(d: FactsDeps): Promise<string | null> {
  const r = await git(d, d.repoRoot, "rev-parse", "--path-format=absolute", "--git-common-dir");
  const dir = firstLine(r.stdout);
  return r.code === 0 && dir ? dirname(dir) : null;
}
