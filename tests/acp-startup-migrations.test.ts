import { expect, test } from "bun:test";
import { runStartupMigrations } from "../src/bridge/startup-migrations.ts";

test("bridge 监听后先补 project，再启动 Codex ACP 迁移", async () => {
  const calls: string[][] = [];
  await runStartupMigrations(async (...args) => {
    calls.push(args);
    return { ok: true, migrated: 0, changed: [] };
  });
  expect(calls).toEqual([["project-migrate"], ["migrate", "--startup"]]);
});

test("project 迁移失败不阻止 Codex ACP 迁移", async () => {
  const calls: string[][] = [];
  await runStartupMigrations(async (...args) => {
    calls.push(args);
    if (args[0] === "project-migrate") throw new Error("project unavailable");
    return { ok: true, changed: [] };
  });
  expect(calls).toEqual([["project-migrate"], ["migrate", "--startup"]]);
});

test("后续启动即使零改动，也点名待迁移的活跃旧 Codex 和手动下一步", async () => {
  const warnings: string[] = [];
  await runStartupMigrations(async (...args) => args[0] === "project-migrate"
    ? { ok: true, migrated: 0 }
    : { ok: true, changed: [], pending: ["agent-peer-legacy"], restarted: [] },
  (message) => warnings.push(message));
  expect(warnings).toHaveLength(1);
  expect(warnings[0]).toContain("agent-peer-legacy");
  expect(warnings[0]).toContain("migrate --acp");
});
