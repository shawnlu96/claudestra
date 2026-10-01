import { describe, expect, test } from "bun:test";
import { existsSync, lstatSync, mkdirSync, renameSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { claudeTmpBlocker, claudeTmpDirectChild, claudeTmpDirFor, removeClaudeTmp } from "../src/lib/scheduler-retire-tmp.js";
import { SchedulerStopped } from "../src/lib/scheduler-maintenance.js";
import { readLiveAgents, type LiveAgent } from "../src/lib/scheduler-retire.js";
import { readJsonLenient } from "../src/lib/state-file.js";
import type { SchedulerSession } from "../src/lib/scheduler-sessions.js";
import { scratchFixture } from "./scheduler-retire-tmp-fixture.js";

const cwd = "/work/card.one";
const row: SchedulerSession = { taskId: "T1", role: "author", agent: "agent-task-t1", sessionId: "s1", family: "claude", transport: "tmux",
  state: "retired", createIntentId: "c1", retireIntentId: "retire:T1", archiveReceipt: "archive", killReceipt: "stopped", createdAt: 1, updatedAt: 2 };
const agent = (fields: Partial<LiveAgent> = {}): LiveAgent => ({ name: row.agent, sessionId: "s1", cwd, status: "stopped", pending: false, window: false, ...fields });

describe("Claude scratch path and live-owner safety", () => {
  test("slug is pure and replaces slash/dot only, including a cwd that no longer exists", () => {
    expect(claudeTmpDirFor("/Users/a/.state/card_one")).toBe("-Users-a--state-card_one");
    expect(claudeTmpDirFor("/work/你好 card")).toBe("-work-你好 card");
    expect(() => claudeTmpDirFor("../elsewhere")).toThrow();
    expect(() => claudeTmpDirFor("/")).toThrow();
    expect(() => claudeTmpDirFor("/work/\0bad")).toThrow();
  });
  test("only a canonical immediate child is inside the boundary", () => {
    const root = "/tmp/claude-501";
    expect(claudeTmpDirectChild(root, `${root}/-work-card`)).toBe(true);
    for (const p of [root, "/", "/tmp/elsewhere", `${root}-other/child`, `${root}/child/grandchild`, `${root}/../escape`, `${root}/child/..`]) {
      expect(claudeTmpDirectChild(root, p)).toBe(false);
    }
  });
  test("only terminal stages with confirmed local stops are eligible", () => {
    for (const stage of ["verified", "done", "cancelled"] as const) expect(claudeTmpBlocker(stage, row, cwd, [agent()])).toBeNull();
    for (const stage of ["spec", "restate", "build", "review", "fix", "merge", "live", "blocked"] as const) {
      expect(claudeTmpBlocker(stage, row, cwd, [agent()])).not.toBeNull();
    }
    for (const change of [{ transport: "peer" }, { state: "active" }, { killReceipt: null }] as const) {
      expect(claudeTmpBlocker("verified", { ...row, ...change }, cwd, [])).not.toBeNull();
    }
  });
  test("same-slug live agents, PM, stopped other owners, and unknown cwd all block", () => {
    for (const other of [agent({ status: "active" }), agent({ pending: true }), agent({ window: true }),
      agent({ sessionId: "new-session" }), agent({ kind: "main" }), agent({ role: "pm" }), agent({ cwd: "/old/manual/card" }),
      agent({ name: "agent-other", cwd: "/work/card-one", status: "active" }), agent({ name: "agent-master" }),
      agent({ name: "case-alias", cwd: "/WORK/card.one", status: "active" }),
      agent({ name: "orphan", cwd: undefined, status: undefined, window: true })]) {
      expect(claudeTmpBlocker("verified", row, cwd, [other])).not.toBeNull();
    }
    expect(claudeTmpBlocker("verified", row, cwd, [agent({ name: "unrelated", cwd: "/work/other", status: "active" })])).toBeNull();
  });
  test("unreadable or malformed registry never reuses a last-good stopped/empty snapshot", async () => {
    const f = scratchFixture(), path = join(f.temp, "registry.json");
    writeFileSync(path, JSON.stringify({ agents: {} }));
    await readJsonLenient(path, null);
    expect(await readLiveAgents(path, async () => [])).toEqual([]);
    for (const bad of ["{", '{"agents":[]}', '{"agents":{"live":null}}', '{"agents":{"live":7}}']) {
      writeFileSync(path, bad);
      await expect(readLiveAgents(path, async () => [])).rejects.toThrow("registry 读不出来");
    }
  });
});

describe("Claude scratch filesystem boundary", () => {
  test("deletes exactly one directory; preserves root, siblings, and other uid roots", async () => {
    const f = scratchFixture(), dir = f.populate(cwd), sibling = f.populate("/work/other");
    const otherUser = join(f.temp, "claude-678", "keep");
    mkdirSync(otherUser, { recursive: true });
    expect(await removeClaudeTmp(cwd, () => {}, f.fs)).toEqual({ ok: true, detail: "目录已删除" });
    expect(f.calls).toEqual([dir]);
    expect(existsSync(dir)).toBe(false);
    for (const keep of [f.root, sibling, otherUser]) expect(existsSync(keep)).toBe(true);
    expect((await removeClaudeTmp(cwd, () => {}, f.fs)).ok).toBe(true);
    expect(f.calls).toHaveLength(1);
  });
  test("missing root and missing child are successful without invoking rm", async () => {
    const f = scratchFixture();
    expect((await removeClaudeTmp(cwd, () => {}, f.fs)).ok).toBe(true);
    mkdirSync(f.root);
    expect((await removeClaudeTmp(cwd, () => {}, f.fs)).ok).toBe(true);
    expect(f.calls).toEqual([]);
  });
  test("OS tmp symlink is canonicalized before constructing the uid root", async () => {
    const f = scratchFixture(), dir = f.populate(cwd), alias = join(f.temp, "os-alias");
    symlinkSync(f.temp, alias);
    f.fs.tmpdir = () => alias;
    expect((await removeClaudeTmp(cwd, () => {}, f.fs)).ok).toBe(true);
    expect(f.calls).toEqual([dir]);
  });
  test.each(["root", "child", "nested", "dangling"])("refuses %s symlinks without unlinking them or touching their destination", async (kind) => {
    const f = scratchFixture(), outside = join(f.temp, "outside");
    mkdirSync(outside); writeFileSync(join(outside, "keep"), "keep");
    let link: string;
    if (kind === "root") link = f.root;
    else if (kind === "nested") link = join(f.populate(cwd), "session-id", "link");
    else { mkdirSync(f.root); link = f.dirFor(cwd); }
    symlinkSync(kind === "dangling" ? join(outside, "missing") : outside, link);
    expect((await removeClaudeTmp(cwd, () => {}, f.fs)).ok).toBe(false);
    expect(lstatSync(link).isSymbolicLink()).toBe(true);
    expect(existsSync(join(outside, "keep"))).toBe(true);
    expect(f.calls).toEqual([]);
  });
  test("realpath escape is refused even when lstat reports a directory", async () => {
    const f = scratchFixture(), dir = f.populate(cwd), real = f.fs.realpath;
    f.fs.realpath = ((p: string) => p === dir ? join(f.temp, "outside") : real(p)) as typeof real;
    expect((await removeClaudeTmp(cwd, () => {}, f.fs)).ok).toBe(false);
    expect(f.calls).toEqual([]);
  });
  test("root replaced by a symlink during the walk is caught before rm", async () => {
    const f = scratchFixture(), dir = f.populate(cwd), moved = join(f.temp, "moved"), read = f.fs.readdir;
    f.fs.readdir = ((p: string) => {
      const entries = read(p);
      if (p.endsWith("scratchpad")) { renameSync(f.root, moved); symlinkSync(moved, f.root); }
      return entries;
    }) as typeof read;
    expect((await removeClaudeTmp(cwd, () => {}, f.fs)).ok).toBe(false);
    expect(existsSync(dir)).toBe(true);
    expect(f.calls).toEqual([]);
  });
  test("permission failure is returned once, and a lost lease never becomes a cleanup failure", async () => {
    const f = scratchFixture(); f.populate(cwd);
    let calls = 0;
    f.fs.rm = async () => { calls++; throw Object.assign(new Error("permission denied"), { code: "EACCES" }); };
    expect(await removeClaudeTmp(cwd, () => {}, f.fs)).toEqual({ ok: false, detail: "permission denied" });
    expect(calls).toBe(1);
    await expect(removeClaudeTmp(cwd, () => { throw new SchedulerStopped("lost"); }, f.fs)).rejects.toThrow("lost");
    expect(calls).toBe(1);
  });
});
