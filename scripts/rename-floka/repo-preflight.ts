/**
 * rename.repo 的本机入口:仓库在 GitHub 上转移之后,把这台机器上 checkout 的 origin 从旧官方地址迁到新地址,并能按记录回滚。
 * 开关 rename.repo = off / observe / on,缺省 off,只从 --mode 读(不读真实状态目录的配置):
 *   off      一次 git 都不调,输出 {"status":"off"}
 *   observe  只读 remote,输出计划(remote 现状、要改的值、不动的值与原因、转移先决条件),零 Git 写入
 *   on       --plan 给 observe 出来、人看过的那份;remote 与计划时不一致就拒绝。原值先写进迁移记录,再改 origin
 *   on --rollback   按迁移记录把 origin 放回原值;当前值不是本工具写的就拒绝覆盖。GitHub 上的转移不因此撤销
 * 工作目录、worktree、hooks 路径都不动;不连 GitHub、不连网络。GitHub 侧的人工核对项见 repo-checklist.md。
 * 用法:bun scripts/rename-floka/repo-preflight.ts [--repo <目录>] [--mode off|observe|on] [--from owner/repo] [--to owner/repo]
 *        [--plan <计划.json>] [--rollback] [--record <记录.json>]
 */
import { renameSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  applyRepoMigration, OFFICIAL_REPO, planRepoMigration, PROPOSED_REPO, REPO_ITEM, rollbackRepoMigration,
} from "../../src/lib/floka-repo/migrate.ts";
import type { MigrationRecord, RecordStore, RemoteEntry, RepoGit, RepoResult } from "../../src/lib/floka-repo/types.ts";

/** 记录默认放在 git 公共目录里(各 worktree 共用一份,不碰工作区文件) */
const RECORD_NAME = "floka-repo-migration.json";

function git(dir: string, args: string[]): { code: number; out: string; err: string } {
  const p = Bun.spawnSync(["git", "-C", dir, ...args], { stdout: "pipe", stderr: "pipe", env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } });
  return { code: p.exitCode ?? 1, out: p.stdout.toString(), err: p.stderr.toString().trim() };
}

const ereEscape = (s: string): string => s.replace(/[.[\]{}()\\*+?^$|]/g, "\\$&");

/** 真实 RepoGit:只读本仓(--local)配置原值,不经 insteadOf;写只有 `git remote set-url <name> <新> ^原值$` */
export function gitRepoPort(dir: string): RepoGit {
  const list = async (): Promise<RemoteEntry[]> => {
    const r = git(dir, ["config", "--local", "-z", "--get-regexp", "^remote\\..*\\.(url|pushurl)$"]);
    if (r.code === 1 && !r.out) return [];
    if (r.code !== 0) throw new Error(`git config 读 remote 失败(exit ${r.code}):${r.err}`);
    const byName = new Map<string, { name: string; urls: string[]; pushUrls: string[] }>();
    for (const rec of r.out.split("\0").filter(Boolean)) {
      const nl = rec.indexOf("\n");
      const key = nl < 0 ? rec : rec.slice(0, nl);
      const value = nl < 0 ? "" : rec.slice(nl + 1);
      const m = /^remote\.(.+)\.(url|pushurl)$/.exec(key);
      if (!m) continue;
      const e = byName.get(m[1]) ?? { name: m[1], urls: [], pushUrls: [] };
      (m[2] === "url" ? e.urls : e.pushUrls).push(value);
      byName.set(m[1], e);
    }
    return [...byName.values()];
  };
  return {
    listRemotes: list,
    async setUrl(remote, key, from, to) {
      const e = (await list()).find((x) => x.name === remote);
      const vals = e ? (key === "url" ? e.urls : e.pushUrls) : [];
      if (vals.length !== 1 || vals[0] !== from) throw new Error(`${remote}.${key} 当前值 ${JSON.stringify(vals)} 不是 ${JSON.stringify(from)},不改`);
      const r = git(dir, ["remote", "set-url", ...(key === "pushurl" ? ["--push"] : []), remote, to, `^${ereEscape(from)}$`]);
      if (r.code !== 0) throw new Error(`git remote set-url 失败(exit ${r.code}):${r.err}`);
    },
  };
}

/** 迁移记录:JSON 文件,先写临时文件再原子改名 */
export function fileRecordStore(path: string): RecordStore {
  return {
    async load() {
      let text: string;
      try { text = readFileSync(path, "utf8"); } catch (e) { if ((e as NodeJS.ErrnoException).code === "ENOENT") return null; throw e; }
      const r = JSON.parse(text) as MigrationRecord;
      if (r?.version !== 1 || r.item !== REPO_ITEM || !Array.isArray(r.changes)) throw new Error(`迁移记录 ${path} 格式不认识`);
      return r;
    },
    async save(record) {
      const tmp = `${path}.${process.pid}.tmp`;
      writeFileSync(tmp, `${JSON.stringify(record, null, 2)}\n`);
      renameSync(tmp, path);
    },
  };
}

function defaultRecordPath(dir: string): string {
  const r = git(dir, ["rev-parse", "--git-common-dir"]);
  if (r.code !== 0) throw new Error(`${dir} 不是 git 仓库:${r.err}`);
  return resolve(dir, r.out.trim(), RECORD_NAME);
}

export interface CliResult { code: number; stdout: string; stderr: string }

const VALUE_FLAGS = new Set(["repo", "mode", "from", "to", "plan", "record"]);

function parseArgs(argv: string[]): { opts: Record<string, string>; rollback: boolean } {
  const opts: Record<string, string> = {};
  let rollback = false;
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    if (flag === "--rollback" && !rollback) { rollback = true; continue; }
    const key = flag.startsWith("--") ? flag.slice(2) : "";
    const value = argv[i + 1];
    if (!VALUE_FLAGS.has(key) || value === undefined || Object.hasOwn(opts, key)) throw new Error(`invalid_arguments: ${flag}`);
    opts[key] = value;
    i++;
  }
  return { opts, rollback };
}

export async function runRepoCli(argv: string[], cwd = process.cwd()): Promise<CliResult> {
  let parsed: ReturnType<typeof parseArgs>;
  try { parsed = parseArgs(argv); } catch (e) { return { code: 2, stdout: "", stderr: (e as Error).message }; }
  const { opts, rollback } = parsed;
  const mode = opts.mode ?? "off";
  if (mode !== "off" && mode !== "observe" && mode !== "on") return { code: 2, stdout: "", stderr: "invalid_mode: --mode 只能是 off / observe / on" };
  if (mode !== "on" && opts.plan !== undefined && !rollback) return { code: 2, stdout: "", stderr: "invalid_arguments: --plan 只在 on 用" };
  const emit = (r: RepoResult): CliResult => ({ code: r.status === "blocked" ? 1 : 0, stdout: `${JSON.stringify(r, null, 2)}\n`, stderr: "" });
  if (mode === "off") return emit({ item: REPO_ITEM, mode, status: "off", refusals: [], githubUntouched: true });
  try {
    const dir = resolve(cwd, opts.repo ?? ".");
    const port = gitRepoPort(dir);
    const records = () => fileRecordStore(opts.record ? resolve(cwd, opts.record) : defaultRecordPath(dir));
    if (rollback) return emit(await rollbackRepoMigration({ mode, git: port, records: records() }));
    if (mode === "observe") return emit(await planRepoMigration({ mode, git: port, from: opts.from ?? OFFICIAL_REPO, to: opts.to ?? PROPOSED_REPO }));
    if (opts.plan === undefined) return { code: 2, stdout: "", stderr: "invalid_arguments: on 必须给 --plan(observe 出来的计划)" };
    const plan: unknown = JSON.parse(readFileSync(resolve(cwd, opts.plan), "utf8"));
    const given = (plan as { plan?: unknown })?.plan ?? plan; // observe 的整份输出或其中的 plan 都认
    return emit(await applyRepoMigration({ mode, git: port, records: records(), plan: given }));
  } catch (e) {
    return { code: 1, stdout: "", stderr: (e as Error).message };
  }
}

if (import.meta.main) {
  const r = await runRepoCli(process.argv.slice(2));
  if (r.stdout) process.stdout.write(r.stdout);
  if (r.stderr) process.stderr.write(`${r.stderr}\n`);
  process.exit(r.code);
}
