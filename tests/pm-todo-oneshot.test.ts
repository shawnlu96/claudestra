import { expect, test } from "bun:test";
import { mergeOneShotTodos, ONESHOT_TODO_KIND } from "../src/lib/pm-todo-oneshot.js";
import type { DigestEntry } from "../src/lib/pm-digest.js";

const entry = (id: string, project: string, extra: Partial<DigestEntry> = {}): DigestEntry =>
  ({ id, project, kind: "sync", source: "agent-x", firstLine: `line ${id}`, at: 10, ...extra });
const store = (queue: DigestEntry[]) => ({ read: () => ({ queue, log: [] }) });

test("only this project's unleveled oneShot entries are appended, after the existing todos", () => {
  const prior = [{ task: "T0", verifiedAt: 1, hours: null, due: true, dueAt: 1, what: "上线后待办" }];
  const out = mergeOneShotTodos("p", prior, store([
    entry("a", "p", { unleveled: true, card: "agents-A1" }), entry("b", "p"), entry("c", "q", { unleveled: true }), entry("d", "p", { unleveled: true }),
  ]));
  expect(out).toEqual([...prior,
    { task: "agents-A1", verifiedAt: 10, hours: null, due: true, dueAt: 10, what: "agent-x · line a", kind: ONESHOT_TODO_KIND },
    { task: "", verifiedAt: 10, hours: null, due: true, dueAt: 10, what: "agent-x · line d", kind: ONESHOT_TODO_KIND }]);
});

test("nothing queued: todos unchanged", () => {
  expect(mergeOneShotTodos("p", [], store([]))).toEqual([]);
});
