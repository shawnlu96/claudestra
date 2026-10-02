/**
 * `ledger start-settle <卡> --attempt <id> --reason <原因>`（i28-IMP1）：开卡中途失败的手动结清。核实与写事件在 lib/dag-start-settle.ts，
 * 这里只解析参数、接本机的 registry / worktree 目录 / git。
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import { parseRegistryForSettle, settleDagStart, type StartSettleEnv } from "../lib/dag-start-settle.js";
import { LedgerError } from "../lib/ledger-store.js";
import { statePath } from "../lib/paths.js";
import { REGISTRY_PATH } from "../lib/registry.js";
import { readJsonStateSync } from "../lib/state-file.js";
import type { LedgerCli, Result } from "./ledger-context.js";
import type { CommandSpec } from "./ledger-write-cmds.js";

/** 目录不在 → null（核实不了）；git 失败时只有「目录在、没有 .git」才算不是仓库，其余一律 null */
async function gitWorktrees(dir: string): Promise<string[] | "not-git" | null> {
  if (!existsSync(dir)) return null;
  try {
    const p = Bun.spawn(["git", "-C", dir, "worktree", "list", "--porcelain"], { stdout: "pipe", stderr: "ignore" });
    const [out, code] = await Promise.all([new Response(p.stdout).text(), p.exited]);
    if (code === 0) return out.split("\n").filter((l) => l.startsWith("worktree ")).map((l) => l.slice("worktree ".length));
  } catch { /* 下面按 .git 判 */ }
  return existsSync(join(dir, ".git")) ? null : "not-git";
}

/** 严格读 registry：不在 = 没有会话；读失败 / 坏 JSON / 结构不对都抛（通用读者会降级成空表或旧缓存，不能拿来当证明） */
async function registryAgents(path: string): Promise<{ name: string; status?: string; cwd?: string }[]> {
  const r = readJsonStateSync(path);
  if (r.status === "missing") return [];
  if (r.status !== "ok") throw new LedgerError("conflict", `registry.json 读不出来：${r.error}`);
  return parseRegistryForSettle(r.data);
}

function startSettleEnv(c: LedgerCli): StartSettleEnv {
  return {
    worktreeRoot: statePath("worktrees"),
    agents: () => registryAgents(c.deps.registryPath ?? REGISTRY_PATH),
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
