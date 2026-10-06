/**
 * i28-R5a r1 P1-1 回归：真 tmux（私有 socket）里，宿主不在第一个 pane 也算活着，lend 循环不杀它；宿主退了 / 窗口没了照常判出来。
 * lib/paths 在加载时读 CLAUDESTRA_RUNTIME_DIR，换 tmux socket 只能另起进程：步骤写成临时脚本，结果按 JSON 打到 stdout 再断言。
 * 宿主用 perl 顶替（命令行带 <dir>/src/acp-host.ts，不联网）。CI 装了 tmux，没有时这条会失败，不静默跳过。
 */
import { expect, onTestFinished, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { testChildEnv } from "./test-env.ts";

const SRC = join(import.meta.dir, "..", "src", "lib");
const imp = (names: string, file: string) => `import { ${names} } from ${JSON.stringify(file)};`;

const STEPS = `
const dir = process.env.CLAUDESTRA_RUNTIME_DIR;
if (!dir || !resolve(TMUX_SOCK).startsWith(resolve(dir) + "/")) throw new Error("拒绝在非私有 socket 上跑：" + TMUX_SOCK);
const name = workerName("o1");
const target = "master:=" + name;
const out = {};
const hostPids = async () => (await tmuxRawStrict(["list-panes", "-t", target, "-F", "#{pane_pid} #{pane_start_command}"]))
  .split("\\n").filter((l) => l.includes("acp-host.ts")).map((l) => Number(l.split(" ")[0]));
try {
  await tmuxRawStrict(["new-session", "-d", "-s", "master", "-n", "master", "sh"]);
  await tmuxRawStrict(["new-window", "-d", "-t", "master:", "-n", name, "perl", "-e", "sleep 120", dir + "/src/acp-host.ts"]);
  await tmuxRawStrict(["set-option", "-w", "-t", target, "automatic-rename", "off"]);
  out.single = await probeAcpWorker(name);
  // 在宿主前面插一个空 shell pane：宿主挪到 pane 1，还是同一个进程
  await tmuxRawStrict(["split-window", "-b", "-d", "-t", target, "sh"]);
  out.split = await probeAcpWorker(name);
  const h = harness();
  await toStarted(h);
  h.d.worker.alive = (n) => probeAcpWorker(n);
  for (let i = 0; i < 3; i++) { h.advanceTime(5000); await h.tick(); }
  out.loop = { state: getOrder(h.db, "o1").state, killed: h.log.killed };
  process.kill((await hostPids())[0], "SIGKILL");
  for (let i = 0; i < 100 && (await hostPids()).length; i++) await Bun.sleep(50);
  out.hostKilled = await probeAcpWorker(name);
  await tmuxRawStrict(["kill-window", "-t", target]);
  out.windowKilled = await probeAcpWorker(name);
} finally {
  await tmuxRawStrict(["kill-server"]).catch((e) => console.error("私有 tmux server 没关掉：" + e.message));
}
console.log(JSON.stringify(out));
`;

test("分屏后宿主在 pane 1：running，两轮循环不杀；杀宿主 = no_host，kill-window = no_window", async () => {
  // socket 路径有长度上限（macOS 104 字节），不用可能很长的 TMPDIR
  const dir = mkdtempSync("/tmp/r5a-tmux-");
  onTestFinished(() => rmSync(dir, { recursive: true, force: true })); // 不在 preload 的临时根下，自己删
  const script = join(dir, "steps.ts");
  writeFileSync(script, [
    `import { resolve } from "node:path";`,
    imp("getOrder", join(SRC, "lend-journal.ts")),
    imp("workerName", join(SRC, "lend-drive.ts")),
    imp("tmuxRawStrict, TMUX_SOCK", join(SRC, "tmux-helper.ts")),
    imp("probeAcpWorker", join(SRC, "worker-liveness.ts")),
    imp("harness, toStarted", join(import.meta.dir, "lend-harness.ts")),
    STEPS,
  ].join("\n"));
  const child = Bun.spawn([process.execPath, script], { env: testChildEnv({ CLAUDESTRA_RUNTIME_DIR: dir, CLAUDESTRA_STATE_DIR: join(dir, "state") }), stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  expect({ code, stderr: code === 0 ? "" : stderr }).toEqual({ code: 0, stderr: "" });
  expect(JSON.parse(stdout.trim().split("\n").at(-1)!)).toEqual({
    single: "running", split: "running", loop: { state: "started", killed: [] }, hostKilled: "no_host", windowKilled: "no_window",
  });
}, 30_000);
