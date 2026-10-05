import { describe, expect, test } from "bun:test";
import { markWorkerKinds, setWorkerKind, visibleInDefaultSearch, workerKind } from "../src/lib/worker-kind.js";

describe("worker registry kind", () => {
  test("task labels alone leave long-lived agents visible; explicit worker evidence tags only workers", () => {
    expect(workerKind("agent-build", { task: "T68" })).toBeNull();
    expect(workerKind("agent-build", { task: "T68", parent: "agent-pm" })).toBeNull();
    for (const name of ["agent-task-t68", "agent-rv-x", "agent-review-x", "agent-cv-x", "agent-lend-x", "agent-build-once", "agent-build-local"]) {
      expect(workerKind(name, {})).toBeNull();
      expect(workerKind(name, { kind: "worker" })).toBe("worker");
    }
    expect(workerKind("agent-review", { role: "dispatcher" })).toBeNull();
    expect(workerKind("agent-review", { role: "executor" })).toBeNull();
    expect(workerKind("agent-codex", { task: "T68", parent: "agent-pm" })).toBeNull();
    expect(workerKind("agent-pm", { role: "pm", kind: "worker" })).toBeNull();
    expect(workerKind("master", { kind: "worker" })).toBeNull();
  });

  test("registry normalization never invents a worker binding from names or roles", () => {
    const agents = {
      "agent-task-a": {},
      "agent-review": { role: "executor" },
      "agent-pm": { role: "pm" },
      "agent-codex": { task: "T68", parent: "agent-pm" },
    };
    expect(markWorkerKinds(agents)).toBe(0);
    expect(markWorkerKinds(agents)).toBe(0);
    expect(agents["agent-task-a"]).toEqual({});
    expect(agents["agent-pm"]).toEqual({ role: "pm" });
  });

  test("owner main override survives every registry save and explicit scheduler tag uses one setter", () => {
    const agents = { "agent-task-a": { task: "T1" } as { task: string; kind?: "worker" | "main" },
      "agent-review-t68": {} as { kind?: "worker" | "main" } };
    expect(markWorkerKinds(agents)).toBe(0);
    expect(setWorkerKind(agents, "agent-task-a", "main")).toBe(true);
    expect(markWorkerKinds(agents)).toBe(0);
    expect(agents["agent-task-a"].kind).toBe("main");
    expect(setWorkerKind(agents, "agent-task-a", "worker")).toBe(true);
    expect(agents["agent-task-a"].kind).toBe("main");
    expect(visibleInDefaultSearch("agent-task-a", agents["agent-task-a"])).toBe(true);
    expect(setWorkerKind(agents, "agent-review-t68", "worker")).toBe(true);
    expect(markWorkerKinds(agents)).toBe(0);
    expect(agents["agent-review-t68"].kind).toBe("worker");
  });

  test("default history search uses current or archived labels, never names", () => {
    expect(visibleInDefaultSearch("agent-review", { kind: "worker" })).toBe(false);
    expect(visibleInDefaultSearch("agent-review", undefined, true)).toBe(false);
    expect(visibleInDefaultSearch("agent-task-old")).toBe(true);
    expect(visibleInDefaultSearch("agent-rv-old")).toBe(true);
    expect(visibleInDefaultSearch("agent-pm")).toBe(true);
  });

  test("master, PM roles and supplied meta PM identities defeat stale worker tags", () => {
    const pms = ["project-pm"];
    for (const name of ["master", "agent-master", "codex", "agent-codex", "agent-project-pm"]) {
      const agents = { [name]: { kind: "worker" as "worker" | "main" | undefined } };
      expect(workerKind(name, agents[name], pms)).toBeNull();
      expect(setWorkerKind(agents, name, "worker", pms)).toBe(false);
      expect(markWorkerKinds(agents, pms)).toBe(1);
      expect(markWorkerKinds(agents, pms)).toBe(0);
      expect(agents[name].kind).toBeUndefined();
    }
    const agents = { "agent-pm": { role: "pm", kind: "worker" as const } };
    expect(setWorkerKind(agents, "agent-pm", "worker")).toBe(false);
    expect(markWorkerKinds(agents)).toBe(1);
    expect(workerKind("agent-project-pm", { kind: "main" }, pms)).toBe("main");
  });
});
