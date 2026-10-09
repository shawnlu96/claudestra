import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { Glob } from "bun";
import { TRACKED } from "../src/lib/shared-ledger-v2-write-gate-state.js";

// S2G2 r1 replace-bypasses-tracking: REPLACE deletes the conflicting row without firing the gate's DELETE trigger, so writing a
// TRACKED table with it would escape the gate. The precondition is enforced here at the source level over src/**/*.ts.
const REPLACE = /\b(?:INSERT\s+OR\s+REPLACE\s+INTO|REPLACE\s+INTO|UPDATE\s+OR\s+REPLACE)\s+(?:(?:main|temp)\s*\.\s*)?["`[]?(\w+)/gi;
function replaceWrites(source: string): string[] {
  return [...source.matchAll(REPLACE)].map(m => m[1]).filter(table => TRACKED.includes(table));
}

describe("S2G2 REPLACE static guard", () => {
  test("no source writes a gate-tracked table with REPLACE", () => {
    const root = join(import.meta.dir, "..", "src"), hits: string[] = [];
    for (const file of new Glob("**/*.ts").scanSync(root)) {
      for (const table of replaceWrites(readFileSync(join(root, file), "utf8"))) hits.push(`${relative(root, join(root, file))}: ${table}`);
    }
    expect(TRACKED).toContain("tasks");
    expect(TRACKED).toContain("scheduler_intents");
    expect(hits).toEqual([]);
  });
  // Reviewer probes P1 (REPLACE rewrites an execution card) and P2 (REPLACE swaps another card's intent inside an executor
  // token) are stopped here at the source level rather than at runtime; untracked tables keep their existing REPLACE writes.
  test("the review probes' REPLACE forms are caught; untracked tables are not", () => {
    expect(replaceWrites("INSERT OR REPLACE INTO tasks (id,title) VALUES ('T','x')")).toEqual(["tasks"]);
    expect(replaceWrites("insert or replace into\n  main.\"scheduler_intents\" SELECT * FROM x")).toEqual(["scheduler_intents"]);
    expect(replaceWrites("REPLACE INTO task_steps VALUES (1)")).toEqual(["task_steps"]);
    expect(replaceWrites("UPDATE OR REPLACE scheduler_resources SET taskId='T'")).toEqual(["scheduler_resources"]);
    expect(replaceWrites("INSERT OR REPLACE INTO scheduler_meta VALUES ('k','v')")).toEqual([]);
    expect(replaceWrites("INSERT INTO meta VALUES (1) ON CONFLICT DO UPDATE SET value=excluded.value")).toEqual([]);
  });
});
