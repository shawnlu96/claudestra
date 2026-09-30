/**
 * `ledger feature-migrate --map <json> [--dry-run] [--out <md>]`：旧卡迁进 feature（L3）。规划与写入在 lib/ledger-feature-migrate.ts。
 * --dry-run 只读：CLI 给的是只读连接（ledger.ts realDeps），这里再开 query_only 兜底，任何写都会抛；
 * 阶段没到 verified / done 的卡用 gh 查 PR 是否已合并，标「阶段落后」但不改阶段。报告写到 --out（不给就放进输出的 markdown 字段）。
 * 正式迁移要 PM / master / owner，先备份、整批一个事务。
 */
import type { Database } from "bun:sqlite";
import { closeSync, existsSync, lstatSync, openSync, readFileSync, readSync, realpathSync, renameSync, rmSync, statSync, writeFileSync, type Stats } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { applyMigration, parseMap, planMigration, type CardRef, type MigrationPlan } from "../lib/ledger-feature-migrate.js";
import { renderMigrationReport, type LagInfo } from "../lib/ledger-feature-migrate-md.js";
import { LedgerError } from "../lib/ledger-store.js";
import { ghPrArg, realFactsDeps, type FactsDeps } from "../lib/ledger-verify-facts.js";
import { REPO_ROOT } from "../lib/repo-root.js";
import type { LedgerCli, Result } from "./ledger-context.js";
import type { CommandSpec } from "./ledger-write-cmds.js";

/** 同时跑的 gh 数：几十张卡逐个查太慢，并发太高又容易撞 GitHub 限流 */
const GH_CONCURRENCY = 4;

function readMap(path: string) {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch (e) {
    throw new LedgerError("invalid", `读不了映射表 ${path}：${(e as Error).message}`);
  }
  return parseMap(raw);
}

type PrCheck = { merged: true; pr: string; mergedAt: string | null } | { merged: false } | { error: string };

/** 有 pr 字段按 PR 查，没有就按分支找已合并的 PR；两样都没有 = 没东西可查（不算落后） */
async function checkPr(d: FactsDeps, c: CardRef): Promise<PrCheck> {
  const arg = c.pr ? ghPrArg(c.pr) : null;
  if (c.pr && !arg) return { error: `认不出 PR：${c.pr}` };
  const argv = arg ? ["gh", "pr", "view", arg, "--json", "number,state,mergedAt"]
    : c.branch ? ["gh", "pr", "list", "--head", c.branch, "--state", "merged", "--json", "number,state,mergedAt", "--limit", "1"] : null;
  if (!argv) return { merged: false };
  const r = await d.run(argv);
  if (r.code !== 0) return { error: r.stderr.trim().split("\n")[0] || `gh 退出码 ${r.code}` };
  try {
    const o = JSON.parse(r.stdout) as { number?: number; state?: string; mergedAt?: string | null } | { number?: number; state?: string; mergedAt?: string | null }[];
    const pr = Array.isArray(o) ? o[0] : o;
    return pr?.state === "MERGED" ? { merged: true, pr: `#${pr.number}`, mergedAt: pr.mergedAt ?? null } : { merged: false };
  } catch (e) {
    return { error: `gh 输出解析不了：${(e as Error).message}` };
  }
}

async function findLagging(d: FactsDeps, plan: MigrationPlan): Promise<{ lagging: LagInfo[]; prErrors: Record<string, string> }> {
  const cards = [...plan.features.flatMap((f) => [...f.cards.active, ...f.cards.pending, ...f.cards.cancelled]), ...plan.unassigned]
    .filter((c) => c.stage !== "verified" && c.stage !== "done");
  const results: PrCheck[] = new Array(cards.length);
  let next = 0;
  const worker = async () => {
    while (next < cards.length) {
      const i = next++;
      results[i] = await checkPr(d, cards[i]);
    }
  };
  await Promise.all(Array.from({ length: GH_CONCURRENCY }, worker));
  const lagging: LagInfo[] = [];
  const prErrors: Record<string, string> = {};
  cards.forEach((c, i) => {
    const r = results[i];
    if ("error" in r) prErrors[c.id] = r.error;
    else if (r.merged) lagging.push({ id: c.id, stage: c.stage, pr: r.pr, mergedAt: r.mergedAt });
  });
  return { lagging, prErrors };
}

/** 规划期间锁成 query_only：只读连接本来就写不了，测试或别的调用方给的读写连接也保证一行不写 */
function readOnly<T>(db: Database, fn: () => Promise<T>): Promise<T> {
  const was = (db.query("PRAGMA query_only").get() as { query_only: number }).query_only;
  db.exec("PRAGMA query_only = ON");
  return fn().finally(() => db.exec(`PRAGMA query_only = ${was ? "ON" : "OFF"}`));
}

const lstatOrNull = (p: string): Stats | null => {
  try {
    return lstatSync(p);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw e;
  }
};

function isSqlite(p: string): boolean {
  const fd = openSync(p, "r");
  try {
    const head = Buffer.alloc(16);
    return readSync(fd, head, 0, 16, 0) === 16 && head.toString("latin1") === "SQLite format 3\0";
  } finally {
    closeSync(fd);
  }
}

/**
 * dry-run 报告落盘：目标（按真实目录解析，软链目录也算）不能是台账库或它的 -wal / -shm / -journal，已有文件必须是普通文件、
 * 不是库的硬链、也不是 SQLite 库（备份等）。写法是同目录临时文件再 rename：rename 只换目录项，检查之后目标被换成软链或硬链也写不进库。
 * 少了这道闸，`--out ledger.sqlite` 会把库整个覆写成 markdown（tests/ledger-feature-l3.test.ts「--out 落到库」）。
 */
function writeReport(out: string, dbPath: string, md: string): void {
  const refuse = (why: string): never => {
    throw new LedgerError("invalid", `--out ${out} ${why}，报告没写`);
  };
  let target: string;
  try {
    target = join(realpathSync(dirname(resolve(out))), basename(out));
  } catch (e) {
    return refuse(`所在目录读不了（${(e as Error).message}）`);
  }
  const dbReal = dbPath && dbPath !== ":memory:" && existsSync(dbPath) ? realpathSync(dbPath) : null;
  const guarded = dbReal ? ["", "-wal", "-shm", "-journal"].map((s) => dbReal + s) : [];
  if (guarded.includes(target)) refuse("是台账库或它的 -wal / -shm / -journal");
  const st = lstatOrNull(target);
  if (st) {
    if (!st.isFile()) refuse("已存在且不是普通文件（软链、目录等）");
    if (guarded.some((g) => existsSync(g) && statSync(g).ino === st.ino && statSync(g).dev === st.dev)) refuse("是台账库或旁路文件的硬链");
    if (isSqlite(target)) refuse("已存在且是 SQLite 库");
  }
  const tmp = `${target}.${process.pid}.${Date.now()}.tmp`;
  try {
    writeFileSync(tmp, md, { flag: "wx" });
    renameSync(tmp, target);
  } finally {
    if (existsSync(tmp)) rmSync(tmp);
  }
}

const summary = (plan: MigrationPlan) => ({
  writes: plan.writes,
  features: plan.features.map((f) => ({ id: f.id, exists: f.exists, nodes: f.nodes?.length ?? 0, assign: f.toAssign.length, dag: f.dagNote })),
  unassigned: plan.unassigned.map((c) => c.id),
  unsure: plan.unsure.map((u) => u.id),
  missing: plan.missing,
  conflicts: plan.conflicts,
});

async function dryRun(c: LedgerCli, path: string): Promise<Result> {
  const map = readMap(path);
  if (!c.deps.projectIds.includes(map.project)) throw new LedgerError("not_found", `projects.json 里没有项目 ${map.project}`);
  return readOnly(c.db, async () => {
    const plan = planMigration(c.db, map);
    const { lagging, prErrors } = await findLagging(c.deps.factsDeps?.() ?? realFactsDeps(REPO_ROOT), plan);
    const md = renderMigrationReport({ plan, lagging, prErrors, generatedAt: new Date(c.deps.now()).toISOString(), source: c.db.filename });
    const out = c.p.flags.out;
    if (out) writeReport(out, c.db.filename, md);
    return { ok: true, dryRun: true, ...summary(plan), lagging: lagging.map((l) => l.id), prErrors, ...(out ? { report: out } : { markdown: md }) };
  });
}

async function featureMigrate(c: LedgerCli): Promise<Result> {
  const path = c.need("map");
  if (c.p.bools.has("dry-run")) return dryRun(c, path);
  const map = readMap(path);
  c.requireManager(map.project, "feature 迁移");
  const r = applyMigration(c.db, { actor: c.deps.actor, now: c.deps.now() }, map);
  return { ok: true, backup: r.backup, created: r.created, versions: r.versions, assigned: r.assigned, ...summary(r.plan) };
}

export const FEATURE_MIGRATE_CMDS: Record<string, CommandSpec> = {
  "feature-migrate": {
    valued: ["map", "out"],
    bools: ["dry-run"],
    usage: "feature-migrate --map <映射表.json> [--dry-run [--out <报告.md>]]（旧卡迁进 feature；正式迁移先备份、只能 PM / master / owner）",
    run: featureMigrate,
  },
};
