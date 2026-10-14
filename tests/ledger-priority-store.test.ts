import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeLedger, LEDGER_MIGRATIONS, LEDGER_SCHEMA_VERSION, openLedger } from "../src/lib/ledger-store.js";
import { readPriority, priorityHistory } from "../src/lib/ledger-priority-read.js";
import { setPriority } from "../src/lib/ledger-priority-write.js";
import { migratePriority } from "../src/lib/ledger-priority-schema.js";
import { LedgerReader } from "../src/lib/ledger-read.js";

const project = "p";
const target = { kind: "feature", id: "ab12-old" } as const;
const evidence = { ownerWords: "先做旧功能", ownerAt: 1000, sourceRef: "web:owner/10" };

function oldDatabase(path: string) {
  const db = new Database(path);
  for (const step of LEDGER_MIGRATIONS.slice(0, -1)) {
    if (typeof step === "function") step(db);
    else for (const sql of step) db.query(sql).run();
  }
  db.query(`INSERT INTO features(id,project,title,status,createdBy,createdAt,updatedAt,currentVersion)
    VALUES ('ab12-old','p','old','active','owner',1,1,1)`).run();
  db.query(`INSERT INTO dag_versions(featureId,version,reasonKind,reasonText,proposedBy,createdAt,nodes)
    VALUES ('ab12-old',1,'initial','','owner',1,?)`).run(JSON.stringify([{ key: "planned", taskId: null }]));
  db.query(`INSERT INTO items(project,id,title,priority,status,createdAt,updatedAt) VALUES ('p','legacy','legacy','P0','todo',1,1)`).run();
  db.exec(`PRAGMA user_version=${LEDGER_SCHEMA_VERSION - 1}`);
  return db;
}

test("旧库只读缺省无迁移；写连接自动升级、幂等补表，旧事项文本不变", () => {
  const dir = mkdtempSync(join(tmpdir(), "prio-migration-")), path = join(dir, "ledger.sqlite"), reader = new LedgerReader(path);
  const old = oldDatabase(path);
  old.close();
  try {
    const ro = reader.get()!;
    expect(readPriority(ro, project, target)).toMatchObject({ effective: "next", source: "system", rev: 0 });
    expect(ro.query("PRAGMA user_version").get()).toEqual({ user_version: LEDGER_SCHEMA_VERSION - 1 });
    reader.close();
    const db = openLedger(path);
    expect(db.query("PRAGMA user_version").get()).toEqual({ user_version: LEDGER_SCHEMA_VERSION });
    const node = { kind: "node", id: target.id, nodeKey: "planned" } as const;
    const first = readPriority(db, project, node);
    migratePriority(db);
    expect(readPriority(db, project, node)).toEqual(first);
    expect(db.query("SELECT priority FROM items WHERE id='legacy'").get()).toEqual({ priority: "P0" });
    db.query("DROP TABLE priority_modes").run();
    closeLedger(path);
    const repaired = openLedger(path);
    expect(repaired.query("SELECT name FROM sqlite_master WHERE name='priority_modes'").get()).not.toBeNull();
    expect(readPriority(repaired, project, node)).toEqual(first);
  } finally {
    reader.close(); closeLedger(path); rmSync(dir, { recursive: true, force: true });
  }
});

function writer(path: string, at: number, key: string, band: "now" | "later") {
  const code = `
    import {openLedger} from ${JSON.stringify(join(import.meta.dir, "../src/lib/ledger-store.ts"))};
    import {setPriority} from ${JSON.stringify(join(import.meta.dir, "../src/lib/ledger-priority-write.ts"))};
    const db=openLedger(${JSON.stringify(path)});
    await Bun.sleep(Math.max(0, ${at}-Date.now()));
    try {
      const result=setPriority(db, {actor:'owner',project:'p',dedupKey:${JSON.stringify(key)}},
        {target:${JSON.stringify(target)}, rev:0, band:${JSON.stringify(band)}, evidence:${JSON.stringify(evidence)}});
      console.log(JSON.stringify({ok:true,duplicate:result.duplicate}));
    } catch(error) { console.log(JSON.stringify({ok:false,code:error.code})); }
    db.close();
  `;
  return Bun.spawn([process.execPath, "-e", code], { stdout: "pipe", stderr: "pipe", env: { ...process.env, CLAUDESTRA_STATE_DIR: join(path, "..") } });
}

test("独立进程竞争同一 rev：一胜一冲突；相同去重请求只留一条历史", async () => {
  const dir = mkdtempSync(join(tmpdir(), "prio-cas-")), path = join(dir, "ledger.sqlite");
  oldDatabase(path).close();
  const db = openLedger(path);
  try {
    const races = [writer(path, Date.now() + 600, "a", "now"), writer(path, Date.now() + 600, "b", "later")];
    const outputs = await Promise.all(races.map(async (child) => {
      const output = await new Response(child.stdout).text(), stderr = await new Response(child.stderr).text();
      expect(await child.exited).toBe(0); expect(stderr).toBe("");
      return JSON.parse(output) as { ok: boolean; code?: string };
    }));
    expect(outputs.filter((r) => r.ok)).toHaveLength(1);
    expect(outputs.filter((r) => r.code === "conflict")).toHaveLength(1);
    expect(priorityHistory(db, project, target)).toHaveLength(1);
    db.query("DELETE FROM priority_records WHERE kind='feature'").run();
    const replay = [writer(path, Date.now() + 400, "replay", "now"), writer(path, Date.now() + 400, "replay", "now")];
    const repeated = await Promise.all(replay.map(async (child) => {
      const output = await new Response(child.stdout).text();
      expect(await child.exited).toBe(0);
      return JSON.parse(output) as { ok: boolean; duplicate: boolean };
    }));
    expect(repeated.every((r) => r.ok)).toBe(true);
    expect(repeated.filter((r) => r.duplicate)).toHaveLength(1);
    expect(priorityHistory(db, project).filter((e) => e.dedupKey === "replay")).toHaveLength(1);
  } finally { closeLedger(path); rmSync(dir, { recursive: true, force: true }); }
});

test("历史保留原话、来源、登记者、时间、旧新值，跨项目授权拒绝不建行", () => {
  const dir = mkdtempSync(join(tmpdir(), "prio-audit-")), path = join(dir, "ledger.sqlite");
  oldDatabase(path).close();
  const db = openLedger(path);
  try {
    expect(() => setPriority(db, { actor: "owner", project: "other", dedupKey: "wrong" },
      { target, band: "now", rev: 0, evidence })).toThrow("本项目");
    expect(db.query("SELECT 1 FROM priority_records WHERE kind='feature'").get()).toBeNull();
    setPriority(db, { actor: "owner", project, dedupKey: "audit", now: 2000 }, { target, band: "now", rev: 0, evidence });
    expect(priorityHistory(db, project, target)[0]).toMatchObject({ actor: "owner", ts: 2000,
      data: { ...evidence, before: { effective: "next", source: "system" }, after: { effective: "now", source: "explicit" } } });
  } finally { closeLedger(path); rmSync(dir, { recursive: true, force: true }); }
});
