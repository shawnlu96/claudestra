import { expect, test } from "bun:test";
import { runStartupMigrations } from "../src/bridge/startup-migrations.ts";

test("bridge 监听后先补 project，再启动 Codex ACP 迁移", async () => {
  const calls: string[][] = [];
  await runStartupMigrations(async (...args) => {
    calls.push(args);
    return { ok: true, migrated: 0, changed: [] };
  });
  expect(calls).toEqual([["project-migrate"], ["worker-kind-migrate"], ["migrate", "--startup"]]);
});

test("project 迁移失败不阻止 Codex ACP 迁移", async () => {
  const calls: string[][] = [];
  await runStartupMigrations(async (...args) => {
    calls.push(args);
    if (args[0] === "project-migrate") throw new Error("project unavailable");
    return { ok: true, changed: [] };
  });
  expect(calls).toEqual([["project-migrate"], ["worker-kind-migrate"], ["migrate", "--startup"]]);
});
