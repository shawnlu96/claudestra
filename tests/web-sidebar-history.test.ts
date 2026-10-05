import { describe, expect, test } from "bun:test";
import { entryMembers, filterAndRankWorkers } from "@/features/chat/sidebar-entries";
import { buildSidebarDirectory, DIRECTORY_FOLD_KEYS, isHistoryAgent } from "@/features/chat/sidebar-history";
import type { AgentSession } from "@/features/chat/type";

const NOW = 1_800_000_000_000;
const ag = (name: string, p: Partial<AgentSession> = {}): AgentSession =>
  ({ name, displayName: name, purpose: "", status: "active", lastActivityTs: NOW - 1000, ...p }) as AgentSession;
const directory = (list: AgentSession[], master?: string) => buildSidebarDirectory(list, new Map(), master);
const names = (xs: AgentSession[]) => xs.map((a) => a.name);
const live = (list: AgentSession[]) => directory(list).activeEntries.flatMap(entryMembers);

describe("live sidebar directory", () => {
  test("status overrides activity, busy flags, role and name", () => {
    for (const extra of [{}, { busy: true }, { pinnedMaster: true }, { lastActivityTs: null }]) {
      expect(isHistoryAgent(ag("review-done", { status: "stopped", ...extra }))).toBe(true);
    }
    const list = [ag("just-stopped", { status: "stopped", lastActivityTs: NOW - 60_000 }),
      ag("review-idle", { lastActivityTs: NOW - 3 * 86400_000, busy: false }),
      ag("ancient-live", { lastActivityTs: NOW - 40 * 86400_000 }), ag("new", { status: "creating", lastActivityTs: null })];
    expect(names(live(list))).toEqual(["review-idle", "ancient-live", "new"]);
    expect(directory(list).historyCount).toBe(1);
  });
  test("multiple all-stopped projects and a solo stopped team disappear from the default directory", () => {
    const list = [ag("pm", { status: "stopped", projectId: "p" }),
      ag("review", { status: "stopped", parent: "pm", projectId: "p" }),
      ag("other", { status: "stopped", projectId: "q" })];
    const d = directory(list);
    expect(d.activeEntries).toEqual([]);
    expect(d.underMaster).toEqual([]);
    expect(d.historyCount).toBe(3);
    expect(names(d.historyEntries.flatMap(entryMembers))).toEqual(["pm", "review", "other"]);
  });
  test("dead parent with live child promotes the child into its own project and excludes parent from counts", () => {
    const list = [ag("pm", { status: "stopped", projectId: "dead" }),
      ag("child", { parent: "pm", projectId: "live" }), ag("dev", { projectId: "live" })];
    const d = directory(list);
    expect(d.activeEntries).toHaveLength(1);
    const e = d.activeEntries[0];
    expect(e.kind).toBe("group");
    if (e.kind !== "group") throw new Error("expected group");
    expect(e.id).toBe("live");
    expect(names(e.items)).toEqual(["child", "dev"]);
    expect(e.nodes.map((n) => n.a.name)).toEqual(["child", "dev"]);
    expect(d.historyCount).toBe(1);
  });
  test("active PM counts only live children; stopped master children go to history", () => {
    const list = [ag("pm", { projectId: "p" }), ag("kid", { parent: "pm", projectId: "p" }),
      ag("done", { parent: "pm", status: "stopped", projectId: "p" }), ag("dev", { projectId: "p" }),
      ag("master-live", { parent: "boss" }), ag("master-done", { parent: "boss", status: "stopped" })];
    const d = directory(list, "boss");
    expect(names(d.underMaster)).toEqual(["master-live"]);
    expect(names(d.activeEntries.flatMap(entryMembers))).toEqual(["pm", "kid", "dev"]);
    expect(d.historyCount).toBe(2);
    expect(names(d.historyEntries.flatMap(entryMembers))).toEqual(["done", "master-done"]);
  });
  test("search finds stopped records without history expansion", () => {
    const stopped = ag("review-done", { status: "stopped" });
    expect(names(filterAndRankWorkers([stopped], "review-done", new Set()))).toEqual(["review-done"]);
  });
  test("active → stopped → active refresh is pure and preserves record metadata", () => {
    const a = ag("worker", { parent: "gone", projectId: "p" });
    for (const status of ["active", "stopped", "active"] as const) {
      const list = [{ ...a, status }];
      const before = JSON.stringify(list);
      expect(live(list).length).toBe(status === "stopped" ? 0 : 1);
      expect(directory(list).historyCount).toBe(status === "stopped" ? 1 : 0);
      expect(JSON.stringify(list)).toBe(before);
    }
  });
});

describe("directory fold namespaces", () => {
  test("active keeps the original keys; history has its own, distinct ones", () => {
    expect(DIRECTORY_FOLD_KEYS.active).toMatchObject({ projects: "cstra_proj_collapsed", teams: "cstra_team_collapsed" });
    const keys = [...Object.values(DIRECTORY_FOLD_KEYS.active), ...Object.values(DIRECTORY_FOLD_KEYS.history)];
    expect(new Set(keys).size).toBe(8);
  });
});
