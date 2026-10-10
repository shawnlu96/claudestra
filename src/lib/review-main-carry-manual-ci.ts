/**
 * MAINP2 当前 head 的必需 CI 现查（GitHub check-runs，结构化 argv）。preflight（scripts/pm-merge-preflight.ts）与 audit 取数
 * （ledger-audit-merge-ready.ts collectMergeCi）共用：每个必需名字取这个 head 上最新的 run，completed+success 之外都不算绿，读不全就抛。
 */
export type Run = (argv: string[], opts: { cwd?: string; timeoutMs: number }) => Promise<{ code: number | null; stdout: string; stderr: string; timedOut: boolean }>;
export type CheckState = "pass" | "fail" | "cancelled" | "skipped" | "pending" | "missing" | "unknown";

export async function ghJson(run: Run, argv: string[], what: string): Promise<unknown> {
  const r = await run(argv, { timeoutMs: 60_000 });
  if (r.timedOut || r.code !== 0) throw new Error(`${what} 失败：exit ${r.code ?? "timeout"} ${r.stderr.trim().split("\n")[0]?.slice(0, 200) ?? ""}`);
  try { return JSON.parse(r.stdout); } catch { throw new Error(`${what} 输出不是 JSON`); }
}

/** Each required name's newest check run on exactly this head. Anything but completed+success is not green. */
export async function headChecks(run: Run, repo: string, head: string, names: readonly string[]): Promise<Record<string, CheckState>> {
  const raw = await ghJson(run, ["gh", "api", `repos/${repo}/commits/${head}/check-runs?per_page=100`], "gh check-runs") as
    { total_count?: unknown; check_runs?: unknown };
  if (!Array.isArray(raw.check_runs) || typeof raw.total_count !== "number") throw new Error("check-runs 输出无效");
  if (raw.total_count > raw.check_runs.length) throw new Error("check-runs 超过一页，读不全"); // a truncated list never reads as green
  const runs = raw.check_runs as { id?: number; name?: string; head_sha?: string; status?: string; conclusion?: string | null }[];
  const out: Record<string, CheckState> = {};
  for (const name of names) {
    const mine = runs.filter((r) => r.name === name && r.head_sha === head).sort((a, b) => (b.id ?? 0) - (a.id ?? 0));
    const r = mine[0];
    out[name] = !r ? "missing" : r.status !== "completed" ? "pending"
      : r.conclusion === "success" ? "pass"
      : ["failure", "timed_out", "action_required", "startup_failure"].includes(String(r.conclusion)) ? "fail"
      : r.conclusion === "cancelled" ? "cancelled" : r.conclusion === "skipped" ? "skipped" : "unknown";
  }
  return out;
}
