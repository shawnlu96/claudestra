/**
 * i28-Q1 `manager borrow set --keep-unset`（网页分配表 PUT 用）：没带的旗标在 lend.json 写锁里沿用该 peer 现有条目——
 * 改一格不会把 write 角色、档位、项目、上限冲回缺省（验收线 7）。不带 --keep-unset 的老语义不变（不带 = 回缺省）。
 * 现有条目里已失效的项目不沿用；没有现有条目时按 CLI 缺省（项目必填）。临时 CLAUDESTRA_STATE_DIR 里跑子进程。
 */
import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

describe("manager borrow set --keep-unset", () => {
  const state = mkdtempSync(join(tmpdir(), "lend-keep-"));
  writeFileSync(join(state, "registry.json"), JSON.stringify({ socket: "", agents: { "agent-exec": { channelId: "222", status: "active" } } }));
  writeFileSync(join(state, "peers.json"), JSON.stringify({ httpPeers: [
    { name: "team-a", fp: "aaaa-bbbb-cccc-dddd", addedAt: "" }, { name: "team-b", fp: "bbbb-cccc-dddd-eeee", addedAt: "" }], pendingInvites: [] }));
  for (const d of ["orch", "side"]) mkdirSync(join(state, d));
  const projects = (ids: string[]) => writeFileSync(join(state, "projects.json"), JSON.stringify({ projects: ids.map((id) => ({ id, name: id, dirs: [join(state, id)], createdAt: "" })) }));
  projects(["orch", "side"]);
  const manager = join(import.meta.dir, "../src/manager.ts");
  const run = (args: string[], channel?: string) => {
    const env: Record<string, string | undefined> = { ...process.env, CLAUDESTRA_STATE_DIR: state, DISCORD_CHANNEL_ID: channel };
    if (!channel) delete env.DISCORD_CHANNEL_ID;
    const r = Bun.spawnSync([process.execPath, manager, ...args], { env, stdout: "pipe", stderr: "pipe" });
    return JSON.parse(r.stdout.toString().trim().split("\n").at(-1)!) as Record<string, any>;
  };
  const entry = (peer: string) => JSON.parse(readFileSync(join(state, "lend.json"), "utf8")).borrow.find((e: { peer: string }) => e.peer === peer);

  test("只改上限 / 只改档位 / 只改角色 / 只改项目：别的字段都留着", () => {
    expect(run(["borrow", "set", "team-a", "--projects", "orch,side", "--roles", "review,write", "--max-open", "12", "--priority", "first"])).toMatchObject({ ok: true });
    const full = { peer: "team-a", fp: "aaaa-bbbb-cccc-dddd", projects: ["orch", "side"], roles: ["review", "write"], maxOpen: 12, priority: "first" };
    expect(entry("team-a")).toEqual(full);
    expect(run(["borrow", "set", "--keep-unset", "--max-open=5", "--", "team-a"])).toMatchObject({ ok: true });
    expect(entry("team-a")).toEqual({ ...full, maxOpen: 5 });
    expect(run(["borrow", "set", "--keep-unset", "--priority=low", "--", "team-a"])).toMatchObject({ ok: true });
    expect(entry("team-a")).toEqual({ ...full, maxOpen: 5, priority: "low" });
    expect(run(["borrow", "set", "--keep-unset", "--roles=review", "--", "team-a"])).toMatchObject({ ok: true });
    expect(entry("team-a")).toEqual({ ...full, maxOpen: 5, priority: "low", roles: ["review"] });
    expect(run(["borrow", "set", "--keep-unset", "--projects=side", "--", "team-a"])).toMatchObject({ ok: true });
    expect(entry("team-a")).toEqual({ ...full, maxOpen: 5, priority: "low", roles: ["review"], projects: ["side"] });
  }, 60_000);

  test("不带 --keep-unset：老语义，没带的回缺省（角色 review、档位不写、上限缺省）", () => {
    run(["borrow", "set", "team-a", "--projects", "orch", "--roles", "review,write", "--max-open", "9", "--priority", "first"]);
    expect(run(["borrow", "set", "team-a", "--projects", "orch"])).toMatchObject({ ok: true });
    const e = entry("team-a");
    expect(e.roles).toEqual(["review"]);
    expect(e).not.toHaveProperty("priority");
    expect(e.maxOpen).not.toBe(9);
  }, 60_000);

  test("没有现有条目：项目必填（照 CLI 缺省拒）；带了项目就按缺省补其余", () => {
    expect(run(["borrow", "set", "--keep-unset", "--priority=first", "--", "team-b"])).toMatchObject({ ok: false, error: expect.stringContaining("--projects") });
    expect(run(["borrow", "set", "--keep-unset", "--projects=orch", "--priority=first", "--", "team-b"])).toMatchObject({ ok: true });
    expect(entry("team-b")).toMatchObject({ projects: ["orch"], roles: ["review"], priority: "first" });
  }, 60_000);

  test("现有条目里已删掉的项目不沿用：改档位照样成，项目只剩还在的", () => {
    run(["borrow", "set", "team-a", "--projects", "orch,side", "--priority", "first"]);
    projects(["orch"]);
    try {
      expect(run(["borrow", "set", "--keep-unset", "--priority=low", "--", "team-a"])).toMatchObject({ ok: true });
      expect(entry("team-a")).toMatchObject({ projects: ["orch"], priority: "low" });
    } finally {
      projects(["orch", "side"]);
    }
  }, 60_000);

  test("准入不变：执行者（有频道号）拒；坏档位拒且不改文件", () => {
    run(["borrow", "set", "team-a", "--projects", "orch", "--priority", "first"]);
    const before = readFileSync(join(state, "lend.json"), "utf8");
    expect(run(["borrow", "set", "--keep-unset", "--priority=low", "--", "team-a"], "222")).toMatchObject({ ok: false, code: "forbidden" });
    expect(run(["borrow", "set", "--keep-unset", "--priority=urgent", "--", "team-a"])).toMatchObject({ ok: false });
    expect(readFileSync(join(state, "lend.json"), "utf8")).toBe(before);
  }, 60_000);
});
