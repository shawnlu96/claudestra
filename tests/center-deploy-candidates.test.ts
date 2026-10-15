import { expect, test } from "bun:test";
import { centerCardKeys, centerCards } from "../src/lib/center-deploy-candidates.js";
import { createTask } from "../src/lib/ledger-write.js";
import { mergedCard } from "./deploy-test-kit.js";

const capture = (db: Parameters<typeof centerCardKeys>[0]) => Object.fromEntries(
  Object.entries(centerCardKeys(db, "p", "example/repo")).map(([id, key]) => [id, [key]]));

test("[验收线 4] successful merge identities exclude historic cards and unrelated main commits", () => {
  const f = mergedCard();
  try {
    expect(centerCards(f.db, "p", "example/repo")).toEqual(["T9"]);
    const deployed = capture(f.db);
    f.db.query("UPDATE tasks SET stage='done' WHERE id='T9'").run();
    expect(centerCards(f.db, "p", "example/repo", deployed)).toEqual([]);
    f.db.query("UPDATE tasks SET stage='fix' WHERE id='T9'").run();
    expect(centerCards(f.db, "p", "example/repo")).toEqual(["T9"]);
    expect(centerCards(f.db, "p", "example/repo", deployed)).toEqual([]);
    f.db.query("UPDATE scheduler_merges SET mergeSha=? WHERE taskId='T9'").run("e".repeat(40));
    expect(centerCards(f.db, "p", "example/repo", deployed)).toEqual(["T9"]);
  } finally { f.close(); }
});

test("[验收线 4] a later manual merge is pending without relisting already deployed cards", () => {
  const f = mergedCard();
  try {
    const deployed = capture(f.db);
    createTask(f.db, { actor: "owner", now: 200 }, { id: "T10", project: "p", title: "manual", kind: "code" });
    f.db.query("UPDATE tasks SET stage='live', pr=?, headSHA=? WHERE id='T10'").run("https://github.com/example/repo/pull/10", "f".repeat(40));
    expect(centerCards(f.db, "p", "example/repo", deployed)).toEqual(["T10"]);
    const both = capture(f.db);
    f.db.query("UPDATE tasks SET stage='verified' WHERE id='T10'").run();
    expect(centerCards(f.db, "p", "example/repo", both)).toEqual([]);
  } finally { f.close(); }
});


test("[验收线 4] a manually merged revision after a scheduler merge has a new identity", () => {
  const f = mergedCard();
  try {
    const deployed = capture(f.db);
    f.db.query("UPDATE tasks SET stage='live', headSHA=? WHERE id='T9'").run("f".repeat(40));
    expect(centerCards(f.db, "p", "example/repo", deployed)).toEqual(["T9"]);
  } finally { f.close(); }
});
