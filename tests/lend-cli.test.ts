/** manager lend / borrow 与 project-edit --personal 的接线（临时 CLAUDESTRA_STATE_DIR 里跑子进程；规则本身见 tests/lend-config.test.ts） */
import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { acquireLock } from "../src/lib/file-lock.js";
import { tmpdir } from "node:os";
import { join } from "node:path";

describe("manager lend / borrow 接线", () => {
  const state = mkdtempSync(join(tmpdir(), "lend-cli-"));
  writeFileSync(join(state, "registry.json"), JSON.stringify({ socket: "", agents: { "agent-exec": { channelId: "222", status: "active" } } }));
  writeFileSync(join(state, "peers.json"), JSON.stringify({ httpPeers: [{ name: "team-a", fp: "aaaa-bbbb-cccc-dddd", addedAt: "" }], pendingInvites: [] }));
  // 目录要真实存在：解析不了的目录按个人项目处理
  for (const d of ["orch", "diary"]) mkdirSync(join(state, d));
  writeFileSync(join(state, "projects.json"), JSON.stringify({ projects: [
    { id: "orch", name: "orch", dirs: [join(state, "orch")], createdAt: "" },
    { id: "diary", name: "diary", dirs: [join(state, "diary")], createdAt: "" },
  ] }));
  const manager = join(import.meta.dir, "../src/manager.ts");
  const run = (args: string[], channel?: string) => {
    const env: Record<string, string | undefined> = { ...process.env, CLAUDESTRA_STATE_DIR: state, DISCORD_CHANNEL_ID: channel };
    if (!channel) delete env.DISCORD_CHANNEL_ID;
    const r = Bun.spawnSync([process.execPath, manager, ...args], { env, stdout: "pipe", stderr: "pipe" });
    return JSON.parse(r.stdout.toString().trim().split("\n").at(-1)!) as Record<string, any>;
  };
  const file = () => JSON.parse(readFileSync(join(state, "lend.json"), "utf8"));

  test("缺省关；grant 只认联系人、钉指纹、执行者被拒、到期时间必填且 ≤7 天、write 拒、--confirm 已退役；revoke 删条目", () => {
    const g = (...extra: string[]) => ["lend", "grant", "team-a", "--repos", "shawnlu96/claudestra", ...extra];
    expect(run(["lend", "status"])).toMatchObject({ ok: true, file: "missing", enabled: false, lending: false });
    expect(run(["lend", "grant", "stranger", "--repos", "shawnlu96/claudestra", "--until", "3d"])).toMatchObject({ ok: false, error: expect.stringContaining("不在联系人里") });
    expect(run(g("--until", "3d"), "222")).toMatchObject({ ok: false, code: "forbidden" });
    expect(run(g("--until", "3d", "--bogus", "1"))).toMatchObject({ ok: false });
    expect(run(g())).toMatchObject({ ok: false, error: expect.stringContaining("到期时间") });
    expect(run(g("--until", "8d"))).toMatchObject({ ok: false, error: expect.stringContaining("最长 7 天") });
    expect(run(g("--until", "2999-01-01T00:00:00Z"))).toMatchObject({ ok: false, error: expect.stringContaining("最长 7 天") });
    expect(run(g("--until", "3d", "--roles", "review,write"))).toMatchObject({ ok: false, error: expect.stringContaining("write") });
    expect(run(["lend", "set", "team-a", "--repos", "shawnlu96/claudestra", "--until", "3d", "--confirm", "auto"])).toMatchObject({ ok: false, error: expect.stringContaining("已退役") });
    expect(existsSync(join(state, "lend.json"))).toBe(false);
    const ok = run(["lend", "grant", "aaaa-bbbb-cccc-dddd", "--repos", "shawnlu96/claudestra", "--until", "3d"]);
    expect(ok).toMatchObject({ ok: true, warning: "这会让发起方的任务在你的用户下随时起 shell", lend: { peer: "team-a" } });
    expect(ok.message).toContain("这会让发起方的任务在你的用户下随时起 shell");
    expect(file()).toMatchObject({ version: 2, enabled: true, borrow: [],
      lend: [{ peer: "team-a", fp: "aaaa-bbbb-cccc-dddd", roles: ["review"], families: { codex: 5 }, ordersPerDay: 200 }] });
    const e = file().lend[0];
    expect(Date.parse(e.until) - Date.parse(e.grantedAt)).toBe(3 * 86_400_000);
    expect(run(["lend", "status"])).toMatchObject({ ok: true, lending: true });
    expect(run(["lend", "revoke", "--peer", "team-a"], "222")).toMatchObject({ ok: false, code: "forbidden" });
    expect(file().lend).toHaveLength(1);
    expect(run(["lend", "revoke", "--peer", "team-a"])).toMatchObject({ ok: true, message: expect.stringContaining("已收回") });
    expect(file().lend).toEqual([]);
    expect(run(g("--until", "12h"))).toMatchObject({ ok: true });
    expect(run(["lend", "revoke"])).toMatchObject({ ok: true });
    expect(file()).toMatchObject({ enabled: false, lend: [] });
  }, 60_000);

  test("v1 文件：照读、出借条目一律暂停（不生效）；再授权一次落成 v2，别的旧条目仍暂停", () => {
    const v1 = (peer: string, fp: string, confirm: string, until?: string) => ({ peer, fp, families: { codex: 2 }, roles: ["review"], repos: ["shawnlu96/claudestra"],
      quota: { ordersPerDay: 5, tokensPerDay: null }, confirm, ...(until ? { until } : {}) });
    writeFileSync(join(state, "peers.json"), JSON.stringify({ httpPeers: [{ name: "team-a", fp: "aaaa-bbbb-cccc-dddd", addedAt: "" },
      { name: "team-b", fp: "1111-2222-3333-4444", addedAt: "" }], pendingInvites: [] }));
    writeFileSync(join(state, "lend.json"), JSON.stringify({ version: 1, enabled: true, borrow: [],
      lend: [v1("team-a", "aaaa-bbbb-cccc-dddd", "per-order"), v1("team-b", "1111-2222-3333-4444", "auto", new Date(Date.now() + 86_400_000).toISOString())] }));
    const st = run(["lend", "status"]);
    expect(st).toMatchObject({ ok: true, file: "ok", lending: false, effective: [] });
    expect(st.dropped.join("\n")).toContain("重新授权");
    expect(file().version).toBe(1); // 只读不写
    expect(run(["lend", "grant", "team-a", "--repos", "shawnlu96/claudestra", "--until", "1d"])).toMatchObject({ ok: true });
    expect(file()).toMatchObject({ version: 2, lend: [{ peer: "team-a", grantedAt: expect.any(String) }, { peer: "team-b", paused: { reason: expect.any(String) } }] });
    expect(run(["lend", "status"])).toMatchObject({ lending: true, effective: [{ peer: "team-a" }] });
    unlinkSync(join(state, "lend.json"));
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
    expect(run(["lend", "grant", "team-a", "--repos", "a/b", "--until", "1d"])).toMatchObject({ ok: false, error: expect.stringContaining("无效") });
  }, 60_000);

  test("P1-4 等 lend 锁期间联系人被删：拿到锁后重核，拒写", async () => {
    unlinkSync(join(state, "lend.json")); // 上一条测试留下的是坏文件
    writeFileSync(join(state, "peers.json"), JSON.stringify({ httpPeers: [{ name: "team-a", fp: "aaaa-bbbb-cccc-dddd", addedAt: "" }], pendingInvites: [] }));
    const lock = await acquireLock(join(state, "lend.json.lock"), 0);
    const env: Record<string, string | undefined> = { ...process.env, CLAUDESTRA_STATE_DIR: state };
    delete env.DISCORD_CHANNEL_ID;
    const child = Bun.spawn([process.execPath, manager, "lend", "grant", "team-a", "--repos", "a/b", "--until", "1d"], { env, stdout: "pipe", stderr: "pipe" });
    await Bun.sleep(1500);
    writeFileSync(join(state, "peers.json"), JSON.stringify({ httpPeers: [], pendingInvites: [] }));
    lock?.release();
    await child.exited;
    const out = JSON.parse((await new Response(child.stdout).text()).trim().split("\n").at(-1)!);
    expect(out).toMatchObject({ ok: false, error: expect.stringContaining("不在联系人里") });
    expect(existsSync(join(state, "lend.json")) ? file().lend : []).toEqual([]);
  }, 60_000);
});
