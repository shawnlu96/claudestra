import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { testChildEnv } from "./test-env";
import { grantArgv } from "../src/bridge/local-api/lend-grant.js";
import { formDefaults, grantBody, type GrantView } from "../web/features/lend/lend-model";
const root = mkdtempSync(join(tmpdir(), "cl3-grant-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));
const g: GrantView = { peer: "test-peer", repos: ["demo/repo"], families: { codex: 7, claude: 2 }, roles: ["review", "write"],
  ordersPerDay: 200, until: null, grantedAt: null, paused: null, problem: null };

test("Claude edits carry only changed slots; untouched fields go through locked keep-unset", () => {
  const initial = formDefaults(7, [{ name: g.peer }], g);
  expect(initial.claude).toBe(2);
  const body = grantBody({ ...initial, claude: 3 }, 7, initial);
  expect(body).not.toHaveProperty("codex");
  expect(body).not.toHaveProperty("roles");
  const argv = grantArgv(body);
  expect(argv).toContain("--claude=3");
  expect(argv).toContain("--keep-unset=codex,roles,codex-model,codex-effort");
  expect(grantArgv(grantBody(initial, 7, initial))).toContain("--keep-unset=codex,claude,roles,codex-model,codex-effort");
  expect(grantArgv({ ...body, claude: {} })).toBe("claude 要是数字");
});

test("real CLI retains Codex/roles/model/effort while changing Claude; legacy CLI still resets defaults", () => {
  writeFileSync(join(root, "registry.json"), JSON.stringify({ socket: "", agents: {} }));
  writeFileSync(join(root, "peers.json"), JSON.stringify({ httpPeers: [{ name: g.peer, fp: "aaaa-bbbb-cccc-dddd", addedAt: "" }], pendingInvites: [] }));
  writeFileSync(join(root, "projects.json"), JSON.stringify({ projects: [] }));
  const run = (args: string[]) => {
    const r = Bun.spawnSync([process.execPath, "--no-env-file", join(import.meta.dir, "../src/manager.ts"), ...args], {
      env: testChildEnv({ PATH: "/usr/bin:/bin", HOME: root, CLAUDESTRA_STATE_DIR: root, CLAUDESTRA_RUNTIME_DIR: join(root, "runtime") }), stdout: "pipe", stderr: "pipe" });
    expect(r.exitCode).toBe(0);
    return JSON.parse(r.stdout.toString().trim().split("\n").at(-1)!);
  };
  const args = ["lend", "grant", g.peer, "--repos=demo/repo", "--until=3d"];
  expect(run([...args, "--codex=7", "--claude=2", "--roles=review,write", "--codex-model=gpt-6-astra", "--codex-effort=xhigh"]).ok).toBe(true);
  const initial = formDefaults(7, [{ name: g.peer }], g);
  const argv = grantArgv(grantBody({ ...initial, claude: 3 }, 7, initial));
  expect(Array.isArray(argv)).toBe(true);
  expect(run(argv as string[]).ok).toBe(true);
  const entry = () => JSON.parse(readFileSync(join(root, "lend.json"), "utf8")).lend[0];
  expect(entry()).toMatchObject({ families: { codex: 7, claude: 3 }, roles: ["review", "write"], codexModel: "gpt-6-astra", codexEffort: "xhigh" });
  expect(run([...args, "--claude=0", "--keep-unset=codex,roles,codex-model,codex-effort"]).ok).toBe(true);
  expect(entry().families.codex).toBe(7);
  expect(entry().families.claude ?? 0).toBe(0);
  expect(run(args).ok).toBe(true);
  expect(entry().families).toEqual({ codex: 5 });
  expect(entry().roles).toEqual(["review", "write"]);
  expect(entry()).not.toHaveProperty("codexModel");
  expect(entry()).not.toHaveProperty("codexEffort");
}, 60_000);

test("peer switch resets displayed slots and baseline; new peer submits explicit defaults", async () => {
  const { switchClaudeGrantPeer } = await import("../web/features/lend/lend-model");
  const b = { ...g, peer: "B", families: { codex: 1, claude: 1 } };
  const initial = formDefaults(7, [{ name: g.peer }], g);
  const next = switchClaudeGrantPeer(initial, "B", [g, b], 7);
  expect(next.form).toMatchObject({ peer: "B", codex: 1, claude: 1 });
  expect(next.baseline).toMatchObject({ peer: "B", codex: 1, claude: 1 });
  const unchanged = grantBody(next.form, 7, next.baseline);
  expect(unchanged).not.toHaveProperty("codex");
  expect(unchanged).not.toHaveProperty("claude");
  const changed = grantBody({ ...next.form, codex: 3, claude: 2 }, 7, next.baseline);
  expect(changed).toMatchObject({ peer: "B", codex: 3, claude: 2 });
  expect(grantArgv(changed)).toEqual(expect.arrayContaining(["--codex=3", "--claude=2"]));
  const fresh = switchClaudeGrantPeer(next.form, "C", [g, b], 7);
  expect(fresh.form).toMatchObject({ peer: "C", codex: 5, claude: 0 });
  expect(fresh.baseline).toBeUndefined();
  expect(grantBody(fresh.form, 7, fresh.baseline)).toMatchObject({ peer: "C", codex: 5, claude: 0 });
});
