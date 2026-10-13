/**
 * SNAPSQL1 验收线 5 的分阶段 bench（PM 补 10-14 06:3x）：在台账副本上测四个变体的每卡快照耗时，只出表，不进断言。
 *
 *   bun tests/scheduler-snapshot-sql-bench.test.ts <ledger.sqlite>
 *
 * - 只读打开给定台账，VACUUM INTO 到临时目录；之后每个变体再各拷一份进自己的临时状态目录，活库不再碰。不联网。
 * - 四个变体由本仓 git 对象拼出（在 PR head 上跑）：main = BASE；+starts / +claims 在 BASE 上换入 HEAD 的对应文件；
 *   +索引 = HEAD 整棵 src（含 v25 迁移）。每个变体单独起一个子进程，用它自己的 openLedger 打开副本，所以最后一行的
 *   「打开台账」就是 pre-v25 备份 + v24→25 迁移的耗时，前三行是 v24 库上的空操作打开。
 * - 每张卡跑 1 次首轮 + REPS 次热跑取中位数；卡 = 未结束的卡（按 updatedAt 取最近 MAX_CARDS 张），没有就取最近的。
 * bun test 下只登记一条 skip。
 */
import { Database } from "bun:sqlite";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

const BASE = "e145d9a12152ee2c02ad22f31425bba010d8fba4"; // 本卡的 main 基线（第 2 轮合入的 origin/main）
const REPS = 5, MAX_CARDS = 12;
const STARTS = ["src/lib/scheduler-agent-pool-ledger.ts", "src/lib/ledger-autostart-grant.ts"];
const CLAIMS = [...STARTS, "src/lib/scheduler-slot-hold-facts.ts"];
const VARIANTS = [
  { label: "现状（main）", rev: BASE, overlay: [] as string[] },
  { label: "只改 workingSeats 的 starts 查询", rev: BASE, overlay: STARTS },
  { label: "再改 claims 查询", rev: BASE, overlay: CLAIMS },
  { label: "再加 lend_orders 索引（v25 迁移）", rev: "HEAD", overlay: [] },
];
const REPO = dirname(import.meta.dir);

function sh(cmd: string[], cwd = REPO): Buffer {
  const r = Bun.spawnSync(cmd, { cwd, stdout: "pipe", stderr: "pipe" });
  if (r.exitCode !== 0) throw new Error(`${cmd.join(" ")}: ${r.stderr.toString()}`);
  return r.stdout;
}

/** 变体源码树：rev 的 src 整棵导出，再用 HEAD 的 overlay 文件覆盖；node_modules 用仓库的 */
function buildTree(dir: string, rev: string, overlay: readonly string[]): void {
  mkdirSync(dir, { recursive: true });
  const tar = join(dir, "src.tar");
  sh(["git", "archive", "-o", tar, rev, "src", "package.json", "tsconfig.json"]);
  sh(["tar", "-xf", tar, "-C", dir]);
  for (const f of overlay) writeFileSync(join(dir, f), sh(["git", "show", `HEAD:${f}`]));
  writeFileSync(join(dir, "bench-child.ts"), CHILD_SRC);
  symlinkSync(join(REPO, "node_modules"), join(dir, "node_modules"));
}

/**
 * 子进程脚本：写进每个变体树根目录再跑，import 是相对变体树的字面量（本文件自己不做动态加载，CI 选测图里它没有非字面量依赖）。
 * 在 CLAUDESTRA_STATE_DIR 里的副本上，用变体自己的代码打开并测快照；REPS / MAX_CARDS 走 argv。
 */
const CHILD_SRC = `import { getTask, LEDGER_SCHEMA_VERSION, openLedger } from "./src/lib/ledger-store.ts";
import { autoSnapshot } from "./src/lib/scheduler-auto-snapshot.ts";
import { existsSync, statSync } from "node:fs";
import { join } from "node:path";
const [REPS, MAX_CARDS] = process.argv.slice(2).map(Number);
const state = process.env.CLAUDESTRA_STATE_DIR;
const t0 = performance.now();
const db = openLedger(join(state, "ledger.sqlite"));
const openMs = performance.now() - t0;
const q = (sql, ...a) => db.query(sql).all(...a);
const pick = (where) => q("SELECT t.id FROM tasks t JOIN task_workflows w ON w.taskId = t.id " + where +
  " ORDER BY t.updatedAt DESC LIMIT ?", MAX_CARDS).map((r) => r.id);
const live = pick("WHERE t.stage NOT IN ('verified','cancelled','merged','done')");
const ids = live.length ? live : pick("");
const opts = { registry: [], maxWorkers: 6, now: Date.now(), pool: { remote: { agents: { claude: 3, codex: 3 } }, borrow: [] } };
const first = [], warm = [];
for (const id of ids) {
  const task = getTask(db, id);
  const t = [];
  for (let i = 0; i <= REPS; i++) { const s = performance.now(); autoSnapshot(db, task, opts); t.push(performance.now() - s); }
  first.push(t[0]);
  warm.push(t.slice(1).sort((a, b) => a - b)[REPS >> 1]);
}
const mean = (xs) => xs.reduce((a, b) => a + b, 0) / Math.max(xs.length, 1);
const bak = join(state, "backups", "ledger.sqlite.pre-v" + LEDGER_SCHEMA_VERSION + ".bak");
console.log(JSON.stringify({ openMs, version: q("PRAGMA user_version")[0].user_version, cards: ids.length, live: live.length,
  index: q("SELECT 1 FROM sqlite_master WHERE type = 'index' AND name = 'lend_orders_task'").length > 0,
  backupBytes: existsSync(bak) ? statSync(bak).size : null, first: mean(first), warm: mean(warm) }));
`;

async function main(ledger: string): Promise<void> {
  if (!existsSync(ledger)) throw new Error(`台账不存在：${ledger}`);
  sh(["git", "cat-file", "-e", `${BASE}^{commit}`]);
  const work = mkdtempSync(join(tmpdir(), "snapsql-bench-"));
  const copy = join(work, "ledger.sqlite");
  const t0 = performance.now();
  const live = new Database(ledger, { readonly: true });
  live.run(`VACUUM INTO '${copy.replaceAll("'", "''")}'`);
  live.close();
  const vacuumMs = performance.now() - t0;
  const db = new Database(copy);
  const ver = (db.query("PRAGMA user_version").get() as { user_version: number }).user_version;
  if (ver === 25) { db.run("DROP INDEX IF EXISTS lend_orders_task"); db.run("PRAGMA user_version = 24"); } // 已上线 v25：退回改前形态
  else if (ver !== 24) throw new Error(`台账版本 ${ver}，本 bench 只认 24 / 25`);
  const n = (sql: string) => (db.query(sql).get() as { n: number }).n;
  const stats = { events: n("SELECT count(*) n FROM events"), tasks: n("SELECT count(*) n FROM tasks"),
    lendOrders: n("SELECT count(*) n FROM lend_orders"), mb: (statSync(copy).size / 1048576).toFixed(1) };
  db.close();
  const rows: string[] = [];
  for (const [i, v] of VARIANTS.entries()) {
    const root = join(work, `v${i}`), state = join(work, `state${i}`);
    buildTree(root, v.rev, v.overlay);
    mkdirSync(state);
    copyFileSync(copy, join(state, "ledger.sqlite"));
    const env = { ...process.env, CLAUDESTRA_STATE_DIR: state, CLAUDESTRA_TEST: undefined, NODE_ENV: undefined };
    const out = Bun.spawnSync([process.execPath, "--no-env-file", join(root, "bench-child.ts"), String(REPS), String(MAX_CARDS)], { cwd: root, env, stdout: "pipe", stderr: "pipe" });
    if (out.exitCode !== 0) throw new Error(`${v.label}: ${out.stderr.toString()}`);
    const r = JSON.parse(out.stdout.toString().trim().split("\n").at(-1)!);
    const bak = r.backupBytes === null ? "无备份" : `备份 ${(r.backupBytes / 1048576).toFixed(1)} MB`;
    rows.push(`| ${v.label} | ${r.first.toFixed(1)} ms | ${r.warm.toFixed(1)} ms | ${r.openMs.toFixed(0)} ms（v${r.version}，${bak}，索引${r.index ? "在" : "无"}） |`);
    if (i === 0) rows.unshift(`卡数 ${r.cards}（未结束 ${r.live}），每卡首轮 1 次 + 热跑 ${REPS} 次取中位数，各卡求平均`, "",
      "| 改动 | 每张卡（首轮） | 每张卡（热，中位数） | 打开台账（备份 + 迁移） |", "|---|---|---|---|");
  }
  console.log(`台账 ${ledger}：${stats.mb} MB，events ${stats.events}，tasks ${stats.tasks}，lend_orders ${stats.lendOrders}；` +
    `VACUUM INTO 副本 ${vacuumMs.toFixed(0)} ms\n${rows.join("\n")}`);
  rmSync(work, { recursive: true, force: true });
}

// bun test 里 import.meta.main 也是 true，按 bun test / preload 设的标记认（子进程两样都清掉了）
if (process.env.NODE_ENV !== "test" && process.env.CLAUDESTRA_TEST !== "1") {
  const [a] = process.argv.slice(2);
  if (a) await main(a);
  else { console.error("用法：bun tests/scheduler-snapshot-sql-bench.test.ts <ledger.sqlite>"); process.exit(2); }
} else {
  const { test } = await import("bun:test");
  test.skip("SNAPSQL1 bench：手动跑，见文件头", () => {});
}
