/**
 * `ledger main-carry <task> --old --new --main --spec-rev --round --review-seq --rev --repo-dir`: the formal PM main-carry entry
 * (MAINP2). Only the project's real PM / master / owner; the scheduler identity cannot run it (not a scheduler-service command).
 * The mainCarry recovery policy decides: off refuses, observe returns the plan and proof without writing, on writes one carry.
 * `ledger main-carry-verify <task> --merged-head <sha> --repo-dir`: after the real merge, the recorded chain against local git.
 * Logic: lib/review-main-carry-manual.ts. policyPath only lets tests point at a temporary policy file.
 */
import { LedgerError } from "../lib/ledger-store.js";
import { recoveryPolicy, RECOVERY_POLICY_PATH } from "../lib/recovery-policy.js";
import { runManualCarry, verifyManualCarry, type GitRead, type ProveCarry } from "../lib/review-main-carry-manual.js";
import { runBounded } from "../lib/run-bounded.js";
import type { LedgerCli } from "./ledger-context.js";
import type { CommandSpec } from "./ledger-write-cmds.js";

const int = (c: LedgerCli, flag: string): number => {
  const v = c.need(flag);
  if (!/^\d{1,9}$/.test(v)) throw new LedgerError("invalid", `--${flag} 要是非负整数，收到 ${v}`);
  return Number(v);
};

/** Local git only, no inherited GIT_* overrides, no prompts. */
const localGit = (cwd: string): GitRead => async (args) => {
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("GIT_")));
  const r = await runBounded(["git", ...args], { cwd, env: { ...env, GIT_TERMINAL_PROMPT: "0", GIT_NO_REPLACE_OBJECTS: "1" }, timeoutMs: 30_000 });
  return { code: r.timedOut || r.code === null ? -1 : r.code, stdout: r.stdout };
};

export function mainCarryCmds(opts: { policyPath?: string; prove?: ProveCarry; git?: (cwd: string) => GitRead } = {}): Record<string, CommandSpec> {
  const path = opts.policyPath ?? RECOVERY_POLICY_PATH;
  const policy = (project: string, key: Parameters<typeof recoveryPolicy>[1]) => recoveryPolicy(project, key, path);
  return {
    "main-carry": {
      valued: ["old", "new", "main", "spec-rev", "round", "review-seq", "rev", "repo-dir"],
      usage: "main-carry <task> --old <sha> --new <sha> --main <actual main sha> --spec-rev N --round N --review-seq N --rev N --repo-dir <dir>"
        + "（PM / master / owner；按恢复策略 mainCarry：off 拒、observe 只报计划、on 写一条正式沿用并前移 head）",
      async run(c) {
        const task = c.task(c.p.pos[1]);
        const outcome = await runManualCarry(c.db, { actor: c.deps.actor, now: c.deps.now() }, {
          taskId: task.id, oldHead: c.need("old"), newHead: c.need("new"), mainHead: c.need("main"), specRev: int(c, "spec-rev"),
          round: int(c, "round"), reviewSeq: int(c, "review-seq"), rev: int(c, "rev"),
        }, { repoDir: c.need("repo-dir"), prove: opts.prove, policy });
        return { ok: outcome.status === "carried" || outcome.status === "observe" || outcome.status === "noop", ...outcome,
          ...(outcome.status === "refused" || outcome.status === "off" ? { code: "conflict", error: outcome.reason } : {}) };
      },
    },
    "main-carry-verify": {
      valued: ["merged-head", "repo-dir"],
      usage: "main-carry-verify <task> --merged-head <sha> --repo-dir <dir>（合入后核正式沿用链、合入 head 与本地 origin/main；只读）",
      async run(c) {
        const task = c.task(c.p.pos[1]);
        const r = await verifyManualCarry(c.db, task.id, c.need("merged-head"), (opts.git ?? localGit)(c.need("repo-dir")));
        return { ...r, ...(r.ok ? {} : { code: "conflict", error: r.problems.join("；") }) };
      },
    },
  };
}

export const MAIN_CARRY_CMDS = mainCarryCmds();
