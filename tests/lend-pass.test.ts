/**
 * T94 服务入口两开关（src/scheduler.ts、lib/scheduler-pass.ts）：scheduler.json 或 lend.json 任一开着就跑 pass，lend 这一步只看 lend.json，
 * 与合并 / 观察 / 自动派单共用维护租约；update 持租约时整轮跳过，停止 / 失租时 lend 这一步也停。
 */
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { acquireLock } from "../src/lib/file-lock.js";
import { getMeta, openLendJournal } from "../src/lib/lend-journal.js";
import { REPO_ROOT } from "../src/lib/repo-root.js";
import { SchedulerStopped } from "../src/lib/scheduler-maintenance.js";
import { schedulerPass } from "../src/lib/scheduler-pass.js";

const roots: string[] = [];
const kids: ReturnType<typeof Bun.spawn>[] = [];
afterEach(async () => {
  for (const k of kids.splice(0)) { k.kill("SIGKILL"); await k.exited; }
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
});
function root(): string {
  const r = mkdtempSync(join(tmpdir(), "t94-pass-"));
  roots.push(r);
  return r;
}
const OFF = { enabled: false, pollMs: 1000, autoDispatch: false, projects: {} };

describe("T94 pass 的 lend 这一步", () => {
  test("两个开关都关：不跑、不拿租约", async () => {
    const r = root();
    expect(await schedulerPass(null, OFF, { assertOwner: () => {}, maintenance: { path: join(r, "m.lock"), marker: join(r, "u") } })).toEqual({ ran: false, failed: [] });
    expect(existsSync(join(r, "m.lock"))).toBe(false);
  });

  test("只开出借：不碰台账（db 为空也行），只跑 lend；某张单失败汇总进 failed", async () => {
    const r = root();
    let ran = 0;
    const out = await schedulerPass(null, OFF, { assertOwner: () => {}, maintenance: { path: join(r, "m.lock"), marker: join(r, "u") },
      lend: async () => { ran++; return { failed: [{ orderId: "o1", error: "坏了" }] }; } });
    expect(ran).toBe(1);
    expect(out).toEqual({ ran: true, failed: [{ taskId: "lend o1", error: "坏了" }] });
  });

  test("lend 这一步拿到服务的两份租约（它起的 ledger / manager 子进程带着它们，没有就一律被拒）", async () => {
    const r = root();
    let got: unknown;
    const singleton = { path: join(r, "scheduler.pid"), token: "tok-s" };
    await schedulerPass(null, OFF, { assertOwner: () => {}, singleton, maintenance: { path: join(r, "m.lock"), marker: join(r, "u") },
      lend: async (_a, lease) => { got = lease; return { failed: [] }; } });
    expect(got).toMatchObject({ singleton, maintenance: { path: join(r, "m.lock") } });
    expect((got as { maintenance: { token: string } }).maintenance.token).toBeTruthy();
  });

  test("update 持着维护租约：整轮跳过，lend 也不跑", async () => {
    const r = root();
    const update = await acquireLock(join(r, "m.lock"), 0);
    let ran = 0;
    const out = await schedulerPass(null, OFF, { assertOwner: () => {}, maintenance: { path: join(r, "m.lock"), marker: join(r, "u") },
      lend: async () => { ran++; return { failed: [] }; } });
    update!.release();
    expect(out.ran).toBe(false);
    expect(ran).toBe(0);
  });

  test("服务停止：lend 拿到的 active() 抛 SchedulerStopped，并且原样抛出 pass", async () => {
    const r = root();
    let stopped = false;
    const pass = schedulerPass(null, OFF, { assertOwner: () => { if (stopped) throw new SchedulerStopped("stop"); },
      maintenance: { path: join(r, "m.lock"), marker: join(r, "u") },
      lend: async (active) => { stopped = true; active(); return { failed: [] }; } });
    await expect(pass).rejects.toBeInstanceOf(SchedulerStopped);
  });
});

describe("T94 真服务：没有 scheduler.json、只开了 lend.json 也跑 pass", () => {
  test("服务跑出借这一步并在 journal 记下本轮摘要（这里没有联系人，所以记「不 poll」的原因）", async () => {
    const r = root();
    const state = join(r, "state");
    for (const d of [state, join(r, "home"), join(r, "run"), join(r, "tmp")]) mkdirSync(d, { recursive: true });
    writeFileSync(join(state, "lend.json"), JSON.stringify({ version: 1, enabled: true, borrow: [], lend: [{ peer: "team-a", families: { codex: 1 },
      roles: ["review"], repos: ["o/r"], quota: { ordersPerDay: 1, tokensPerDay: null }, confirm: "per-order" }] }));
    const env: Record<string, string> = { HOME: join(r, "home"), PATH: process.env.PATH ?? "", TMPDIR: join(r, "tmp"), CLAUDESTRA_SANDBOX: "1",
      CLAUDESTRA_SANDBOX_ROOT: r, CLAUDESTRA_STATE_DIR: state, CLAUDESTRA_RUNTIME_DIR: join(r, "run"), BRIDGE_PORT: "1", BRIDGE_BIND: "127.0.0.1" };
    const child = Bun.spawn(["env", "-i", ...Object.entries(env).map(([k, v]) => `${k}=${v}`), process.execPath, "--no-env-file", join(REPO_ROOT, "src/scheduler.ts")],
      { cwd: r, stdout: "ignore", stderr: "pipe" });
    kids.push(child);
    const journal = join(state, "lend", "journal.sqlite");
    let status: string | null = null;
    for (const end = Date.now() + 15_000; Date.now() < end && !status; await Bun.sleep(200)) {
      if (!existsSync(journal)) continue;
      const db = openLendJournal(journal);
      try { status = getMeta(db, "status"); } finally { db.close(); }
    }
    expect(status).not.toBeNull();
    expect(JSON.parse(status!)).toMatchObject({ lending: false, blocked: "没有生效的出借条目" });
    expect(existsSync(join(state, "scheduler.json"))).toBe(false);
  }, 30_000);
});

describe("T94 lend off 之后的收尾（r2 P2）", () => {
  test("出借关了、journal 里只剩终态但收尾没做完：服务入口仍要跑 lend 这一步；收尾做完、也没活着的单才不跑", async () => {
    const { lendWanted } = await import("../src/lib/lend-deps.js");
    const { advance, patchOrder, recordAsked } = await import("../src/lib/lend-journal.js");
    const dir = mkdtempSync(join(tmpdir(), "lend-wanted-"));
    roots.push(dir);
    const journal = join(dir, "journal.sqlite");
    const lend = join(dir, "lend.json");
    writeFileSync(lend, JSON.stringify({ version: 1, enabled: false, lend: [], borrow: [] }));
    const db = openLendJournal(journal);
    recordAsked(db, { orderId: "o1", peer: "team-a", fp: null, family: "codex", preview: {} });
    advance(db, "o1", "asked", "claimed");
    advance(db, "o1", "claimed", "released", { reason: "clone 失败", settle: { notify: null, removeDir: false } }); // 收据还没写成
    expect(await lendWanted(journal, lend)).toBe(true);
    patchOrder(db, "o1", ["released"], { settle: null });
    db.close();
    expect(await lendWanted(journal, lend)).toBe(false);
  });
});
