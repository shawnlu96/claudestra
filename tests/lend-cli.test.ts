/** manager lend / borrow 与 project-edit --personal 的接线（临时 CLAUDESTRA_STATE_DIR 里跑子进程；规则本身见 tests/lend-config.test.ts） */
import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

describe("manager lend / borrow 接线", () => {
  const state = mkdtempSync(join(tmpdir(), "lend-cli-"));
  writeFileSync(join(state, "registry.json"), JSON.stringify({ socket: "", agents: { "agent-exec": { channelId: "222", status: "active" } } }));
  writeFileSync(join(state, "peers.json"), JSON.stringify({ httpPeers: [{ name: "team-a", fp: "aaaa-bbbb-cccc-dddd", addedAt: "" }], pendingInvites: [] }));
  writeFileSync(join(state, "projects.json"), JSON.stringify({ projects: [
    { id: "orch", name: "orch", dirs: ["/no/such/orch"], createdAt: "" },
    { id: "diary", name: "diary", dirs: ["/no/such/diary"], createdAt: "" },
  ] }));
  const manager = join(import.meta.dir, "../src/manager.ts");
  const run = (args: string[], channel?: string) => {
    const env: Record<string, string | undefined> = { ...process.env, CLAUDESTRA_STATE_DIR: state, DISCORD_CHANNEL_ID: channel };
    if (!channel) delete env.DISCORD_CHANNEL_ID;
    const r = Bun.spawnSync([process.execPath, manager, ...args], { env, stdout: "pipe", stderr: "pipe" });
    return JSON.parse(r.stdout.toString().trim().split("\n").at(-1)!) as Record<string, any>;
  };
  const file = () => JSON.parse(readFileSync(join(state, "lend.json"), "utf8"));

  test("缺省关；set 只认联系人、执行者被拒；off 只关总开关", () => {
    expect(run(["lend", "status"])).toMatchObject({ ok: true, file: "missing", enabled: false, lending: false });
    expect(run(["lend", "set", "stranger", "--codex", "2", "--repos", "shawnlu96/claudestra"])).toMatchObject({ ok: false, error: expect.stringContaining("不在联系人里") });
    expect(run(["lend", "set", "team-a", "--codex", "2", "--repos", "shawnlu96/claudestra"], "222")).toMatchObject({ ok: false, code: "forbidden" });
    expect(run(["lend", "set", "team-a", "--codex", "2", "--repos", "shawnlu96/claudestra", "--bogus", "1"])).toMatchObject({ ok: false });
    expect(run(["lend", "set", "aaaa-bbbb-cccc-dddd", "--codex", "2", "--repos", "shawnlu96/claudestra"])).toMatchObject({ ok: true, lend: { peer: "team-a" } });
    expect(file()).toMatchObject({ version: 1, enabled: true, lend: [{ peer: "team-a", fp: "aaaa-bbbb-cccc-dddd", confirm: "per-order" }], borrow: [] });
    expect(run(["lend", "status"])).toMatchObject({ ok: true, lending: true });
    expect(run(["lend", "off"])).toMatchObject({ ok: true });
    expect(file()).toMatchObject({ enabled: false, lend: [{ peer: "team-a" }] });
    expect(run(["lend", "off", "--peer", "team-a"])).toMatchObject({ ok: true });
    expect(file().lend).toEqual([]);
  }, 60_000);

  test("borrow 拒个人项目；取消个人项目标记只许 owner / master", () => {
    expect(run(["project-edit", "diary", "--personal", "on"])).toMatchObject({ ok: true, project: { personal: true } });
    expect(run(["borrow", "set", "team-a", "--projects", "diary"])).toMatchObject({ ok: false, error: expect.stringContaining("个人项目") });
    expect(run(["project-edit", "diary", "--personal", "off"], "222")).toMatchObject({ ok: false, code: "forbidden" });
    expect(run(["project-edit", "diary", "--personal", "maybe"])).toMatchObject({ ok: false });
    expect(run(["borrow", "set", "team-a", "--projects", "orch", "--max-open", "2"]))
      .toMatchObject({ ok: true, message: expect.stringContaining("PR 会发给对方机器上的 agent 审") });
    expect(run(["borrow", "status"])).toMatchObject({ ok: true, effective: [{ peer: "team-a", projects: ["orch"], maxOpen: 2 }] });
    expect(run(["borrow", "off"])).toMatchObject({ ok: true });
    expect(file().borrow).toEqual([]);
    writeFileSync(join(state, "lend.json"), "{oops");
    expect(run(["lend", "status"])).toMatchObject({ ok: true, file: "invalid", lending: false });
    expect(run(["lend", "set", "team-a", "--codex", "1", "--repos", "a/b"])).toMatchObject({ ok: false, error: expect.stringContaining("无效") });
  }, 60_000);
});
