/**
 * lend-pr-takeover.ts 的生产接线：借入方 A 用自己的 git / gh 登录查出借分支、比对、找 / 开 PR。结构化 argv、不经 shell，
 * 不许交互、不带调度身份（ghEnv），每次 ≤ 60 秒。command 由调度 pass 传入（已套 active 守卫：失租 / 停止在 spawn 前后抛出）。
 * 出错一律变成 { ok: false }，不抛（SchedulerStopped 除外），一单出错不挡别的单。tests/lend-pr-takeover.test.ts 用假的 TakeoverGh。
 */
import { remoteHeadAt } from "./lend-git.js";
import { ghEnv, type Command } from "./peer-pr-github.js";
import type { GhAnswer, TakeoverGh } from "./lend-pr-takeover.js";
import type { BoundedResult } from "./run-bounded.js";

const TIMEOUT_MS = 60_000;
const SHA40 = /^[0-9a-f]{40}$/;
const why = (r: BoundedResult): string => (r.timedOut ? "超时" : (r.stderr || r.stdout).trim().split("\n").slice(-2).join(" ").slice(0, 300));

export function takeoverGh(command: Command, env: Record<string, string | undefined> = process.env): TakeoverGh {
  const gh = (args: string[]) => command(["gh", ...args], { env: ghEnv(env), timeoutMs: TIMEOUT_MS });
  const runner = (argv: string[], o: { cwd?: string; env: Record<string, string>; timeoutMs: number }) => command(argv, o);
  return {
    head: (repo, branch) => remoteHeadAt(repo, branch, runner, ghEnv(env)),
    async compare(repo, base, head): Promise<GhAnswer<string>> {
      if (!SHA40.test(base) || !SHA40.test(head)) return { ok: false, error: "比对只收完整 40 位 SHA" };
      const r = await gh(["api", `repos/${repo}/compare/${base}...${head}`, "--jq", ".status"]);
      const status = r.stdout.trim();
      return r.code === 0 && /^(ahead|behind|identical|diverged)$/.test(status) ? { ok: true, value: status } : { ok: false, error: why(r) };
    },
    async openPr(repo, branch): Promise<GhAnswer<number | null>> {
      const r = await gh(["pr", "list", "--repo", repo, "--head", branch, "--state", "open", "--json", "number", "--jq", ".[0].number // empty"]);
      if (r.code !== 0) return { ok: false, error: why(r) };
      const out = r.stdout.trim();
      const n = Number(out);
      return out === "" ? { ok: true, value: null } : Number.isInteger(n) && n > 0 ? { ok: true, value: n } : { ok: false, error: `gh pr list 输出看不懂：${out.slice(0, 80)}` };
    },
    async createPr(p): Promise<GhAnswer<number>> {
      const r = await gh(["pr", "create", "--repo", p.repo, "--base", p.base, "--head", p.branch, "--title", p.title, "--body", p.body]);
      const n = Number(r.stdout.match(/\/pull\/(\d+)\s*$/m)?.[1]);
      return r.code === 0 && Number.isInteger(n) && n > 0 ? { ok: true, value: n } : { ok: false, error: why(r) };
    },
  };
}
