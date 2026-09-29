import { describe, expect, test } from "bun:test";
import { markWorkerKinds, visibleInDefaultSearch, workerKind } from "../src/lib/worker-kind.js";

describe("worker registry kind", () => {
  test("new task workers and legacy explicit evidence share one classifier", () => {
    expect(workerKind("agent-build", { task: "T68" }, true)).toBe("worker");
    expect(workerKind("agent-build", { task: "T68" })).toBeNull();
    expect(workerKind("agent-build", { task: "T68", parent: "agent-pm" })).toBe("worker");
    expect(workerKind("agent-task-t68", {})).toBe("worker");
    expect(workerKind("agent-review", { role: "dispatcher" })).toBe("worker");
    expect(workerKind("agent-codex", { task: "T68", parent: "agent-pm" }, true)).toBeNull();
    expect(workerKind("agent-pm", { role: "pm", kind: "worker" })).toBeNull();
    expect(workerKind("master", { kind: "worker" })).toBeNull();
  });

  test("migration is idempotent and leaves owner-facing agents visible", () => {
    const agents = {
      "agent-task-a": {},
      "agent-review": { task: "T68", parent: "agent-pm" },
      "agent-pm": { role: "pm" },
      "agent-codex": { task: "T68", parent: "agent-pm" },
    };
    expect(markWorkerKinds(agents)).toBe(2);
    expect(markWorkerKinds(agents)).toBe(0);
    expect(agents["agent-task-a"]).toEqual({ kind: "worker" });
    expect(agents["agent-pm"]).toEqual({ role: "pm" });
  });

  test("default history search hides current and removed task workers", () => {
    expect(visibleInDefaultSearch("agent-review", { kind: "worker" })).toBe(false);
    expect(visibleInDefaultSearch("agent-review", undefined, true)).toBe(false);
    expect(visibleInDefaultSearch("agent-task-old")).toBe(false);
    expect(visibleInDefaultSearch("agent-pm")).toBe(true);
  });
});
