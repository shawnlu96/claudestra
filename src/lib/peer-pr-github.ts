/**
 * GitHub / git reads for the peer PR path (i28-A2 §2): structured argv, never a shell; GH_REPO dropped so gh answers for the
 * repoDir checkout only; prompts off; 30 s cap. Output is parsed strictly — one missing or mistyped field throws and the
 * caller skips the round rather than act on a guess. The PR head is fetched into refs/claudestra/peer-pr/<n> (refs only, the
 * checkout is never touched) so reviewer worktrees sharing the object store can pin it. tests/peer-pr-tick.test.ts fakes all of it.
 */
import { runBounded, type BoundedResult } from "./run-bounded.js";
import { MAX_FILES, type ChangedFile, type FileList } from "./peer-pr-surface.js";

export type Command = (argv: string[], opts: { cwd?: string; env?: Record<string, string | undefined>; timeoutMs: number }) => Promise<BoundedResult>;

export interface OpenPr {
  number: number; url: string; title: string; login: string; branch: string; head: string; base: string;
  crossRepo: boolean; headOwner: string | null; draft: boolean;
}
export interface PrState { state: "OPEN" | "MERGED" | "CLOSED"; head: string; base: string; branch: string; crossRepo: boolean; headOwner: string | null }

const TIMEOUT_MS = 30_000;
const SHA = /^[0-9a-f]{40}$/;
const REPO = /^[\w.-]+\/[\w.-]+$/;

/** gh / git env: no repo override, no prompts, no agent channel or scheduler identity leaking into the child. */
export function ghEnv(env: Record<string, string | undefined> = process.env): Record<string, string | undefined> {
  const { GH_REPO: _drop, ...rest } = env;
  return { ...rest, GH_PROMPT_DISABLED: "1", GIT_TERMINAL_PROMPT: "0", DISCORD_CHANNEL_ID: "", CLAUDESTRA_SCHEDULER_SERVICE: "" };
}

const fail = (what: string): never => { throw new Error(`${what} 输出不合规，本轮不动`); };
const str = (v: unknown, what: string): string => (typeof v === "string" ? v : fail(what));
const bool = (v: unknown, what: string): boolean => (typeof v === "boolean" ? v : fail(what));
const owner = (v: unknown, what: string): string | null => {
  if (v === null) return null;
  const login = (v as { login?: unknown } | undefined)?.login;
  return typeof login === "string" ? login : fail(what);
};

function prOf(raw: unknown, repo: string): OpenPr {
  if (!raw || typeof raw !== "object") return fail("gh pr list");
  const r = raw as Record<string, unknown>;
  const number = r.number;
  if (!Number.isInteger(number) || (number as number) < 1) return fail("gh pr list number");
  const url = str(r.url, "gh pr list url");
  if (url !== `https://github.com/${repo}/pull/${number}`) return fail("gh pr list url");
  const head = str(r.headRefOid, "gh pr list headRefOid");
  if (!SHA.test(head)) return fail("gh pr list headRefOid");
  return { number: number as number, url, title: str(r.title, "gh pr list title"), login: owner(r.author, "gh pr list author") ?? fail("gh pr list author"),
    branch: str(r.headRefName, "gh pr list headRefName"), head, base: str(r.baseRefName, "gh pr list baseRefName"),
    crossRepo: bool(r.isCrossRepository, "gh pr list isCrossRepository"), headOwner: owner(r.headRepositoryOwner, "gh pr list headRepositoryOwner"),
    draft: bool(r.isDraft, "gh pr list isDraft") };
}

function json(out: string, what: string): unknown {
  try { return JSON.parse(out); } catch { return fail(what); /* gh printed something that is not JSON: treat as unreadable */ }
}

export interface PeerPrGithub {
  repo(): Promise<string>;
  listOpen(repo: string): Promise<OpenPr[]>;
  /** null = could not be read in full (failure, malformed, more than MAX_FILES, count mismatch). */
  files(repo: string, n: number): Promise<FileList>;
  body(repo: string, n: number): Promise<string>;
  view(repo: string, n: number): Promise<PrState>;
  /** null = refs/claudestra/peer-pr/<n> now holds exactly `head`; otherwise why not. */
  fetchHead(n: number, head: string): Promise<string | null>;
}

export function peerPrGithub(repoDir: string, command: Command = runBounded): PeerPrGithub {
  const run = async (argv: string[]): Promise<string> => {
    const r = await command(argv, { cwd: repoDir, env: ghEnv(), timeoutMs: TIMEOUT_MS });
    if (r.code !== 0 || r.timedOut) throw new Error(`${argv.slice(0, 3).join(" ")} 失败：${(r.stderr.trim().split("\n")[0] ?? "").slice(0, 200) || `exit ${r.code ?? "timeout"}`}`);
    return r.stdout;
  };
  const gh = (...args: string[]) => run(["gh", ...args]);
  return {
    async repo() {
      const name = str((json(await gh("repo", "view", "--json", "nameWithOwner"), "gh repo view") as Record<string, unknown>)?.nameWithOwner, "gh repo view");
      return REPO.test(name) ? name : fail("gh repo view");
    },
    async listOpen(repo) {
      const list = json(await gh("pr", "list", "--repo", repo, "--state", "open", "--limit", "100", "--json",
        "number,url,title,author,headRefName,headRefOid,baseRefName,isCrossRepository,headRepositoryOwner,isDraft"), "gh pr list");
      return Array.isArray(list) ? list.map((x) => prOf(x, repo)) : fail("gh pr list");
    },
    async files(repo, n) {
      try {
        const count = (json(await gh("pr", "view", String(n), "--repo", repo, "--json", "changedFiles"), "gh pr view") as Record<string, unknown>)?.changedFiles;
        if (!Number.isInteger(count) || (count as number) > MAX_FILES) return null;
        const out = await gh("api", "--paginate", `repos/${repo}/pulls/${n}/files`, "--jq", ".[] | {filename, previous_filename}");
        const rows: ChangedFile[] = out.split("\n").filter((l) => l.trim()).map((l) => {
          const r = json(l, "gh api files") as Record<string, unknown>;
          const prev = r?.previous_filename;
          return { path: str(r?.filename, "gh api files"), ...(prev === null || prev === undefined ? {} : { previous: str(prev, "gh api files") }) };
        });
        return rows.length === count ? rows : null;
      } catch (e) {
        console.error(`⚠️ [peer-pr] PR #${n} 文件清单读不全，按碰了安全面算：${(e as Error).message}`);
        return null;
      }
    },
    async body(repo, n) {
      return str((json(await gh("pr", "view", String(n), "--repo", repo, "--json", "body"), "gh pr view") as Record<string, unknown>)?.body, "gh pr view body");
    },
    async view(repo, n) {
      const r = json(await gh("pr", "view", String(n), "--repo", repo, "--json",
        "state,headRefOid,baseRefName,headRefName,isCrossRepository,headRepositoryOwner"), "gh pr view") as Record<string, unknown>;
      const state = str(r?.state, "gh pr view state");
      const head = str(r?.headRefOid, "gh pr view head");
      if (!["OPEN", "MERGED", "CLOSED"].includes(state) || !SHA.test(head)) return fail("gh pr view");
      return { state: state as PrState["state"], head, base: str(r.baseRefName, "gh pr view base"), branch: str(r.headRefName, "gh pr view branch"),
        crossRepo: bool(r.isCrossRepository, "gh pr view cross"), headOwner: owner(r.headRepositoryOwner, "gh pr view owner") };
    },
    async fetchHead(n, head) {
      const ref = `refs/claudestra/peer-pr/${n}`;
      await run(["git", "-C", repoDir, "fetch", "--no-tags", "origin", `+refs/pull/${n}/head:${ref}`]);
      const at = (await run(["git", "-C", repoDir, "rev-parse", "--verify", "--quiet", `${ref}^{commit}`])).trim();
      return at === head ? null : `取到的 ${ref} 是 ${at.slice(0, 12)}，不是卡上的 ${head.slice(0, 12)}`;
    },
  };
}

/** Which of these 40 / 64-hex values are commits in repoDir (`git cat-file --batch-check`); anything unreadable = none. */
export async function knownCommits(repoDir: string, shas: readonly string[], timeoutMs = 10_000): Promise<Set<string>> {
  const want = [...new Set(shas.map((s) => s.toLowerCase()).filter((s) => /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(s)))].slice(0, 200);
  if (!want.length) return new Set();
  const p = Bun.spawn(["git", "-C", repoDir, "cat-file", "--batch-check"], { stdin: "pipe", stdout: "pipe", stderr: "pipe", env: ghEnv() });
  const timer = setTimeout(() => p.kill(), timeoutMs);
  try {
    p.stdin.write(`${want.join("\n")}\n`);
    await p.stdin.end();
    const [out, code] = await Promise.all([new Response(p.stdout).text(), p.exited]);
    if (code !== 0) return new Set();
    return new Set(out.split("\n").map((l) => l.split(" ")).filter((f) => f[1] === "commit" && want.includes(f[0] ?? "")).map((f) => f[0]!));
  } finally { clearTimeout(timer); }
}
