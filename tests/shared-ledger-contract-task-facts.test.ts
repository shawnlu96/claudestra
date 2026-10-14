import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { parseSharedLedgerTaskFacts, TASK_FACT_KINDS, TASK_FACTS_RESOURCE } from "../src/lib/shared-ledger-contract-task-facts.js";
import {
  TASK_FACTS_FIXTURE, TASK_FACTS_INVALID_RESPONSES, TASK_FACTS_OLD_CENTER_STATUS, TASK_FACTS_SCENARIO,
} from "../src/lib/shared-ledger-contract-task-facts-fixtures.js";

describe("task-facts contract", () => {
  test("[验收线 1] the valid response and the four-card scenario expectation parse unchanged", () => {
    expect(parseSharedLedgerTaskFacts(TASK_FACTS_FIXTURE)).toEqual(TASK_FACTS_FIXTURE);
    expect(JSON.stringify(parseSharedLedgerTaskFacts(TASK_FACTS_SCENARIO.expected))).toBe(JSON.stringify(TASK_FACTS_SCENARIO.expected));
    const { tasks, events, homeInstanceId } = TASK_FACTS_SCENARIO.input;
    expect(tasks.map((t) => t.stage)).toEqual(["build", "done", "spec", "build"]);
    expect(tasks.map((t) => t.taskId)).toEqual(TASK_FACTS_SCENARIO.expected.tasks.map((t) => t.taskId));
    expect(events.some((e) => e.sourceInstanceId !== homeInstanceId)).toBe(true);
    expect(events.filter((e) => e.sourceTaskId === "source-build-a" && e.sourceInstanceId === homeInstanceId).map((e) => e.type))
      .toEqual(["stage", "review", "note"]);
    expect(events.filter((e) => e.sourceTaskId === "source-done-a").map((e) => e.type)).toEqual(["stage", "stage"]);
    expect(events.some((e) => e.sourceTaskId === "source-build-b" && e.type === "stage")).toBe(false);
  });

  test("[验收线 1] every invalid response fails closed with invalid_field", () => {
    expect(Object.keys(TASK_FACTS_INVALID_RESPONSES)).toHaveLength(11);
    for (const [name, body] of Object.entries(TASK_FACTS_INVALID_RESPONSES)) {
      expect(() => parseSharedLedgerTaskFacts(body), name).toThrow("invalid_field");
    }
  });

  test("[验收线 1] kinds are exactly the nine fact kinds; resource and old-center status", () => {
    expect([...TASK_FACT_KINDS]).toEqual(["stage", "deliver", "review", "verify", "deploy", "ask", "ask_cancel", "decision", "dispatch"]);
    expect(TASK_FACTS_RESOURCE.exec("features/feature-a/task-facts")?.[1]).toBe("feature-a");
    for (const bad of ["features/a/b/task-facts", "features/a/task-facts/x", "features/a%3Fx/task-facts", "features//task-facts"]) {
      expect(TASK_FACTS_RESOURCE.test(bad)).toBe(false);
    }
    expect(TASK_FACTS_OLD_CENTER_STATUS).toBe(403);
  });

  test("[验收线 1] the contract file imports only the schema module", () => {
    const source = readFileSync(new URL("../src/lib/shared-ledger-contract-task-facts.ts", import.meta.url), "utf8");
    const imports = [...source.matchAll(/^import\b[^;]*?from\s+"([^"]+)"/gms)].map((m) => m[1]);
    expect(imports).toEqual(["./shared-ledger-contract-schema.js"]);
  });
});
