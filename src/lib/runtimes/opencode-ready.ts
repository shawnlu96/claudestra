/**
 * OpenCode 的就绪等待：和 Codex / Pi 同一个 @claudestra_ready 标记（waitCodexReady），外加一个看宿主日志的哨兵——
 * 宿主拒起（模型不被接受等 AcpIncompatibleError）时不标就绪、也不退出，单看标记要等满 manager 的就绪预算（2 分钟）才报超时。
 * 哨兵在本次启动之后的 host.log 里看到「不再重起」就带原因立刻返回；标记那条循环随之停掉（sleep 抛出）。tests/opencode-acp-runtime.test.ts
 */
import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { acpLogDir } from "../log-paths.js";
import { waitCodexReady } from "./codex-ready.js";
import type { ReadyResult, WindowOps } from "./types.js";

const REFUSED = /适配器接不上线程：(.*)（不再重起/;

/** host.log 里 since 之后的拒起原因；没有返回 null。日志行以 ISO 时间开头（acp-host.ts log） */
async function hostRefusalSince(logFile: string, since: number): Promise<string | null> {
  const st = await stat(logFile).catch(() => null); // 宿主还没写日志：当没有
  if (!st || st.mtimeMs < since) return null;
  const text = await readFile(logFile, "utf8").catch(() => ""); // 读的那一刻被轮转：下一轮再看
  for (const line of text.split("\n").reverse()) {
    if (!line.trim()) continue;
    const at = Date.parse(line.slice(0, 24));
    if (!Number.isFinite(at) || at < since) break;
    const m = line.match(REFUSED);
    if (m) return m[1]!.slice(0, 400);
  }
  return null;
}

export async function waitOpencodeReady(win: WindowOps, budget: { rounds: number; pollMs: number }, logFile = join(acpLogDir(win.name), "host.log")): Promise<ReadyResult> {
  const since = Date.now() - 1_000; // 宿主日志的时间戳和这里同一台机器；留 1s 余量
  let done = false;
  const guarded: WindowOps = { ...win, sleep: async (ms) => { if (done) throw new Error("就绪等待已结束"); await win.sleep(ms); } };
  const marker = waitCodexReady(guarded, budget, { occupied: 0, dialog: 0 }).catch((): ReadyResult => ({ ready: false, reason: "timeout" }));
  const sentinel = (async (): Promise<ReadyResult | null> => {
    for (let i = 0; i < budget.rounds && !done; i++) {
      const why = await hostRefusalSince(logFile, since);
      if (why) return { ready: false, reason: "exited", detail: `宿主拒起：${why}` };
      await win.sleep(budget.pollMs).catch(() => {}); // 假窗口的 sleep 不会抛；真抛了就接着看下一轮
    }
    return null;
  })();
  const first = await Promise.race([marker, sentinel.then((r) => r ?? marker)]);
  done = true;
  return first;
}
