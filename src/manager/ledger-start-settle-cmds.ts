/**
 * `ledger start-settle <卡> --attempt <id> --reason <原因>`（i28-IMP1）：开卡中途失败的手动结清。核实与写事件在 lib/dag-start-settle.ts，
 * 这里只解析参数、接本机的 registry / worktree 目录 / git。
 */
import { existsSync } from "node:fs";
import { settleDagStart, type StartSettleEnv } from "../lib/dag-start-settle.js";
import { LedgerError } from "../lib/ledger-store.js";
import { statePath } from "../lib/paths.js";
import { readRegistryAgents } from "../lib/registry.js";
import type { LedgerCli, Result } from "./ledger-context.js";
import type { CommandSpec } from "./ledger-write-cmds.js";

async function gitWorktrees(dir: string): Promise<string[] | null> {
  if (!existsSync(dir)) return null;
  try {
    const p = Bun.spawn(["git", "-C", dir, "worktree", "list", "--porcelain"], { stdout: "pipe", stderr: "ignore" });
    const [out, code] = await Promise.all([new Response(p.stdout).text(), p.exited]);
    if (code !== 0) return null;
    return out.split("\n").filter((l) => l.startsWith("worktree ")).map((l) => l.slice("worktree ".length));
  } catch { return null; }
}

function startSettleEnv(c: LedgerCli): StartSettleEnv {
  return {
    worktreeRoot: statePath("worktrees"),
    agents: () => readRegistryAgents(),
    exists: existsSync,
    projectDirs: (project) => c.deps.projects?.().find((p) => p.id === project)?.dirs ?? [],
    worktrees: gitWorktrees,
  };
}

async function startSettle(c: LedgerCli): Promise<Result> {
  const taskId = c.p.pos[1];
  if (!taskId) throw new LedgerError("invalid", "start-settle <卡号> --attempt <attemptId> --reason <原因>");
  const r = await settleDagStart(c.db, c.ctx(), startSettleEnv(c), { taskId, attempt: c.need("attempt"), reason: c.need("reason") });
  return { ok: true, duplicate: r.duplicate, event: r.event.seq, dedupKey: r.event.dedupKey, checks: r.checks ?? r.event.data.checks ?? null };
}

export const START_SETTLE_CMDS: Record<string, CommandSpec> = {
  "start-settle": {
    valued: ["attempt", "reason"],
    usage: "start-settle <卡号> --attempt <attemptId> --reason <原因>（开卡中途失败的结清：核实卡已回滚、会话已停、worktree 已删后写 dag-start:<卡>:<attempt>:settled）",
    run: startSettle,
  },
};
