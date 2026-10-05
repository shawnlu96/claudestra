import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { testChildEnv } from "./test-env";

test("r2 refresh-result: two isolated Bun processes recover exit 1 without replaying baseline as new tasks", async () => {
  const root = mkdtempSync(join(tmpdir(), "bg-shell-restart-"));
  const watcher = new URL("../src/bridge/bg-activity-watcher.ts", import.meta.url).href;
  const jsonl = new URL("../src/lib/jsonl-cost.ts", import.meta.url).href;
  const script = join(root, "probe.ts");
  for (const dir of ["home", "state", "runtime", "tmp", "tasks"]) mkdirSync(join(root, dir));
  writeFileSync(script, `
    import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
    import { join } from "node:path";
    import { pollBgActivitiesForTest, activeBgTasksFor } from ${JSON.stringify(watcher)};
    import { projectJsonlPath } from ${JSON.stringify(jsonl)};
    const root = ${JSON.stringify(root)};
    const agent = { name: "restart-shell", channelId: "local-restart", cwd: join(root, "project"), sessionId: "restart-session" };
    let clock = 1800000000000;
    const poll = () => pollBgActivitiesForTest({ now: () => clock, agents: async () => [agent], shellDir: () => join(root, "tasks") });
    if (process.argv[2] === "prepare") {
      const main = projectJsonlPath(agent.cwd, agent.sessionId);
      mkdirSync(join(main, ".."), { recursive: true });
      writeFileSync(main, "Command running in background with ID: retained1\\n");
      await poll();
      writeFileSync(join(root, "tasks", "retained1.output"), "running\\n");
      await poll();
      appendFileSync(join(root, "tasks", "retained1.output"), "[exited with code 1]\\n");
      clock += 10000;
      await poll();
    } else {
      await poll();
      await poll();
    }
    console.log("SNAPSHOT " + JSON.stringify(activeBgTasksFor(agent.name)));
    process.exit(0);
  `);
  const env = testChildEnv({
    HOME: join(root, "home"), CLAUDESTRA_STATE_DIR: join(root, "state"), CLAUDESTRA_RUNTIME_DIR: join(root, "runtime"),
    TMPDIR: tmpdir(), PATH: "/Users/shawn/.bun/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin",
  });
  const run = async (mode: string) => {
    const proc = Bun.spawn([process.execPath, "--no-env-file", script, mode], { env, cwd: root, stdout: "pipe", stderr: "pipe" });
    const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
    console.log(`${mode}: ${stdout}${stderr}`);
    expect(code).toBe(0);
    return { stdout, snapshots: JSON.parse(stdout.split("SNAPSHOT ")[1].trim()) as { id: string; end?: { exitCode: number } }[] };
  };
  try {
    const before = await run("prepare");
    expect(before.snapshots.find((t) => t.id === "retained1")?.end?.exitCode).toBe(1);
    const after = await run("restart");
    expect(after.stdout).not.toContain("bg 活动开始");
    expect(after.snapshots.find((t) => t.id === "retained1")?.end?.exitCode).toBe(1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
