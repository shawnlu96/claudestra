import { expect, test } from "bun:test";
import { shouldRemoveNotification, type CleanupContext, type NotificationData } from "@/lib/push/unread-cleanup";
import { entriesUnread, memberUnread } from "@/features/chat/sidebar-unread";
import type { AgentSession } from "@/features/chat/type";

const context = (over: Partial<CleanupContext> = {}): CleanupContext => ({
  now: 30 * 3600_000, reads: { read: 100 }, native: false, machineCount: 1, fp: "here",
  openAsks: new Set(["open"]), agents: new Set(["live", "__master__"]), ...over,
});

test("[验收线 4] priority is watermark, ask, age, absent-agent; unknown data cannot delete", () => {
  const cases: Array<[NotificationData, boolean]> = [
    [{ agent: "read", ts: 100, url: "/chat?ask=open", fp: "away" }, true],
    [{ agent: "gone", ts: 1, url: "/chat?ask=open", fp: "here" }, false],
    [{ agent: "gone", url: "/chat?ask=done", fp: "here" }, true],
    [{ agent: "", ask: "open", ts: 1, fp: "here" }, false],
    [{ agent: "", ts: 1, fp: "away" }, true],
    [{ agent: "", ts: 6 * 3600_000, fp: "here" }, false],
    [{ agent: "gone", fp: "here" }, true],
    [{ agent: "agent-live", fp: "here" }, false],
    [{ agent: "master", fp: "here" }, false],
    [{ agent: "gone", fp: "away" }, false],
  ];
  for (const [data, dead] of cases) expect(shouldRemoveNotification(data, context())).toBe(dead);
  expect(shouldRemoveNotification({ agent: "gone", fp: "here" }, context({ agents: undefined }))).toBe(false);
  expect(shouldRemoveNotification({ agent: "gone", url: "/chat?ask=done", fp: "here" }, context({ openAsks: undefined }))).toBe(false);
});

test("[验收线 4] multi-machine native retains ask/agent notifications, age remains independent", () => {
  for (const machineCount of [0, 1, 2]) {
    const c = context({ native: true, machineCount });
    expect(shouldRemoveNotification({ agent: "gone" }, c)).toBe(machineCount <= 1);
    expect(shouldRemoveNotification({ url: "/chat?ask=done" }, c)).toBe(machineCount <= 1);
    expect(shouldRemoveNotification({ agent: "", ts: 1 }, c)).toBe(true);
  }
});

test("[验收线 6] groups/history include all members; dispatcher aggregate includes only supplied children", () => {
  const a = (name: string, unread?: number) => ({ name, unread }) as AgentSession;
  const lead = a("lead", 50), kids = [a("kid", 2), a("grandchild", 3)];
  expect(memberUnread(kids)).toBe(5);
  expect(entriesUnread([{ kind: "row", a: lead, children: kids }])).toBe(55);
  expect(entriesUnread([{ kind: "group", id: "p", items: [a("a", 1), a("b", 3)], nodes: [] }, { kind: "row", a: a("old", 1), children: [] }])).toBe(5);
  expect(memberUnread([a("none")])).toBe(0);
});

test("[验收线 4] missing or invalid age data and empty agent snapshots retain notifications", () => {
  for (const ts of [undefined, 0, -1, NaN, Infinity]) {
    expect(shouldRemoveNotification({ agent: "", ts }, context())).toBe(false);
  }
  expect(shouldRemoveNotification({ agent: "gone", fp: "here" }, context({ agents: new Set() }))).toBe(false);
});

test("[验收线 4] direct browser matches missing/empty fp while preserving foreign machine notifications", () => {
  for (const fp of [undefined, "", "direct-host", "away"]) {
    const c = context({ fp: null, directFp: "direct-host" });
    expect(shouldRemoveNotification({ agent: "gone", fp }, c)).toBe(fp !== "away");
    expect(shouldRemoveNotification({ url: "/chat?ask=done", fp }, c)).toBe(fp !== "away");
  }
  expect(shouldRemoveNotification({ agent: "gone", fp: "direct-host" }, context({ fp: "here", directFp: "direct-host" }))).toBe(false);
});
