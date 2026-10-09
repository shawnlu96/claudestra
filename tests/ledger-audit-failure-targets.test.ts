import { describe, expect, test } from "bun:test";
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

  test("missing ledger cannot create a database or guess recipients", () => {
    const dir = mkdtempSync(join(tmpdir(), "ledger-audit-failure-missing-")), path = join(dir, "missing.sqlite");
    try {
      expect(() => readAuditFailureTargets(path)).toThrow("台账不可用");
      expect(existsSync(path)).toBe(false);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});
