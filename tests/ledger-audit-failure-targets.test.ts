import { describe, expect, spyOn, test } from "bun:test";
import { Database } from "bun:sqlite";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readAuditFailureTargets } from "../src/lib/ledger-audit-failure.js";
import { ledgerAuditTicker } from "../src/bridge/ledger-audit-service.js";
import type { Envelope } from "../src/bridge/router.js";

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "ledger-audit-failure-")), path = join(dir, "ledger.sqlite");
  const db = new Database(path);
  db.exec("CREATE TABLE meta(project TEXT, key TEXT, value TEXT, PRIMARY KEY(project,key))");
  db.exec("PRAGMA user_version = 1");
  const put = (project: string, key: string, value: unknown) => {
    db.query("INSERT OR REPLACE INTO meta VALUES(?,?,?)").run(project, key, JSON.stringify(value));
  };
  put("project-a", "pms", ["dispatcher", "old-pm", "current-pm"]);
  put("project-a", "team", { dispatcher: "dispatcher", audit: true, sinceSeq: 1 });
  return { db, put, path, targets: () => readAuditFailureTargets(path), close: () => { db.close(); rmSync(dir, { recursive: true, force: true }); } };
}

describe("failure notice canonical on-duty PM and read-only production path", () => {
  test("active pointer wins; no pointer uses first non-dispatcher; only audit projects included", () => {
    const { db, put, targets, close } = fixture();
    try {
      put("project-b", "pms", ["other-pm"]); put("project-empty", "pms", []);
      put("project-a", "activePm", "current-pm");
      const before = db.query("SELECT * FROM meta ORDER BY project,key").all();
      expect(targets()).toEqual([{ project: "project-a", to: "current-pm" }, { project: "project-b", to: "other-pm" }]);
      expect(db.query("SELECT * FROM meta ORDER BY project,key").all()).toEqual(before);
      db.query("DELETE FROM meta WHERE key='activePm'").run();
      expect(targets()[0].to).toBe("old-pm");
    } finally { close(); }
  });

  test.each(["dispatcher", "unknown-pm", "", 42])("invalid active pointer %j cannot redirect to owner or dispatcher", (pointer) => {
    const { db, put, targets, close } = fixture();
    try {
      put("project-a", "activePm", pointer);
      expect(() => targets()).toThrow();
    } finally { close(); }
  });

  test("dispatcher-only roster has no eligible PM", () => {
    const { db, put, targets, close } = fixture();
    try {
      put("project-a", "pms", ["dispatcher"]);
      expect(() => targets()).toThrow("当班 PM 无法核验");
    } finally { close(); }
  });

  test("real ticker resolves current metadata after manager failures without writing role/schema", async () => {
    const { db, put, path, close } = fixture(), sent: Envelope[] = [];
    try {
      const tick = ledgerAuditTicker({
        clients: new Map([["current", { ws: {} as never, channelId: "current" }]]),
        channelOf: (to) => to === "current-pm" ? "current" : undefined,
        failureTargets: () => readAuditFailureTargets(path),
        busy: async () => false, runManager: async () => ({ ok: false, error: "audit failure" }),
        deliver: async (env) => { sent.push(env); return { outcome: { kind: "sent" } }; },
        hold: () => { throw new Error("unexpected queue"); }, lastMessageSource: { set: () => {} },
      });
      await tick(); await tick();
      put("project-a", "activePm", "current-pm");
      const before = db.query("SELECT * FROM meta ORDER BY project,key").all();
      await tick(); await tick();
      expect(sent).toHaveLength(1);
      expect(sent[0].to).toMatchObject({ agentName: "current-pm" });
      expect(db.query("SELECT * FROM meta ORDER BY project,key").all()).toEqual(before);
      expect(db.query("PRAGMA user_version").get()).toEqual({ user_version: 1 });
    } finally { close(); }
  });

  test("missing meta table is whole-ledger failure, not an empty notified target list", () => {
    const { db, targets, close } = fixture();
    try {
      db.exec("DROP TABLE meta");
      expect(() => targets()).toThrow();
    } finally { close(); }
  });

  test("missing ledger cannot create a database or guess recipients", () => {
    const dir = mkdtempSync(join(tmpdir(), "ledger-audit-failure-missing-")), path = join(dir, "missing.sqlite");
    try {
      expect(() => readAuditFailureTargets(path)).toThrow("台账不可用");
      expect(existsSync(path)).toBe(false);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});

// SFAIL2: one project's unverifiable PM must not block verified projects, nor be redirected anywhere.
const invalidPm: [string, (put: (p: string, k: string, v: unknown) => void, project: string) => void][] = [
  ["illegal pointer", (put, p) => { put(p, "pms", ["dispatcher", "bad-pm-x"]); put(p, "activePm", "unknown-pm"); }],
  ["dispatcher pointer", (put, p) => { put(p, "pms", ["dispatcher", "bad-pm-x"]); put(p, "activePm", "dispatcher"); }],
  ["dispatcher-only roster", (put, p) => { put(p, "pms", ["dispatcher"]); }],
];
function mixed(invalidProject: string, validProject: string, broken: (typeof invalidPm)[number][1]) {
  const f = fixture();
  f.db.query("DELETE FROM meta").run();
  f.put(validProject, "pms", ["dispatcher", "old-pm", "current-pm"]);
  f.put(validProject, "team", { dispatcher: "dispatcher", audit: true, sinceSeq: 1 });
  f.put(validProject, "activePm", "current-pm");
  f.put(invalidProject, "team", { dispatcher: "dispatcher", audit: true, sinceSeq: 1 });
  broken(f.put, invalidProject);
  return f;
}
const quiet = () => spyOn(console, "error").mockImplementation(() => {});

describe("per-project target isolation (SFAIL2)", () => {
  for (const [label, broken] of invalidPm) {
    test.each([["project-a", "project-z"], ["project-z", "project-a"]])(`${label}: invalid %s skipped, valid %s kept`, (bad, ok) => {
      const f = mixed(bad, ok, broken), spy = quiet();
      try {
        const before = f.db.query("SELECT * FROM meta ORDER BY project,key").all();
        expect(f.targets()).toEqual([{ project: ok, to: "current-pm" }]);
        expect(f.db.query("SELECT * FROM meta ORDER BY project,key").all()).toEqual(before);
        expect(spy.mock.calls.some((c) => String(c[0]).includes(bad))).toBe(true);
      } finally { spy.mockRestore(); f.close(); }
    });
  }

  test("all projects valid: each resolves its own PM", () => {
    const f = fixture();
    try {
      f.put("project-b", "pms", ["pm-b"]);
      expect(f.targets()).toEqual([{ project: "project-a", to: "old-pm" }, { project: "project-b", to: "pm-b" }]);
    } finally { f.close(); }
  });

  test("all projects invalid: lookup fails instead of returning an empty notified list", () => {
    const f = fixture(), spy = quiet();
    try {
      f.put("project-a", "activePm", "unknown-pm");
      f.put("project-b", "pms", ["dispatcher"]); f.put("project-b", "team", { dispatcher: "dispatcher", audit: true, sinceSeq: 1 });
      expect(() => f.targets()).toThrow("当班 PM 无法核验");
    } finally { spy.mockRestore(); f.close(); }
  });

  for (const [label, broken] of invalidPm) {
    test.each([["project-a", "project-z"], ["project-z", "project-a"]])(`${label}: real ticker alerts only valid PM once; fixed %s resolves next round`, async (bad, ok) => {
      const f = mixed(bad, ok, broken), spy = quiet(), sent: Envelope[] = [];
      try {
        const tick = ledgerAuditTicker({
          clients: new Map([["ch", { ws: {} as never, channelId: "ch" }]]),
          channelOf: () => "ch", failureTargets: () => readAuditFailureTargets(f.path),
          busy: async () => false, runManager: async () => ({ ok: false, error: "audit failure" }),
          deliver: async (env) => { sent.push(env); return { outcome: { kind: "sent" } }; },
          hold: () => { throw new Error("unexpected queue"); }, lastMessageSource: { set: () => {} },
        });
        const before = f.db.query("SELECT * FROM meta ORDER BY project,key").all();
        await tick(); await tick();
        expect(sent).toHaveLength(0);
        for (let i = 0; i < 10; i++) await tick();
        expect(sent).toHaveLength(1);
        expect(sent[0].to).toMatchObject({ agentName: "current-pm" });
        expect(String(sent[0].content)).toContain(`项目 ${ok} `);
        expect(String(sent[0].content)).not.toContain(bad);
        expect(String(sent[0].content)).not.toContain("audit failure");
        expect(f.db.query("SELECT * FROM meta ORDER BY project,key").all()).toEqual(before);
        expect(f.db.query("PRAGMA user_version").get()).toEqual({ user_version: 1 });
        f.put(bad, "pms", ["dispatcher", "fixed-pm"]); f.put(bad, "activePm", "fixed-pm");
        await tick();
        expect(sent).toHaveLength(2);
        expect(sent[1].to).toMatchObject({ agentName: "fixed-pm" });
        expect(String(sent[1].content)).toContain(`项目 ${bad} `);
        for (let i = 0; i < 10; i++) await tick();
        expect(sent).toHaveLength(2);
      } finally { spy.mockRestore(); f.close(); }
    });
  }
});
