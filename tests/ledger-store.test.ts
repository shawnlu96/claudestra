/** 台账库（src/lib/ledger-store.ts）：建表与版本、事件只追加、按路径缓存、两个进程并发推同一任务只有一个成功 */
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, test } from "bun:test";
import * as store from "../src/lib/ledger-store.js";
import * as write from "../src/lib/ledger-write.js";

const { busyAsLedgerError, closeLedger, getTask, LEDGER_SCHEMA_VERSION, LEDGER_TABLES, listEvents, openLedger, schemaVersion } = store;

function tmp(): { dir: string; path: string } {
  const dir = mkdtempSync(join(tmpdir(), "ledger-"));
  return { dir, path: join(dir, "ledger.sqlite") };
}

describe("openLedger", () => {
  test("建全四张表、user_version 到最新；同一路径返回同一连接", () => {
    const db = openLedger(":memory:");
    try {
      const names = (db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as { name: string }[]).map((r) => r.name);
      for (const t of LEDGER_TABLES) expect(names).toContain(t);
      expect(schemaVersion(db)).toBe(LEDGER_SCHEMA_VERSION);
      expect(openLedger(":memory:")).toBe(db);
    } finally {
      closeLedger(":memory:");
    }
  });
  test("文件库：WAL、再开一次不重复迁移、数据还在", () => {
    const { dir, path } = tmp();
    try {
      const db = openLedger(path);
      expect((db.prepare("PRAGMA journal_mode").get() as { journal_mode: string }).journal_mode).toBe("wal");
      write.createItem(db, { actor: "owner" }, { project: "p", id: "i1", title: "x" });
      closeLedger(path);
      const again = openLedger(path);
      expect(schemaVersion(again)).toBe(LEDGER_SCHEMA_VERSION);
      expect(store.listItems(again, "p")).toHaveLength(1);
      closeLedger(path);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("事件只追加", () => {
  test("两个模块都没有改 / 删事件的导出函数", () => {
    const names = [...Object.keys(store), ...Object.keys(write)];
    expect(names.filter((n) => /event/i.test(n) && /(update|delete|remove|edit|set)/i.test(n))).toEqual([]);
  });
  test("直接 UPDATE / DELETE events 被 trigger 拦下", () => {
    const db = openLedger(":memory:");
    try {
      write.createItem(db, { actor: "owner" }, { project: "p", id: "i1", title: "x" });
      expect(() => db.exec("UPDATE events SET text = 'x'")).toThrow(/append-only/);
      expect(() => db.exec("DELETE FROM events")).toThrow(/append-only/);
      expect(listEvents(db)).toHaveLength(1);
    } finally {
      closeLedger(":memory:");
    }
  });
});

/** 子进程：等到同一时刻起跑，推 T1 build→review，打印结果 */
function childScript(path: string, startAt: number): string {
  const storeUrl = resolve(import.meta.dir, "../src/lib/ledger-store.ts");
  const writeUrl = resolve(import.meta.dir, "../src/lib/ledger-write.ts");
  return `
    const { openLedger } = await import(${JSON.stringify(storeUrl)});
    const { moveStage } = await import(${JSON.stringify(writeUrl)});
    const db = openLedger(${JSON.stringify(path)});
    while (Date.now() < ${startAt}) {}
    try {
      moveStage(db, { actor: "agent-x" }, { taskId: "T1", from: "build", to: "review" });
      console.log(JSON.stringify({ ok: true }));
    } catch (e) {
      console.log(JSON.stringify({ ok: false, code: e.code, message: e.message, current: e.current }));
    }
  `;
}

describe("两个进程并发写同一任务", () => {
  test("同时推 build→review：一个成功，另一个拿到 conflict 与当前阶段；事件只多一条", async () => {
    const { dir, path } = tmp();
    try {
      const db = openLedger(path);
      write.createTask(db, { actor: "owner" }, { project: "p", id: "T1", title: "t", kind: "code", agent: "agent-x", stage: "build" });
      closeLedger(path);
      const startAt = Date.now() + 800;
      const procs = [0, 1].map(() =>
        Bun.spawn([process.execPath, "-e", childScript(path, startAt)], { stdout: "pipe", stderr: "pipe", env: { ...process.env, CLAUDESTRA_STATE_DIR: dir } }),
      );
      const outs = await Promise.all(procs.map(async (p) => JSON.parse((await new Response(p.stdout).text()).trim()) as Record<string, unknown>));
      expect(outs.filter((o) => o.ok)).toHaveLength(1);
      const loser = outs.find((o) => !o.ok);
      expect(loser).toMatchObject({ ok: false, code: "conflict", current: { stage: "review" } });
      expect(String(loser?.message)).toContain("当前阶段是 review");
      const check = openLedger(path);
      expect(getTask(check, "T1")).toMatchObject({ stage: "review", round: 1, rev: 2 });
      expect(listEvents(check, { target: "T1" }).map((e) => e.kind)).toEqual(["task", "stage"]);
      closeLedger(path);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 15_000);
});

describe("老库直接打开", () => {
  test("user_version 已是最新的库不再执行建表（否则 CREATE TABLE 会因表已存在而抛错）", () => {
    const { dir, path } = tmp();
    try {
      openLedger(path);
      closeLedger(path);
      const raw = new Database(path);
      expect(schemaVersion(raw)).toBe(LEDGER_SCHEMA_VERSION);
      raw.close();
      expect(() => openLedger(path)).not.toThrow();
      closeLedger(path);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

/** 子进程：同一时刻打开同一个新库，各写一条事项 */
function openerScript(path: string, startAt: number, id: string): string {
  const storeUrl = resolve(import.meta.dir, "../src/lib/ledger-store.ts");
  const writeUrl = resolve(import.meta.dir, "../src/lib/ledger-write.ts");
  return `
    const { openLedger } = await import(${JSON.stringify(storeUrl)});
    const { createItem } = await import(${JSON.stringify(writeUrl)});
    while (Date.now() < ${startAt}) {}
    try {
      createItem(openLedger(${JSON.stringify(path)}), { actor: "owner" }, { project: "p", id: ${JSON.stringify(id)}, title: "x" });
      console.log(JSON.stringify({ ok: true }));
    } catch (e) {
      console.log(JSON.stringify({ ok: false, code: e.code, message: String(e.message) }));
    }
  `;
}

describe("多进程同时首次打开新库（审查第 1 轮 P2-6）", () => {
  test("8 个进程同时打开并写入，连跑 4 轮：全部成功、库是 WAL、事项 8 条", async () => {
    for (let round = 0; round < 4; round++) {
      const { dir, path } = tmp();
      try {
        const startAt = Date.now() + 600;
        const procs = Array.from({ length: 8 }, (_, i) =>
          Bun.spawn([process.execPath, "-e", openerScript(path, startAt, `i${i}`)], { stdout: "pipe", stderr: "pipe", env: { ...process.env, CLAUDESTRA_STATE_DIR: dir } }),
        );
        const outs = await Promise.all(procs.map(async (p) => (await new Response(p.stdout).text()).trim()));
        expect(outs.map((o) => JSON.parse(o) as { ok: boolean })).toEqual(Array.from({ length: 8 }, () => ({ ok: true })));
        const db = openLedger(path);
        expect((db.prepare("PRAGMA journal_mode").get() as { journal_mode: string }).journal_mode).toBe("wal");
        expect(store.listItems(db, "p")).toHaveLength(8);
        closeLedger(path);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }
  }, 60_000);
  test("等锁超时的 SQLITE_BUSY 换成 LedgerError(busy)，其它错误原样抛", () => {
    const busy = Object.assign(new Error("database is locked"), { code: "SQLITE_BUSY" });
    expect(() => busyAsLedgerError("写入", () => { throw busy; })).toThrow(expect.objectContaining({ name: "LedgerError", code: "busy" }));
    expect(() => busyAsLedgerError("写入", () => { throw new Error("boom"); })).toThrow("boom");
  });
});
