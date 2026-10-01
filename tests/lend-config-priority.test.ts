/**
 * i28-W9 borrow entry `priority`: optional, one of first / balance / low / off; anything else makes the whole file invalid
 * (fail-closed, as every other field); effectiveLend carries it through to the scheduler. `manager borrow set --priority`
 * writes it (child process in a temporary state dir, as tests/lend-cli.test.ts).
 */
import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { lendFileProblem, type LendFile } from "../src/lib/lend-config.js";

const file = (priority?: unknown): LendFile =>
  ({ version: 2, enabled: false, lend: [], borrow: [{ peer: "mate", projects: ["orch"], roles: ["review", "write"], maxOpen: 3, ...(priority === undefined ? {} : { priority }) }] }) as LendFile;

describe("borrow.priority", () => {
  test("absent or one of the four tiers: valid", () => {
    expect(lendFileProblem(file())).toBeNull();
    for (const p of ["first", "balance", "low", "off"]) expect(lendFileProblem(file(p))).toBeNull();
  });

  test("anything else: the whole file is invalid", () => {
    for (const p of ["high", "", 1, null]) expect(lendFileProblem(file(p))).toContain("priority");
  });
});

describe("manager borrow set --priority", () => {
  const state = mkdtempSync(join(tmpdir(), "lend-priority-"));
  writeFileSync(join(state, "registry.json"), JSON.stringify({ socket: "", agents: {} }));
  writeFileSync(join(state, "peers.json"), JSON.stringify({ httpPeers: [{ name: "team-a", fp: "aaaa-bbbb-cccc-dddd", addedAt: "" }], pendingInvites: [] }));
  mkdirSync(join(state, "orch"));
  writeFileSync(join(state, "projects.json"), JSON.stringify({ projects: [{ id: "orch", name: "orch", dirs: [join(state, "orch")], createdAt: "" }] }));
  const manager = join(import.meta.dir, "../src/manager.ts");
  const run = (args: string[]) => {
    const env: Record<string, string | undefined> = { ...process.env, CLAUDESTRA_STATE_DIR: state };
    delete env.DISCORD_CHANNEL_ID;
    const r = Bun.spawnSync([process.execPath, manager, ...args], { env, stdout: "pipe", stderr: "pipe" });
    return JSON.parse(r.stdout.toString().trim().split("\n").at(-1)!) as Record<string, any>;
  };
  const borrow = () => JSON.parse(readFileSync(join(state, "lend.json"), "utf8")).borrow;

  test("writes the tier, refuses an unknown one, and setting again without it goes back to balance", () => {
    const set = (...extra: string[]) => run(["borrow", "set", "team-a", "--projects", "orch", "--roles", "review,write", ...extra]);
    expect(set("--priority", "first")).toMatchObject({ ok: true, borrow: { peer: "team-a", priority: "first" }, message: expect.stringContaining("槽池档位 first") });
    expect(borrow()).toEqual([expect.objectContaining({ peer: "team-a", priority: "first", roles: ["review", "write"] })]);
    expect(run(["borrow", "status"])).toMatchObject({ ok: true, message: expect.stringContaining("档位 first"), effective: [expect.objectContaining({ priority: "first" })] });
    expect(set("--priority", "urgent")).toMatchObject({ ok: false, error: expect.stringContaining("--priority") });
    expect(borrow()[0].priority).toBe("first");
    expect(set()).toMatchObject({ ok: true });
    expect(borrow()[0]).not.toHaveProperty("priority");
  });
});
