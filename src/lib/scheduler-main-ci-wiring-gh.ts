/**
 * MAINCIW: the live MainCiReadPort for scheduler-main-ci.ts readMainCi. Structured gh argv only (never a shell string); the pass hands
 * in its guarded command (the same guard(active, runBounded) the merge driver and the train's trainGh use), the CLI a plain runBounded.
 * The envelopes carry the project / repo of the trusted target (scheduler.json), never a value read from a card, PR or text.
 */
import type { runBounded } from "./run-bounded.js";
import { mainCiSha, readMainCi, type MainCiHealth, type MainCiReadPort, type MainCiTarget } from "./scheduler-main-ci.js";

type Command = typeof runBounded;
type Obj = Record<string, unknown>;
const PER_PAGE = 100;
/** 2000 runs / statuses: a list longer than this stays incomplete, which evaluateMainCi reads as invalid_checks (a pause, never green). */
const MAX_PAGES = 20;
const obj = (v: unknown): v is Obj => !!v && typeof v === "object" && !Array.isArray(v);
const oneLine = (s: string) => s.replace(/\s+/g, " ").trim().slice(0, 200);

/** Unknown or contradictory provenance preserves the suite; only a positively identified non-push Actions suite is excluded. */
function nonPushSuites(items: unknown[]): Set<number> {
  const excluded = new Set<number>(), kept = new Set<number>();
  for (const raw of items) {
    if (!obj(raw) || !Number.isSafeInteger(raw.check_suite_id) || (raw.check_suite_id as number) < 1) continue;
    const id = raw.check_suite_id as number;
    if (typeof raw.event !== "string" || !raw.event.trim() || raw.event === "push") kept.add(id);
    else excluded.add(id);
  }
  for (const id of kept) excluded.delete(id);
  return excluded;
}

function mainCiGhPort(command: Command, cwd?: string): MainCiReadPort {
  const api = async (path: string): Promise<Obj> => {
    const r = await command(["gh", "api", "-H", "Accept: application/vnd.github+json", path],
      { cwd, env: { ...process.env, DISCORD_CHANNEL_ID: "", CLAUDESTRA_SCHEDULER_SERVICE: "", GIT_TERMINAL_PROMPT: "0" }, timeoutMs: 30_000 });
    if (r.code !== 0 || r.timedOut) throw new Error(`gh api 失败：${oneLine(r.stderr) || `exit ${r.code ?? "timeout"}`}`);
    const raw = JSON.parse(r.stdout) as unknown;
    if (!obj(raw)) throw new Error("gh api 没有 JSON 对象");
    return raw;
  };
  /** Pages until the listed items reach total_count (or a short page); the last total_count is kept so a list that grew mid-read is caught. */
  const pages = async (path: string, field: string): Promise<{ first: Obj; total: unknown; items: unknown[] }> => {
    let first: Obj | null = null, total: unknown = null;
    const items: unknown[] = [];
    for (let page = 1; page <= MAX_PAGES; page++) {
      const raw = await api(`${path}${path.includes("?") ? "&" : "?"}per_page=${PER_PAGE}&page=${page}`);
      first ??= raw;
      total = raw.total_count;
      const list = raw[field];
      if (!Array.isArray(list)) throw new Error(`gh api ${field} 不是列表`);
      items.push(...list);
      if (list.length < PER_PAGE || (typeof total === "number" && items.length >= total)) break;
    }
    return { first: first!, total, items };
  };
  return {
    async main(t: MainCiTarget) {
      const raw = await api(`repos/${t.repo}/git/ref/heads/main`);
      const o = raw.object;
      return { project: t.project, repo: t.repo, ref: raw.ref, sha: obj(o) && o.type === "commit" ? o.sha : null };
    },
    async checks(t: MainCiTarget, sha: string) {
      const runs = await pages(`repos/${t.repo}/commits/${sha}/check-runs?filter=latest`, "check_runs");
      const status = await pages(`repos/${t.repo}/commits/${sha}/status`, "statuses");
      const actions = await pages(`repos/${t.repo}/actions/runs?head_sha=${sha}`, "workflow_runs");
      if (!Number.isSafeInteger(actions.total) || actions.total !== actions.items.length) throw new Error("gh api workflow runs 不完整");
      const excluded = nonPushSuites(actions.items);
      const filtered = runs.items.filter((raw) => !obj(raw) || !obj(raw.app) || raw.app.slug !== "github-actions" ||
        !obj(raw.check_suite) || !excluded.has(raw.check_suite.id as number));
      // Pagination incompleteness must still reach evaluateMainCi as invalid_checks, never be erased by filtering unrelated suites.
      return { project: t.project, repo: t.repo, sha, total_count: runs.total === runs.items.length ? filtered.length : runs.total, check_runs: filtered,
        commit_status: { sha: status.first.sha, total_count: status.total, statuses: status.items } };
    },
  };
}

/** One observation plus planMainCi's trusted current main: the last main read of it (after the checks), never the health's own SHA. */
export async function readMainCiNow(target: MainCiTarget, command: Command, cwd: string | undefined, now: () => number):
  Promise<{ health: MainCiHealth; currentMainSha: string | null }> {
  const gh = mainCiGhPort(command, cwd);
  let current: string | null = null;
  const port: MainCiReadPort = { checks: gh.checks, main: async (t) => {
    current = null;
    const r = await gh.main(t), sha = (r as { sha?: unknown }).sha;
    current = mainCiSha(sha) ? sha.toLowerCase() : null;
    return r;
  } };
  const health = await readMainCi(target, port, now);
  return { health, currentMainSha: current };
}
