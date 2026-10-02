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

describe("archiveEndedWorker：结单触发", () => {
  test("收这个 worker 的主线程、子线程和孙线程，别人的一个不动；meta 记来由", async () => {
    const w = world();
    const mine = [w.main(1), w.sub(2, 1), w.sub(3, 2, 1)];
    const others = [w.main(10), w.sub(11, 10), w.main(20), w.sub(21, 20)];
    const lines: string[] = [];
    await archiveEndedWorker(row(), (m) => lines.push(m), { keep: new Set(), ...w.opts });
    for (const p of mine) expect(existsSync(p)).toBe(false);
    for (const p of others) expect(existsSync(p)).toBe(true);
    expect(lines).toEqual([`o1 结单：${W1} 的 3 个 Codex 会话收进归档区(archived/)`]);
    const meta = JSON.parse(readFileSync(join(w.opts.archiveRoot, id(2), ".meta.json"), "utf8"));
    expect(meta).toMatchObject({ kind: "unmanaged", runtime: "codex", sessionId: id(2), reason: "lend-worker-ended" });
  });

  test("Claude 单、没起过 worker、名字不是出借 worker 的：什么都不做", async () => {
    const w = world();
    const files = [w.main(1), w.sub(2, 1)];
    for (const r of [row({ family: "claude" }), row({ sessionId: null }), row({ agent: OWNER })]) {
      await archiveEndedWorker(r, () => {}, { keep: new Set(), ...w.opts });
    }
    for (const p of files) expect(existsSync(p)).toBe(true);
  });

  test("Codex 进程还锁着的线程不收；恢复清单坏了只记日志、不抛", async () => {
    const w = world();
    const files = [w.main(1), w.sub(2, 1)];
    writeFileSync(join(w.opts.locksDir, `${id(1)}.lock`), "");
    await archiveEndedWorker(row(), () => {}, { keep: new Set(), ...w.opts });
    for (const p of files) expect(existsSync(p)).toBe(true); // 主线程被锁 = 子线程的父也算锁着

    rmSync(join(w.opts.locksDir, `${id(1)}.lock`));
    writeFileSync(w.opts.restoredIndex, "{坏");
    const lines: string[] = [];
    await archiveEndedWorker(row(), (m) => lines.push(m), { keep: new Set(), ...w.opts });
    for (const p of files) expect(existsSync(p)).toBe(true);
    expect(lines[0]).toContain("不影响结单");
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

  test("归档抛错也不影响结单：仍是 acked、收尾清空、收据已写", async () => {
    const h = harness();
    let calls = 0;
    h.d.archiveSessions = async () => { calls++; throw new Error("磁盘满了"); };
    await toAcked(h);
    await h.tick();
    expect(getOrder(h.db, "o1")).toMatchObject({ state: "acked", settle: null });
    expect(h.log.receipts.map((r) => r.state)).toEqual(["acked"]);
    expect(calls).toBe(1);
  });
});
