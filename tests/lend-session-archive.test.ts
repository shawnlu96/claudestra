/** 出借 worker 结单后归档它的 Codex 会话（src/lib/lend-session-archive.ts）：结单触发、每日补漏、不碰 owner 的 agent。全在临时目录里造假会话与 journal */
import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { archiveEndedWorker, sweepEndedLendThreads } from "../src/lib/lend-session-archive";
import { advance, getOrder, openLendJournal, recordAsked } from "../src/lib/lend-journal";
import { workerName } from "../src/lib/lend-worker-name";
import type { RegistryAgent } from "../src/lib/registry";
import { harness, sha, toStarted } from "./lend-harness.js";

const base = mkdtempSync(join(tmpdir(), "lend-session-archive-"));
afterAll(() => rmSync(base, { recursive: true, force: true }));
const id = (n: number) => `019b0000-0000-7000-8000-${String(n).padStart(12, "0")}`;
const W1 = workerName("o1");
const W2 = workerName("o2");
const OWNER = "agent-套利研究所";

function world() {
  const root = mkdtempSync(join(base, "w-"));
  const day = join(root, ".codex", "sessions", "2026", "10", "01");
  mkdirSync(day, { recursive: true });
  const locksDir = join(root, ".codex", "thread-writer-locks");
  mkdirSync(locksDir, { recursive: true });
  const opts = { codexRoot: join(root, ".codex", "sessions"), locksDir, archiveRoot: join(root, "archived"), restoredIndex: join(root, "restored.json") };
  const write = (n: number, payload: object) => {
    const p = join(day, `rollout-2026-10-01T00-00-00-${id(n)}.jsonl`);
    writeFileSync(p, JSON.stringify({ type: "session_meta", payload: { cwd: "/w", id: id(n), ...payload } }) + "\n");
    return p;
  };
  const main = (n: number) => write(n, { session_id: id(n) });
  const sub = (n: number, parent: number, root = parent) => write(n, { session_id: id(root), parent_thread_id: id(parent), thread_source: "subagent" });
  return { root, opts, main, sub };
}

const row = (o: Partial<{ family: string; agent: string | null; sessionId: string | null }> = {}) =>
  ({ orderId: "o1", family: "codex", agent: W1, sessionId: id(1), ...o });

describe("archiveEndedWorker：结单触发只走 B 终态退休端口", () => {
  const exact = () => ({ ...row(), leaseGen: 1, state: "acked" as const });

  test("结单不再搬 Codex 会话原件（canonical 归档要读源；没收的由每日补漏收）", async () => {
    const w = world();
    const files = [w.main(1), w.sub(2, 1), w.sub(3, 2, 1)];
    for (const mode of ["off", "observe", "on"] as const) {
      await archiveEndedWorker(exact(), () => {}, async () => ({ ok: true, archived: true, entries: [{ reason: null }] }), mode).catch(() => {});
    }
    await archiveEndedWorker(exact(), () => {});
    for (const p of files) expect(existsSync(p)).toBe(true);
  });

  test("缺省 observe：只跑 dry-run 记日志，拒绝 / 失败都不挡结单", async () => {
    const calls: string[][] = [];
    const lines: string[] = [];
    await archiveEndedWorker(exact(), (m) => lines.push(m), async (...args) => { calls.push(args); return { ok: true, entries: [{ reason: "worker 未完成退役" }] }; });
    await archiveEndedWorker(exact(), (m) => lines.push(m), async () => { throw new Error("manager 起不来"); });
    expect(calls).toEqual([["archive-workflows", "--lend-worker", "dry-run", JSON.stringify({ orderId: "o1", agent: W1, sessionId: id(1), leaseGen: 1 })]]);
    expect(lines[0]).toContain("observe，未执行");
    expect(lines[0]).toContain("worker 未完成退役");
    expect(lines[1]).toContain("不影响结单");
  });

  test("off 与非终态（stopped / unknown 等）一次都不调", async () => {
    let calls = 0;
    const m = async () => { calls++; return {}; };
    await archiveEndedWorker(exact(), () => {}, m, "off");
    for (const state of ["stopped", "started", "result_pending"] as const) await archiveEndedWorker({ ...exact(), state }, () => {}, m, "on");
    expect(calls).toBe(0);
  });
});

describe("sweepEndedLendThreads：每日补漏", () => {
  function journal(root: string) {
    const path = join(root, "journal.sqlite");
    const db = openLendJournal(path);
    for (const [o, sid, to] of [["o1", id(1), "stopped"], ["o2", id(5), "started"]] as const) {
      recordAsked(db, { orderId: o, peer: "team-a", fp: null, family: "codex", preview: {} });
      advance(db, o, "asked", "claimed");
      advance(db, o, "claimed", "cloned", { agent: workerName(o) });
      advance(db, o, "cloned", "started", { sessionId: sid });
      if (to !== "started") advance(db, o, "started", to);
    }
    db.close();
    return path;
  }
  const agents = (w1Status = "stopped"): RegistryAgent[] => [
    { name: W1, status: w1Status, sessionId: id(1) }, { name: W2, status: "active", sessionId: id(5) }, { name: OWNER, status: "stopped", sessionId: id(10) },
  ];

  test("只收已结单的出借 worker；在跑的单、owner 的 agent 不碰；收过的不重复处理", async () => {
    const w = world();
    const ended = [w.main(1), w.sub(2, 1)];
    const kept = [w.main(5), w.sub(6, 5), w.main(10), w.sub(11, 10)];
    const journalPath = journal(w.root);
    expect(await sweepEndedLendThreads(agents(), { ...w.opts, journalPath })).toBe(2);
    for (const p of ended) expect(existsSync(p)).toBe(false);
    for (const p of kept) expect(existsSync(p)).toBe(true);
    expect(await sweepEndedLendThreads(agents(), { ...w.opts, journalPath })).toBe(0);
  });

  test("单已结束但 registry 里这个 worker 还 active：不收", async () => {
    const w = world();
    const files = [w.main(1), w.sub(2, 1)];
    expect(await sweepEndedLendThreads(agents("active"), { ...w.opts, journalPath: journal(w.root) })).toBe(0);
    for (const p of files) expect(existsSync(p)).toBe(true);
  });

  test("原结单触发的保护迁到补漏：收主线程、子线程和孙线程，别人的不动，meta 记来由；Codex 进程锁着的不收，恢复清单坏了不抛", async () => {
    const w = world();
    const mine = [w.main(1), w.sub(2, 1), w.sub(3, 2, 1)];
    const others = [w.main(10), w.sub(11, 10), w.main(20), w.sub(21, 20)];
    const journalPath = journal(w.root);
    writeFileSync(join(w.opts.locksDir, `${id(1)}.lock`), "");
    expect(await sweepEndedLendThreads(agents(), { ...w.opts, journalPath })).toBe(0);
    for (const p of mine) expect(existsSync(p)).toBe(true); // 主线程被锁 = 子线程的父也算锁着
    rmSync(join(w.opts.locksDir, `${id(1)}.lock`));
    writeFileSync(w.opts.restoredIndex, "{坏");
    expect(await sweepEndedLendThreads(agents(), { ...w.opts, journalPath })).toBe(0);
    for (const p of mine) expect(existsSync(p)).toBe(true);
    rmSync(w.opts.restoredIndex);
    expect(await sweepEndedLendThreads(agents(), { ...w.opts, journalPath })).toBe(3);
    for (const p of mine) expect(existsSync(p)).toBe(false);
    for (const p of others) expect(existsSync(p)).toBe(true);
    const meta = JSON.parse(readFileSync(join(w.opts.archiveRoot, id(2), ".meta.json"), "utf8"));
    expect(meta).toMatchObject({ kind: "unmanaged", runtime: "codex", sessionId: id(2), reason: "lend-worker-ended" });
  });

  test("journal 不在：什么都不收", async () => {
    const w = world();
    const files = [w.main(1), w.sub(2, 1)];
    expect(await sweepEndedLendThreads(agents(), { ...w.opts, journalPath: join(w.root, "none.sqlite") })).toBe(0);
    for (const p of files) expect(existsSync(p)).toBe(true);
  });
});

describe("settleOrder 收尾之后才归档", () => {
  async function toAcked(h: ReturnType<typeof harness>) {
    await toStarted(h);
    const body = { v: 1, orderId: "o1", gen: 1, verdict: { v: 1 }, report: "r", session: { id: "thr-1", family: "codex" } };
    advance(h.db, "o1", "started", "result_pending", { payload: body, payloadSha: sha(JSON.stringify(body)) });
    await h.tick();
  }

  test("终态、收据写完才调一次，之后不再调", async () => {
    const h = harness();
    const seen: { state: string; receipts: number; agent: string | null }[] = [];
    h.d.archiveSessions = async (r) => void seen.push({ state: r.state, receipts: h.log.receipts.length, agent: r.agent });
    await toAcked(h);
    await h.tick();
    expect(seen).toEqual([{ state: "acked", receipts: 1, agent: W1 }]);
  });

  test("归档抛错保留 acked 和持久收尾计划，恢复后才清空", async () => {
    const h = harness();
    let calls = 0;
    h.d.archiveSessions = async () => { calls++; throw new Error("磁盘满了"); };
    await toAcked(h);
    await h.tick();
    expect(getOrder(h.db, "o1")).toMatchObject({ state: "acked", settle: { notify: null, removeDir: false } });
    expect(calls).toBeGreaterThanOrEqual(2);
    h.d.archiveSessions = async () => { calls++; };
    await h.tick();
    expect(getOrder(h.db, "o1")).toMatchObject({ state: "acked", settle: null });
    const afterRecovery = calls;
    await h.tick();
    expect(calls).toBe(afterRecovery);
    expect(h.log.receipts.every((r) => r.state === "acked")).toBe(true);
  });
});

test("real hook (on) propagates a refusal / blocked-capability and does not archive unknown/stopped identities", async () => {
  const exact = { ...row(), leaseGen: 1, state: "acked" as const };
  await expect(archiveEndedWorker(exact, () => {}, async () => ({ ok: true, archived: false, reason: "unknown" }), "on"))
    .rejects.toThrow("保留收尾计划");
  await expect(archiveEndedWorker(exact, () => {}, async () => ({ ok: false, archived: false, blocked: true, reason: "claude 家族" }), "on"))
    .rejects.toThrow("blocked-capability");
  await expect(archiveEndedWorker({ ...exact, leaseGen: null }, () => {}, async () => ({ ok: true, archived: true }), "on")).rejects.toThrow("身份不完整");
  let calls = 0;
  await archiveEndedWorker({ ...exact, state: "stopped" }, () => {}, async () => { calls++; return {}; }, "on");
  expect(calls).toBe(0);
  await archiveEndedWorker(exact, () => {}, async (...args) => { calls++; expect(args[2]).toBe("settle"); return { ok: true, archived: true }; }, "on");
  expect(calls).toBe(1);
});
