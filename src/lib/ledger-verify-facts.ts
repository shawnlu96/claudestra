/**
 * 完成检查单的事实采集（判定在 ledger-probes.ts）：只采这次检查单用得到的项。每一步失败都记成 error 让对应探针判 unknown，
 * 不抛——一项查不到不能让别的项也没结果。外部命令经 `run` 注入，测试给假输出（tests/ledger-verify.test.ts）。
 * 进程启动时间用 ps 现查，不用 /api/v1/version：那里的 commit 是每次现取的仓库 HEAD，代表不了进程启动时加载的代码。
 */
import { statSync } from "node:fs";
import { resolve } from "node:path";
import { bridgePortOf } from "./bridge-port.js";
import { resolveBridgeUrl } from "./bridge-url.js";
import { fetchRelayStatus, type RelayStatusLike } from "./doctor-relay.js";
import { fetchRelayWebCommit } from "./doctor-relay-web.js";
import { DAEMONS, type Daemon, type DeployedWeb, type ProbeId, type VerifyFacts } from "./ledger-probes.js";
import { runWithTimeout, type SpawnFn } from "./quota-keychain.js";
import { readBuildInfo } from "./static-site.js";
import { WEB_PATHSPEC } from "./web-build.js";
import { currentLink } from "./web-releases.js";

type RunFn = (argv: string[], timeoutMs?: number) => Promise<{ code: number | null; stdout: string; stderr: string }>;

export interface FactsDeps {
  repoRoot: string;
  run: RunFn;
  /** 本机托管的网页版本（web-releases/current 的 build-info） */
  localWebCommit(): string | null;
  relayStatus(): Promise<RelayStatusLike | null>;
  relayWebCommit(base: string): Promise<string | null>;
  bridgePort(): number | null;
  fileSize(path: string): number | null;
}

export function realFactsDeps(repoRoot: string): FactsDeps {
  const spawn = (argv: string[]) => Bun.spawn(argv, { cwd: repoRoot, stdin: "ignore", stdout: "pipe", stderr: "pipe" }) as unknown as ReturnType<SpawnFn>;
  return {
    repoRoot,
    run: (argv, timeoutMs = 20_000) => runWithTimeout(argv, timeoutMs, spawn),
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
  };
}

const LABEL: Record<Daemon, string> = { bridge: "com.claudestra.bridge", cron: "com.claudestra.cron", launcher: "com.claudestra.launcher" };

const firstLine = (s: string) => s.trim().split("\n")[0]?.trim() || "";

async function git(d: FactsDeps, ...args: string[]) {
  return d.run(["git", "-C", d.repoRoot, ...args]);
}

type PrFacts = NonNullable<VerifyFacts["pr"]>;

/** gh 的 files 只回前 100 个；满 100 就改用合并提交对第一父提交的 diff（本仓库是 merge commit 合并） */
async function prFacts(d: FactsDeps, ref: string): Promise<PrFacts> {
  const base: PrFacts = { ref, state: null, head: null, mergeCommit: null, mergedAt: null, files: null };
  const r = await d.run(["gh", "pr", "view", ref, "--json", "state,mergeCommit,mergedAt,headRefOid,files"]);
  if (r.code !== 0) return { ...base, error: firstLine(r.stderr) || `gh 退出码 ${r.code}` };
  try {
    const o = JSON.parse(r.stdout) as { state?: string; mergeCommit?: { oid?: string } | null; mergedAt?: string | null; headRefOid?: string; files?: { path?: string }[] };
    const files = Array.isArray(o.files) ? o.files.map((f) => String(f.path ?? "")).filter(Boolean) : null;
    const mergedAt = o.mergedAt ? Date.parse(o.mergedAt) : NaN;
    return { ...base, state: o.state ?? null, head: o.headRefOid ?? null, mergeCommit: o.mergeCommit?.oid ?? null, mergedAt: Number.isFinite(mergedAt) ? mergedAt : null, files };
  } catch (e) {
    return { ...base, error: `gh 输出解析不了：${(e as Error).message}` };
  }
}

async function fullFileList(d: FactsDeps, pr: PrFacts): Promise<string[] | null> {
  if (!pr.files || pr.files.length < 100 || !pr.mergeCommit) return pr.files;
  const r = await git(d, "diff", "--name-only", `${pr.mergeCommit}^1`, pr.mergeCommit);
  return r.code === 0 ? r.stdout.split("\n").map((s) => s.trim()).filter(Boolean) : null;
}

/** expected 是 deployed 本身或其祖先；本机 git 认不出 deployed → null */
async function contains(d: FactsDeps, expected: string, deployed: string): Promise<boolean | null> {
  if ((await git(d, "cat-file", "-e", `${deployed}^{commit}`)).code !== 0) return null;
  const r = await git(d, "merge-base", "--is-ancestor", expected, deployed);
  return r.code === 0 ? true : r.code === 1 ? false : null;
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
  if (!line) return { pid: null, error: `launchd 里没有 ${label}` };
  const pid = line.split("\t")[0].trim();
  return { pid: /^\d+$/.test(pid) ? pid : null };
}

/** bridge 先按端口找监听者（沙箱里的 bridge 不归 launchd 管），找不到再问 launchd；cron / launcher 只问 launchd */
async function daemonPid(d: FactsDeps, daemon: Daemon): Promise<{ pid: string | null; error?: string }> {
  const port = daemon === "bridge" ? d.bridgePort() : null;
  if (port) {
    const r = await d.run(["lsof", "-nP", "-t", `-iTCP:${port}`, "-sTCP:LISTEN"]);
    const pid = firstLine(r.stdout);
    if (/^\d+$/.test(pid)) return { pid };
  }
  return launchdPid(d, LABEL[daemon]);
}

async function daemonFacts(d: FactsDeps, daemon: Daemon): Promise<{ pid: string | null; startedAt: number | null; error?: string }> {
  const { pid, error } = await daemonPid(d, daemon);
  if (!pid) return { pid: null, startedAt: null, ...(error && !error.startsWith("launchd 里没有") ? { error } : {}) };
  const r = await d.run(["ps", "-o", "lstart=", "-p", pid]);
  const t = Date.parse(firstLine(r.stdout)); // macOS lstart 形如 "Mon Sep 28 21:03:26 2026"（本地时区，秒级）
  return { pid, startedAt: r.code === 0 && Number.isFinite(t) ? t : null };
}

export type PrStage = Pick<VerifyFacts, "pr" | "headInMain" | "fetchError">;

/** 第一段：PR 状态、合并提交、文件列表（检查单按它推断），fetch 之后判 head 在不在 origin/main */
export async function collectPrStage(d: FactsDeps, ref: string | null): Promise<PrStage> {
  if (!ref) return { pr: null, headInMain: null };
  const pr = await prFacts(d, ref);
  if (pr.error) return { pr, headInMain: null };
  const out: PrStage = { pr, headInMain: null };
  const f = await git(d, "fetch", "--quiet", "origin", "main");
  if (f.code !== 0) out.fetchError = firstLine(f.stderr) || `git fetch 退出码 ${f.code}`;
  if (pr.head) {
    const a = await git(d, "merge-base", "--is-ancestor", pr.head, "origin/main");
    out.headInMain = a.code === 0 ? true : a.code === 1 ? false : null;
  }
  pr.files = await fullFileList(d, pr);
  return out;
}

/** 第二段：只采检查单要的——没有网页探针就不问中继，没有 daemon 探针就不跑 ps */
export async function collectVerifyFacts(d: FactsDeps, input: { prStage: PrStage; probes: readonly ProbeId[]; evidence: string | null }): Promise<VerifyFacts> {
  const want = (id: ProbeId) => input.probes.includes(id);
  const { pr } = input.prStage;
  const facts: VerifyFacts = {
    ...input.prStage, expectedWeb: null,
    webLocal: { commit: null, contains: null }, webRelay: { applicable: false, commit: null, contains: null },
    daemons: {}, evidence: { path: input.evidence, bytes: input.evidence ? d.fileSize(input.evidence) : null },
  };
  if (pr?.mergeCommit && (want("web-local") || want("web-relay"))) {
    const w = await git(d, "log", "-1", "--format=%H", pr.mergeCommit, ...WEB_PATHSPEC);
    facts.expectedWeb = w.code === 0 ? firstLine(w.stdout) || null : null;
  }
  if (want("web-local")) facts.webLocal = await deployed(d, d.localWebCommit(), facts.expectedWeb);
  if (want("web-relay")) facts.webRelay = await relayWeb(d, facts.expectedWeb);
  for (const daemon of DAEMONS) {
    if (want(`daemon-${daemon}` as ProbeId)) facts.daemons[daemon] = await daemonFacts(d, daemon);
  }
  return facts;
}
