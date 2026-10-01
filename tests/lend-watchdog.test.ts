/** T94 出借 worker 自停兜底（src/lib/lend-watchdog.ts）：服务不在时宿主自己按 journal 的租约截止停；i28-W1 起 lend.json 里授权没了也停 */
import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, renameSync, rmdirSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { LendEntry } from "../src/lib/lend-config.js";
import { advance, openLendJournal, patchOrder, recordAsked } from "../src/lib/lend-journal.js";
import { lendStopReason as stopReason, lendWatchdog as watchdog, UNREADABLE_LIMIT, WATCHDOG_EVERY_MS, WATCHDOG_GRACE_MS } from "../src/lib/lend-watchdog.js";
import { REPO_ROOT } from "../src/lib/repo-root.js";

const FP = "abcd-ef01-2345-6789";
const DAY = 86_400_000;
const GRANT: LendEntry = { peer: "a", fp: FP, families: { codex: 1 }, roles: ["review"], repos: ["o/r"], ordersPerDay: 5,
  grantedAt: new Date(0).toISOString(), until: new Date(6 * DAY).toISOString() };
/** journal 旁边那份 lend.json（测试不碰默认状态目录） */
const lendOf = (path: string) => join(dirname(path), "lend.json");
const writeLend = (path: string, lend: unknown[], enabled = true) =>
  writeFileSync(lendOf(path), JSON.stringify({ version: 2, enabled, lend, borrow: [] }));
const lendStopReason = (agent: string, path: string, now: number) => stopReason(agent, path, now, lendOf(path));
const lendWatchdog = (agent: string, log: (m: string) => void, path: string) => watchdog(agent, log, path, lendOf(path));

function journal(leaseUntil: number) {
  const path = join(mkdtempSync(join(tmpdir(), "lend-wd-")), "journal.sqlite");
  writeLend(path, [GRANT]);
  const db = openLendJournal(path);
  recordAsked(db, { orderId: "o1", peer: "a", fp: FP, family: "codex", preview: { repo: "o/r", step: "review" } }, 0);
  advance(db, "o1", "asked", "claimed", { leaseUntil, leaseGen: 1 });
  advance(db, "o1", "claimed", "cloned", { dir: "/w" });
  patchOrder(db, "o1", ["cloned"], { agent: "agent-lend-x" });
  advance(db, "o1", "cloned", "started", { sessionId: "s" });
  return { db, path };
}

describe("T94 宿主自停兜底", () => {
  test("租约内接着跑；过了截止 + 宽限就该停", () => {
    const { path } = journal(10_000);
    expect(lendStopReason("agent-lend-x", path, 10_000)).toBeNull();
    expect(lendStopReason("agent-lend-x", path, 10_000 + WATCHDOG_GRACE_MS + 1)).toMatch(/心跳过期/);
  });

  test("单已结束、journal 里没有这个 worker、journal 不在：都该停（fail-closed）", () => {
    const { db, path } = journal(9e15);
    expect(lendStopReason("agent-lend-other", path, 1)).toMatch(/没有/);
    advance(db, "o1", "started", "cancelled", { reason: "撤单" });
    expect(lendStopReason("agent-lend-x", path, 1)).toMatch(/已结束/);
    expect(lendStopReason("agent-lend-x", join(tmpdir(), "nope", "j.sqlite"), 1)).toMatch(/不在/);
  });
});

describe("i28-R5a 读不了 journal 不再一次就停", () => {
  test("读不了要连续 UNREADABLE_LIMIT 次才停；中间读到一次就清零；定性的该停照样立即停", () => {
    const { db: setup, path } = journal(9e15);
    setup.close(); // 下面要把文件换走：本进程不能还开着它
    const lines: string[] = [];
    const tick = lendWatchdog("agent-lend-x", (m) => void lines.push(m), path);
    // 读不了：把 journal 暂时换成同名目录（新 inode，SQLite 不会复用本进程已开的句柄）
    const unreadable = (f: () => unknown) => { renameSync(path, `${path}.away`); mkdirSync(path); try { return f(); } finally { rmdirSync(path); renameSync(`${path}.away`, path); } };
    expect(unreadable(() => tick(1))).toBeNull();
    expect(lines[0]).toContain("这次没读到");
    expect(tick(2)).toBeNull(); // 读到了：清零
    expect(unreadable(() => tick(3))).toBeNull();
    expect(UNREADABLE_LIMIT).toBe(2);
    expect(unreadable(() => tick(4))).toMatch(/读不了出借 journal/);
    const db = openLendJournal(path);
    advance(db, "o1", "started", "cancelled", { reason: "撤单" });
    expect(lendWatchdog("agent-lend-x", () => {}, path)(5)).toMatch(/已结束/);
  });

  test("调度服务每轮开 / 写 / 关 journal（关时 checkpoint 独占）的同时连读：一次都不报读不了（lab 里零等待读法约 2% 失败）", async () => {
    const { db, path } = journal(9e15);
    db.close();
    const writer = Bun.spawn([process.execPath, "-e", `const { openLendJournal, patchOrder } = await import(${JSON.stringify(`${REPO_ROOT}/src/lib/lend-journal.ts`)});
      for (const end = Date.now() + 3000; Date.now() < end; await Bun.sleep(5)) {
        const d = openLendJournal(${JSON.stringify(path)});
        patchOrder(d, "o1", ["started"], { lastBeatAt: Date.now() });
        d.close();
      }`],
      { stdout: "ignore", stderr: "inherit" });
    const seen: Record<string, number> = {};
    for (const end = Date.now() + 3000; Date.now() < end; await Bun.sleep(5)) { const w = lendStopReason("agent-lend-x", path, 1) ?? "ok"; seen[w] = (seen[w] ?? 0) + 1; }
    await writer.exited;
    expect(writer.exitCode).toBe(0);
    expect(Object.keys(seen)).toEqual(["ok"]);
    expect(seen.ok).toBeGreaterThan(50);
  }, 20_000);
});

describe("i28-W1 授权没了宿主也自停（调度服务停着时收回授权靠这一处）", () => {
  test("授权在就接着跑；收回、总开关关、暂停、过期、超 7 天、含 write、指纹变了、文件不在或坏了：都立即该停", () => {
    const { path } = journal(9e15);
    expect(lendStopReason("agent-lend-x", path, 1)).toBeNull();
    const cases: [unknown[], boolean, number, RegExp][] = [
      [[], true, 1, /已收回/],
      [[GRANT], false, 1, /已收回/],
      [[{ ...GRANT, paused: { reason: "旧条目" } }], true, 1, /暂停/],
      [[GRANT], true, 6 * DAY + 1, /到期/],
      [[{ ...GRANT, until: new Date(30 * DAY).toISOString() }], true, 1, /7 天/],
      [[{ ...GRANT, roles: ["review", "write"] }], true, 1, /write/],
      [[{ ...GRANT, fp: "1111-2222-3333-4444" }], true, 1, /指纹/],
      [[{ ...GRANT, peer: "b" }], true, 1, /已收回/],
    ];
    for (const [lend, enabled, now, why] of cases) {
      writeLend(path, lend, enabled);
      expect(lendStopReason("agent-lend-x", path, now)).toMatch(why);
    }
    writeFileSync(lendOf(path), "{oops");
    expect(lendStopReason("agent-lend-x", path, 1)).toMatch(/无效/);
    unlinkSync(lendOf(path));
    expect(lendStopReason("agent-lend-x", path, 1)).toMatch(/lend\.json 不在/);
  });

  test("看门狗每 30 秒一检：收回后的下一检就判停，不当成「读不了」去数次数（≤ 60 秒）", () => {
    const { path } = journal(9e15);
    const lines: string[] = [];
    const tick = lendWatchdog("agent-lend-x", (m) => void lines.push(m), path);
    expect(tick(1)).toBeNull();
    writeLend(path, []);
    expect(tick(1 + WATCHDOG_EVERY_MS)).toMatch(/已收回/);
    expect(WATCHDOG_EVERY_MS).toBeLessThanOrEqual(30_000);
    expect(lines).toEqual([]);
  });

  test("重授时拿掉了这张单的仓库 / 家族：宿主也停（W8 之前角色只能是 review，收窄角色就整条失效）", () => {
    const { path } = journal(9e15);
    for (const [narrow, why] of [[{ repos: ["x/y"] }, /仓库/], [{ families: { claude: 1 } }, /codex 位/]] as const) {
      writeLend(path, [{ ...GRANT, ...narrow }]);
      expect(lendStopReason("agent-lend-x", path, 1)).toMatch(why);
    }
    writeLend(path, [GRANT]);
    expect(lendStopReason("agent-lend-x", path, 1)).toBeNull();
  });

  test("v1 的 lend.json（升级前的条目）：迁成暂停，宿主照样停", () => {
    const { path } = journal(9e15);
    writeFileSync(lendOf(path), JSON.stringify({ version: 1, enabled: true, borrow: [], lend: [{ peer: "a", fp: FP, families: { codex: 1 }, roles: ["review"],
      repos: ["o/r"], quota: { ordersPerDay: 5, tokensPerDay: null }, confirm: "auto", until: new Date(DAY).toISOString() }] }));
    expect(lendStopReason("agent-lend-x", path, 1)).toMatch(/暂停/);
  });
});
