/**
 * T94 合 main 后的租约缺口（T94-r4-merge.md），都用真子进程：
 * - P1：`ledger lend-ask` 在 BEGIN IMMEDIATE 上等别的连接放写锁时，调度服务的 singleton / 维护租约丢了，拿到锁后不写 ask
 * - P2：lend 这一步的本地效果（journal、收据、摘要）每次都先核 active，失租时一条都不写
 */
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { acquireLock, lockOwnedBy } from "../src/lib/file-lock.js";
import { closeLedger, openLedger } from "../src/lib/ledger-store.js";
import { advance, getMeta, getOrder, openLendJournal, recordAsked } from "../src/lib/lend-journal.js";
import { REPO_ROOT } from "../src/lib/repo-root.js";
import { testChildEnv } from "./test-env.js";

const roots: string[] = [];
afterEach(() => { for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true }); });

function box(): { r: string; state: string; env: (extra?: Record<string, string>) => Record<string, string> } {
  const r = mkdtempSync(join(tmpdir(), "t94-lease-"));
  roots.push(r);
  for (const d of ["home", "state", "run"]) mkdirSync(join(r, d));
  const state = join(r, "state");
  return { r, state, env: (extra = {}) => testChildEnv({ HOME: join(r, "home"), CLAUDESTRA_STATE_DIR: state, CLAUDESTRA_RUNTIME_DIR: join(r, "run"), ...extra }) };
}

const spawnIn = (r: string, env: Record<string, string>, script: string) =>
  Bun.spawn(["env", "-i", ...Object.entries(env).map(([k, v]) => `${k}=${v}`), process.execPath, "--no-env-file", "--config=/dev/null", script],
    { cwd: r, stdout: "pipe", stderr: "pipe" });

function managerKid(pid: number): boolean {
  const ps = Bun.spawnSync(["ps", "-A", "-o", "ppid=,pid=,args="]).stdout.toString();
  return ps.split("\n").some((l) => { const m = l.trim().match(/^(\d+)\s+(\d+)\s+(.*)$/); return !!m && Number(m[1]) === pid && m[3].includes("manager.ts"); });
}

const PARAMS = { orderId: "o-lease", peer: "team-a", fp: null, family: "codex", repo: "o/r", pr: 1, head: "a".repeat(40), taskId: "T1", step: "review", quota: "今天 1 单" };

describe("P1：lend-ask 等 SQLite 写锁期间失租", () => {
  for (const stop of ["singleton", "maintenance", "none"] as const) {
    test(`${stop === "none" ? "对照：租约一直在，放锁后照常开一张 ask" : `等锁时丢了 ${stop}：拿到锁后不写，报 lease-lost`}`, async () => {
      const { r, state, env } = box();
      writeFileSync(join(state, "registry.json"), JSON.stringify({ socket: "", agents: {} }));
      const ledger = join(state, "ledger.sqlite");
      openLedger(ledger);
      closeLedger(ledger);
      const sp = join(state, "scheduler.pid"), mp = join(state, "maintenance.lock");
      const a = (await acquireLock(sp, 0))!, b = (await acquireLock(mp, 0))!;
      const lease = { singleton: { path: sp, token: a.token }, maintenance: { path: mp, token: b.token } };
      const script = join(r, "ask-child.ts");
      writeFileSync(script, `import { schedulerManagerWith } from ${JSON.stringify(join(REPO_ROOT, "src/lib/scheduler-service.ts"))};
console.log(JSON.stringify(await schedulerManagerWith(${JSON.stringify(lease)})("ledger", "lend-ask", "--params", ${JSON.stringify(JSON.stringify(PARAMS))})));\n`);
      const gate = openLedger(ledger);
      gate.exec("BEGIN IMMEDIATE"); // 另一个连接占着写锁：子进程核完租约后卡在自己的 BEGIN IMMEDIATE 上
      const kid = spawnIn(r, env(), script);
      for (const end = Date.now() + 8_000; Date.now() < end && !managerKid(kid.pid); await Bun.sleep(20));
      await Bun.sleep(1_200); // manager 起来、过了 runLedger 那次核对，正在等锁（busy_timeout 5s 之内）
      if (stop === "singleton") a.release();
      if (stop === "maintenance") writeFileSync(join(mp, "owner"), "someone-else");
      gate.exec("COMMIT");
      closeLedger(ledger);
      const out = JSON.parse((await new Response(kid.stdout).text()).trim().split("\n").at(-1) || "{}");
      await kid.exited;
      const db = openLedger(ledger);
      const asks = (db.query("SELECT COUNT(*) AS n FROM asks").get() as { n: number }).n;
      closeLedger(ledger);
      if (stop === "none") {
        expect(out).toMatchObject({ ok: true });
        expect(asks).toBe(1);
      } else {
        expect(out).toMatchObject({ ok: false, code: "lease-lost" });
        expect(asks).toBe(0);
      }
      if (lockOwnedBy(sp, a.token)) a.release();
      if (lockOwnedBy(mp, b.token)) b.release();
    }, 20_000);
  }
});

describe("P2：lend 这一步失租时不写本地状态", () => {
  // active 从第 okCalls+1 次起抛 SchedulerStopped：0 = 进来就已失租；1 = 进门核过、走到收尾时丢了
  for (const okCalls of [0, 1]) {
    test(okCalls ? "中途失租：收尾写收据前核到，收据 / settle / 摘要都不动" : "进来就失租：journal 不写、不补收据、不写摘要", async () => {
      const { r, state, env } = box();
      const journal = join(state, "lend", "journal.sqlite");
      mkdirSync(join(state, "lend"), { recursive: true });
      const db = openLendJournal(journal);
      recordAsked(db, { orderId: "o-local", peer: "team-a", fp: null, family: "codex", preview: {} });
      advance(db, "o-local", "asked", "claimed");
      advance(db, "o-local", "claimed", "released", { settle: { notify: null, removeDir: false } });
      db.close();
      writeFileSync(join(state, "lend.json"), JSON.stringify({ version: 1, enabled: false, lend: [], borrow: [] }));
      const script = join(r, "step-child.ts");
      writeFileSync(script, `import { lendStep } from ${JSON.stringify(join(REPO_ROOT, "src/lib/lend-deps.ts"))};
import { LedgerReader } from ${JSON.stringify(join(REPO_ROOT, "src/lib/ledger-read.ts"))};
import { SchedulerStopped } from ${JSON.stringify(join(REPO_ROOT, "src/lib/scheduler-maintenance.ts"))};
let calls = 0;
const active = () => { calls++; if (calls > ${okCalls}) throw new SchedulerStopped("lost"); };
let err = "";
try { await lendStep(new LedgerReader())(active); } catch (e) { err = (e as Error).constructor.name; }
console.log(JSON.stringify({ calls, err }));\n`);
      const kid = spawnIn(r, env(), script);
      const out = JSON.parse((await new Response(kid.stdout).text()).trim().split("\n").at(-1) || "{}");
      await kid.exited;
      expect(out.err).toBe("SchedulerStopped");
      expect(out.calls).toBeGreaterThan(okCalls);
      const after = openLendJournal(journal);
      try {
        expect(getOrder(after, "o-local")!.settle).toEqual({ notify: null, removeDir: false });
        expect(getMeta(after, "status")).toBeNull();
      } finally { after.close(); }
      expect(existsSync(join(state, "lend", "receipts.jsonl"))).toBe(false);
    }, 20_000);
  }
});
