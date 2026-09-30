/**
 * tests/worker-liveness-tmux.test.ts 的子进程：CLAUDESTRA_RUNTIME_DIR 指向临时目录，tmux 走那里的私有 socket（lib/paths 在加载时读，
 * 所以必须另起进程）。宿主用 perl 顶替：命令行带 <dir>/src/acp-host.ts，不联网。每一步的结果按 JSON 打到 stdout，由父进程断言。
 */
import { resolve } from "node:path";
import { getOrder } from "../src/lib/lend-journal.js";
import { workerName } from "../src/lib/lend-drive.js";
import { tmuxRawStrict, TMUX_SOCK } from "../src/lib/tmux-helper.js";
import { probeAcpWorker } from "../src/lib/worker-liveness.js";
import { harness, toStarted } from "./lend-harness.js";

const dir = process.env.CLAUDESTRA_RUNTIME_DIR!;
if (!dir || !resolve(TMUX_SOCK).startsWith(resolve(dir) + "/")) throw new Error(`拒绝在非私有 socket 上跑：${TMUX_SOCK}`);
const name = workerName("o1");
const target = `master:=${name}`;
const out: Record<string, unknown> = {};
const hostPids = async () => (await tmuxRawStrict(["list-panes", "-t", target, "-F", "#{pane_pid} #{pane_start_command}"]))
  .split("\n").filter((l) => l.includes("acp-host.ts")).map((l) => Number(l.split(" ")[0]));

try {
  await tmuxRawStrict(["new-session", "-d", "-s", "master", "-n", "master", "sh"]);
  await tmuxRawStrict(["new-window", "-d", "-t", "master:", "-n", name, "perl", "-e", "sleep 120", `${dir}/src/acp-host.ts`]);
  await tmuxRawStrict(["set-option", "-w", "-t", target, "automatic-rename", "off"]);
  out.single = await probeAcpWorker(name);
  // 在宿主前面插一个空 shell pane：宿主挪到 pane 1，还是同一个进程
  await tmuxRawStrict(["split-window", "-b", "-d", "-t", target, "sh"]);
  out.split = await probeAcpWorker(name);
  const h = harness();
  await toStarted(h);
  h.d.worker.alive = (n) => probeAcpWorker(n);
  for (let i = 0; i < 3; i++) { h.advanceTime(5_000); await h.tick(); }
  out.loop = { state: getOrder(h.db, "o1")!.state, killed: h.log.killed };
  process.kill((await hostPids())[0]!, "SIGKILL");
  for (let i = 0; i < 100 && (await hostPids()).length; i++) await Bun.sleep(50);
  out.hostKilled = await probeAcpWorker(name);
  await tmuxRawStrict(["kill-window", "-t", target]);
  out.windowKilled = await probeAcpWorker(name);
} finally {
  await tmuxRawStrict(["kill-server"]).catch((e) => console.error(`私有 tmux server 没关掉：${(e as Error).message}`));
}
console.log(JSON.stringify(out));
