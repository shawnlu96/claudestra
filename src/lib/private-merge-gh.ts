/**
 * merge-arch-MERGEAUTO1 · the private merge's gh calls: structured argv, bounded, run in the private checkout. A failure is told
 * as its class and exit code only (`gh pr view 失败（exit 1）`, `… 超时`, `… 输出不合规`): a private repository's stderr may carry
 * its remote URL or a local path, so it is never echoed (scheduler-merge-handoff-private.ts's rule). tests/private-merge*.test.ts.
 */
import type { BoundedResult, runBounded } from "./run-bounded.js";

const PRIVATE_GH_MS = 30_000;
const PRIVATE_MERGE_SEND_MS = 60_000;
const SHA = /^[a-f0-9]{40}$/i;

export type GhFail = { fail: string };
export const isGhFail = (v: unknown): v is GhFail => !!v && typeof v === "object" && typeof (v as GhFail).fail === "string";

export interface PrivatePr {
  state: "OPEN" | "MERGED" | "CLOSED";
  head: string;
  base: string;
  draft: boolean;
  mergeable: string;
  mergeSha: string | null;
}
type CheckBucket = "pass" | "fail" | "pending" | "skipping" | "cancel";
export interface PrivateCheck { name: string; bucket: CheckBucket }

export interface PrivateGh {
  pr(): Promise<PrivatePr | GhFail>;
  /** Required status checks of main's protection; null = none readable (no protection, none required, or no permission). */
  required(): Promise<string[] | null | GhFail>;
  checks(): Promise<PrivateCheck[] | GhFail>;
  mainHead(): Promise<string | GhFail>;
  /** `gh pr merge <n> --repo <repo> --merge --match-head-commit <head>`; null = gh said it merged. */
  merge(head: string): Promise<null | GhFail>;
}

const failOf = (what: string, r: BoundedResult): GhFail => ({ fail: r.timedOut ? `${what} 超时` : `${what} 失败（exit ${r.code ?? "无"}）` });
const malformed = (what: string): GhFail => ({ fail: `${what} 输出不合规` });
function json(stdout: string): unknown {
  try { return JSON.parse(stdout); } catch { return undefined; }
}

export function privateGh(command: typeof runBounded, dir: string, repo: string, pull: number): PrivateGh {
  const env = { ...process.env, DISCORD_CHANNEL_ID: "", CLAUDESTRA_SCHEDULER_SERVICE: "", GIT_TERMINAL_PROMPT: "0", GH_PROMPT_DISABLED: "1" };
  const gh = (args: string[], timeoutMs = PRIVATE_GH_MS) => command(["gh", ...args], { cwd: dir, env, timeoutMs });
  const n = String(pull);
  return {
    async pr() {
      const r = await gh(["pr", "view", n, "--repo", repo, "--json", "state,headRefOid,baseRefName,isDraft,mergeable,mergeCommit"]);
      if (r.code !== 0 || r.timedOut) return failOf("gh pr view", r);
      const raw = json(r.stdout) as Record<string, unknown> | undefined;
      if (!raw || !["OPEN", "MERGED", "CLOSED"].includes(String(raw.state)) || typeof raw.headRefOid !== "string" || !SHA.test(raw.headRefOid)) {
        return malformed("gh pr view");
      }
      const oid = (raw.mergeCommit as { oid?: unknown } | null)?.oid;
      return { state: raw.state as PrivatePr["state"], head: raw.headRefOid, base: String(raw.baseRefName ?? ""), draft: raw.isDraft === true,
        mergeable: String(raw.mergeable ?? "UNKNOWN"), mergeSha: typeof oid === "string" && SHA.test(oid) ? oid : null };
    },
    async required() {
      const r = await gh(["api", `repos/${repo}/branches/main/protection/required_status_checks`]);
      // 404: no protection or none required; 403: no permission to read it. Only these fall back; any other failure retries.
      if (r.code !== 0 && !r.timedOut && /\bHTTP 40[34]\b/.test(r.stderr)) return null;
      if (r.code !== 0 || r.timedOut) return failOf("gh api 分支保护", r);
      const raw = json(r.stdout) as { contexts?: unknown; checks?: unknown } | undefined;
      if (!raw || typeof raw !== "object") return malformed("gh api 分支保护");
      const contexts = Array.isArray(raw.contexts) ? raw.contexts : [];
      const checks = Array.isArray(raw.checks) ? raw.checks.map((c) => (c as { context?: unknown })?.context) : [];
      const names = [...contexts, ...checks];
      if (names.some((c) => typeof c !== "string" || !c)) return malformed("gh api 分支保护");
      return names.length ? [...new Set(names as string[])] : null;
    },
    async checks() {
      const r = await gh(["pr", "checks", n, "--repo", repo, "--json", "name,bucket"]);
      // gh exits 1 for a failed check and 8 for a pending one while still printing JSON; "no checks reported" is an empty list, said outright
      if (!r.timedOut && !r.stdout.trim() && [0, 1, 8].includes(r.code ?? -1) && /no checks reported/i.test(r.stderr)) return [];
      if (r.timedOut || ![0, 1, 8].includes(r.code ?? -1)) return failOf("gh pr checks", r);
      const list = json(r.stdout);
      // exit 1 is also gh's plain error: without a JSON list it stays a failure (class and exit code), never "malformed"
      if (r.code === 1 && !Array.isArray(list)) return failOf("gh pr checks", r);
      if (!Array.isArray(list) || list.some((c) => !c || typeof c.name !== "string" ||
        !["pass", "fail", "pending", "skipping", "cancel"].includes(String(c.bucket)))) return malformed("gh pr checks");
      return list.map((c) => ({ name: c.name as string, bucket: c.bucket as CheckBucket }));
    },
    async mainHead() {
      const r = await gh(["api", `repos/${repo}/commits/main`, "--jq", ".sha"]);
      if (r.code !== 0 || r.timedOut) return failOf("gh api main", r);
      const sha = r.stdout.trim();
      return SHA.test(sha) ? sha : malformed("gh api main");
    },
    async merge(head) {
      if (!SHA.test(head)) return { fail: "审查 head 不是完整 SHA" };
      const r = await gh(["pr", "merge", n, "--repo", repo, "--merge", "--match-head-commit", head], PRIVATE_MERGE_SEND_MS);
      return r.code !== 0 || r.timedOut ? failOf("gh pr merge", r) : null;
    },
  };
}
