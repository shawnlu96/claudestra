/**
 * `ledger memory-metrics` / `ledger memory-hygiene`：§9 周报与 §4.3 卫生清单的 CLI。两条都是只读命令（write-commands.ts 的 READER_ONLY_SUBS，
 * ledger.ts 给 query_only 连接，不建表、不迁移）；旧库还没有记忆表时按「没有记忆」出空报表。
 * 卫生清单只报告：每周由现有 cron 跑这条命令把清单交给 PM，本命令不写 mark / 事件。
 */
import type { Database } from "bun:sqlite";
import { memoryState } from "./ledger-memory.js";
import { listEvents, listTasks } from "./ledger-store.js";
import { projectMemories } from "./memory-auto-common.js";
import { hygieneReport, hygieneText, type HygieneMemory } from "./memory-hygiene-report.js";
import { lastWeek, memoryMetrics } from "./memory-metrics.js";
import { runBounded } from "./run-bounded.js";
import { readSchedulerConfig } from "./scheduler-config.js";

/** 只用到 LedgerCli 的这几样（lib 不反向 import manager） */
interface MetricsCli {
  db: Database;
  p: { flags: Record<string, string> };
  deps: { now(): number };
  project(): string;
}
type Spec = { valued: string[]; usage: string; run(c: MetricsCli): Promise<Record<string, unknown>> | Record<string, unknown> };

const hasMemoryTables = (db: Database) => !!db.query("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'memories'").get();

function loadMemories(db: Database, project: string): HygieneMemory[] {
  if (!hasMemoryTables(db)) return [];
  return projectMemories(db, project).map((m) => {
    const s = memoryState(db, m.id)!;
    return { id: m.id, kind: m.kind, family: m.family, files: m.files, createdAt: m.createdAt, title: m.title, status: s.status, disputed: s.disputed };
  });
}

function timeFlag(v: string | undefined, name: string): number | undefined {
  if (v === undefined) return undefined;
  const t = Date.parse(v);
  if (!Number.isFinite(t)) throw new Error(`--${name} 要是 ISO 时间`);
  return t;
}

function metricsCmd(c: MetricsCli): Record<string, unknown> {
  const project = c.project();
  const now = c.deps.now();
  const until = timeFlag(c.p.flags.until, "until") ?? now;
  const since = timeFlag(c.p.flags.since, "since") ?? lastWeek(until).since;
  if (since >= until) throw new Error("--since 要早于 --until");
  const launchTs = timeFlag(c.p.flags.launch, "launch") ?? null;
  const report = memoryMetrics({ events: listEvents(c.db, { project }), tasks: listTasks(c.db, project), memories: loadMemories(c.db, project),
    since, until, launchTs });
  return { ok: true, project, ...report };
}

/** HEAD 文件列表：--repo 或调度配置里的 repoDir；拿不到就不判 files_gone */
async function headFiles(dir: string | undefined): Promise<string[] | null> {
  if (!dir) return null;
  const r = await runBounded(["git", "ls-tree", "-r", "--name-only", "-z", "HEAD", "--"], { cwd: dir, timeoutMs: 5000 }).catch(() => null);
  if (!r || r.code !== 0 || r.timedOut || (r.stdout && !r.stdout.endsWith("\0"))) return null;
  return r.stdout.split("\0").filter(Boolean);
}

async function hygieneCmd(c: MetricsCli): Promise<Record<string, unknown>> {
  const project = c.project();
  let repo = c.p.flags.repo;
  try {
    repo ??= readSchedulerConfig().projects[project]?.repoDir;
  } catch {
    // 调度配置读不了（没开调度 / 文件坏）：照常出清单，只是不判「文件全没了」
  }
  const files = await headFiles(repo);
  const rows = hygieneReport({ memories: loadMemories(c.db, project), events: listEvents(c.db, { project }), headFiles: files, now: c.deps.now() });
  return { ok: true, project, rows, text: hygieneText(project, rows, files !== null) };
}

export const MEMORY_METRICS_CMDS: Record<string, Spec> = {
  "memory-metrics": { valued: ["project", "since", "until", "launch"], run: metricsCmd,
    usage: "memory-metrics [--since <ISO>] [--until <ISO>] [--launch <ISO>]（§9 记忆指标，缺省最近一周；门槛由 owner 定、留空）" },
  "memory-hygiene": { valued: ["project", "repo"], run: hygieneCmd,
    usage: "memory-hygiene [--repo <dir>]（每周卫生清单，只报告不写 mark）" },
};
