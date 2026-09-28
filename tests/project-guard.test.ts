/**
 * src/manager/project-guard.ts：改项目目录只许 owner / master / 任一项目的 PM，其它 agent 和认不出的频道都拒绝；
 * 以及 manager 的 project-add / edit / merge 真的接上了目录校验与角色校验（临时状态目录里跑子进程）。
 */
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeLedger, openLedger } from "../src/lib/ledger-store.js";
import { setMeta } from "../src/lib/ledger-write.js";
import type { ProjectDef } from "../src/lib/projects.js";
import { projectWriterError } from "../src/manager/project-guard.js";
import { tempLedgerPath } from "./ledger-test-helpers.js";

const path = tempLedgerPath("project-guard-");
const db = openLedger(path);
setMeta(db, { actor: "owner" }, { project: "q", key: "pms", value: ["agent-pm"] });
afterAll(() => closeLedger(path));

const projects: ProjectDef[] = ["p", "q"].map((id) => ({ id, name: id, dirs: [`/${id}`], createdAt: "" }));
const agents = { "agent-pm": { channelId: "1" }, "agent-exec": { channelId: "2" }, "agent-codex": { channelId: "3" } };
const as = (channelId?: string, ledger = path) => projectWriterError({ channelId, controlChannelId: "9" }, agents, projects, ledger);

describe("projectWriterError", () => {
  test("owner（没有频道：终端 / bridge / 网页）、master（控制频道）、任一项目的 PM 放行", () => {
    expect(as(undefined)).toBeNull();
    expect(as("9")).toBeNull();
    expect(as("1")).toBeNull();
  });
  test("执行者、非台账 agent 拒绝，报错里写找谁；认不出的频道也拒绝", () => {
    expect(as("2")).toContain("agent-exec 不能改项目目录：改项目目录要找 PM 或 owner（网页 / master）");
    expect(as("3")).toContain("agent-codex 不能改项目目录");
    expect(as("777")).toContain("认不出身份");
  });
  test("台账库还没建：只剩 owner / master", () => {
    expect(as("1", "/no/such/ledger.sqlite")).toContain("不能改项目目录");
    expect(as(undefined, "/no/such/ledger.sqlite")).toBeNull();
  });
});

describe("manager project-* 接线（临时 CLAUDESTRA_STATE_DIR）", () => {
  const state = mkdtempSync(join(tmpdir(), "project-cmds-"));
  writeFileSync(join(state, "registry.json"), JSON.stringify({ socket: "", agents: { "agent-exec": { channelId: "222", status: "active" } } }));
  const manager = join(import.meta.dir, "../src/manager.ts");
  const run = (args: string[], channel?: string) => {
    const env: Record<string, string | undefined> = { ...process.env, CLAUDESTRA_STATE_DIR: state, DISCORD_CHANNEL_ID: channel };
    if (!channel) delete env.DISCORD_CHANNEL_ID;
    const r = Bun.spawnSync([process.execPath, manager, ...args], { env, stdout: "pipe", stderr: "pipe" });
    return JSON.parse(r.stdout.toString().trim().split("\n").at(-1)!) as Record<string, any>;
  };
  test("add 校验目录；执行者跑 add / edit --dirs / merge 被拒，edit 不带 --dirs 放行", () => {
    expect(run(["project-add", "aa", "--dirs", "/no/such/a"])).toMatchObject({ ok: true, project: { dirs: ["/no/such/a"] } });
    expect(run(["project-add", "bb", "--dirs", "/no/such/a/"])).toMatchObject({ ok: false, error: expect.stringContaining("已登记在项目 aa 下") });
    expect(run(["project-add", "cc", "--dirs", "rel/x"])).toMatchObject({ ok: false, error: expect.stringContaining("绝对路径") });
    expect(run(["project-add", "bb", "--dirs", "/no/such/b"])).toMatchObject({ ok: true });
    for (const args of [["project-add", "dd", "--dirs", "/no/such/d"], ["project-edit", "aa", "--dirs", "/no/such/z"], ["project-merge", "aa", "bb"]]) {
      expect(run(args, "222")).toMatchObject({ ok: false, code: "forbidden", error: expect.stringContaining("找 PM 或 owner") });
    }
    expect(run(["project-edit", "aa", "--name", "A"], "222")).toMatchObject({ ok: true, project: { name: "A" } });
    expect(run(["project-edit", "aa", "--dirs", "/no/such/b"])).toMatchObject({ ok: false, error: expect.stringContaining("已登记在项目 bb 下") });
    expect(JSON.parse(readFileSync(join(state, "projects.json"), "utf8")).projects.map((p: ProjectDef) => p.dirs)).toEqual([["/no/such/a"], ["/no/such/b"]]);
  });
});
