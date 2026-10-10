/**
 * 切换让宿主空闲退出（manager/acp-retire.ts）：只给这个 agent 窗口里、pid 和启动代次都对得上运行记录的宿主发 SIGUSR2，
 * 而且在 restart 子进程的重启锁里做（Shawn cxf-switch-host-pid-identity / 本地 stale-host-pid-cross-agent）。
 * 假宿主是本测试的子进程（命令行同真宿主 acp-host.ts <agent>）：idle 收到 SIGUSR2 就退、busy 不退（同 host.ts retireIfIdle）、
 * old 没装处理器（老宿主，SIGUSR2 的缺省动作就是退出）——被误发信号的 idle / old 会退，测试据此断言「没发」。
 */
import { afterAll, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { recordCodexRunning } from "../src/lib/codex-version.ts";
import { STATE_DIR } from "../src/lib/paths.ts";
import { DEFER_MARK, RETIRE_ENV, retireForSwitch, retireHost, type Retire } from "../src/manager/acp-retire.ts";

const dir = mkdtempSync(join(tmpdir(), "cxf-s-retire-"));
const hosts: ReturnType<typeof Bun.spawn>[] = [];
afterAll(() => {
  for (const h of hosts) h.kill();
  rmSync(dir, { recursive: true, force: true });
});

const HOST = join(dir, "acp-host.ts");
writeFileSync(HOST, `if (process.argv[2] !== "old") process.on("SIGUSR2", () => { if (process.argv[2] === "idle") process.exit(0); });
setInterval(() => {}, 1000); console.log("up");`);
async function fakeHost(mode: "idle" | "busy" | "old", agent = "agent-other") {
  const p = Bun.spawn([process.execPath, HOST, mode, agent], { stdout: "pipe" });
  hosts.push(p);
  await p.stdout.getReader().read();
  return p;
}
/** 没被发信号：idle / old 收到 SIGUSR2 都会退，等一会儿还活着才算 */
const untouched = async (p: { exitCode: number | null }) => (await Bun.sleep(300), p.exitCode === null);
/** 直接写盘的运行记录：模拟「写记录的宿主已退出，pid 被别的进程复用」（真宿主写记录时带的是自己的启动代次） */
function staleRecord(agent: string, rec: Record<string, unknown>, state = STATE_DIR) {
  mkdirSync(join(state, "codex-running"), { recursive: true });
  writeFileSync(join(state, "codex-running", `${agent}.json`), JSON.stringify(rec));
}
const OLD_START = "Mon Jan 1 00:00:00 2024";
const inWindow = (pids: number[] | null) => async () => pids;

describe("retireHost：认宿主 = 这个 agent 窗口里的子进程 + pid + 启动代次", () => {
  test("窗口里没有进程、也没有活着的记录宿主 = absent；窗口认不出（不唯一 / tmux 读失败）= unknown", async () => {
    expect(await retireHost("agent-none", 500, inWindow([]))).toBe("absent");
    staleRecord("agent-gone", { hostPid: 2 ** 22 + 12345, hostStart: OLD_START });
    expect(await retireHost("agent-gone", 500, inWindow([]))).toBe("absent");
    expect(await retireHost("agent-none", 500, inWindow(null))).toBe("unknown");
  });

  test("别的 ACP 宿主复用了记录里的 pid（代次对不上）：不发信号；A 窗口里没宿主 = absent，有宿主 = unknown", async () => {
    const b = await fakeHost("idle", "agent-b");
    staleRecord("agent-a", { hostPid: b.pid, hostStart: OLD_START });
    expect(await retireHost("agent-a", 500, inWindow([]))).toBe("absent");
    const a = await fakeHost("idle", "agent-a");
    expect(await retireHost("agent-a", 500, inWindow([a.pid]))).toBe("unknown");
    expect(await untouched(b)).toBe(true);
    expect(await untouched(a)).toBe(true);
  });

  test("记录的 pid 和代次都对得上、但那个宿主不在 A 的窗口里（别的 agent 的）= unknown，不发", async () => {
    const b = await fakeHost("idle", "agent-b");
    recordCodexRunning("agent-a2", "0.159.3", undefined, { hostPid: b.pid }); // 代次是 b 的真代次
    expect(await retireHost("agent-a2", 500, inWindow([]))).toBe("unknown");
    expect(await retireHost("agent-a2", 500, inWindow([process.pid]))).toBe("unknown");
    expect(await untouched(b)).toBe(true);
  });

  test("老宿主（没装 SIGUSR2 处理器、没写记录）在窗口里 = unknown，不发（发了它会直接退，回合中也一样）", async () => {
    const old = await fakeHost("old", "agent-old");
    expect(await retireHost("agent-old", 500, inWindow([old.pid]))).toBe("unknown");
    expect(await untouched(old)).toBe(true);
  });

  test("记录是上一个宿主的，窗口里已经换成更新的宿主（记录还没写）= unknown，不发", async () => {
    const cur = await fakeHost("idle", "agent-new");
    staleRecord("agent-new", { hostPid: 2 ** 22 + 23456, hostStart: OLD_START });
    expect(await retireHost("agent-new", 500, inWindow([cur.pid]))).toBe("unknown");
    staleRecord("agent-new", { hostPid: cur.pid }); // 同 pid 但没代次（老格式记录）也认不出
    expect(await retireHost("agent-new", 500, inWindow([cur.pid]))).toBe("unknown");
    expect(await untouched(cur)).toBe(true);
  });

  test("认得出的宿主：空闲 = 收到信号退出（exited），在跑回合 = 不退（busy，不掐）", async () => {
    const idle = await fakeHost("idle", "agent-idle");
    recordCodexRunning("agent-idle", "0.159.3", undefined, { hostPid: idle.pid });
    expect(await retireHost("agent-idle", 3000, inWindow([idle.pid]))).toBe("exited");
    const busy = await fakeHost("busy", "agent-busy");
    recordCodexRunning("agent-busy", "0.159.3", undefined, { hostPid: busy.pid });
    expect(await retireHost("agent-busy", 500, inWindow([busy.pid]))).toBe("busy");
    expect(busy.exitCode).toBeNull();
  });
});

describe("retireForSwitch：restart 拿到重启锁后、碰窗口前调", () => {
  const ACP = { runtime: "codex", transport: "acp" };
  const on = { [RETIRE_ENV]: "1" };
  test("不是切换发起的重启：什么都不做", async () => {
    let asked = 0;
    await retireForSwitch("agent-a", ACP, {}, async () => (asked++, "busy"));
    expect(asked).toBe(0);
  });
  test("宿主不退 / 认不出：抛「切换延后」，cmdRestart 照异常记、不碰窗口；退了 / 不在：往下重起", async () => {
    for (const [r, why] of [["busy", "回合在跑"], ["unknown", "认不出"]] as const) {
      await expect(retireForSwitch("agent-a", ACP, on, async () => r)).rejects.toThrow(`${DEFER_MARK}${why}`);
    }
    for (const r of ["exited", "absent"] as Retire[]) await retireForSwitch("agent-a", ACP, on, async () => r);
  });
  test("registry 里已经不是 ACP Codex 了：不问宿主、不重起", async () => {
    let asked = 0;
    await expect(retireForSwitch("agent-a", { runtime: "codex", transport: "tmux" }, on, async () => (asked++, "exited"))).rejects.toThrow(DEFER_MARK);
    expect(asked).toBe(0);
  });
});

describe("真实 manager restart（切换发起）：认宿主、发信号都在重启锁里", () => {
  // 状态、运行目录指到临时目录；PATH 前面放假 tmux：只在 acp-retire 查窗口时报「agent-sw 的 shell = 本测试进程」，
  // 假宿主是本测试进程的子进程 = 在 agent-sw 的窗口里；bridge 指到没人听的端口，碰不到线上（同 restart-expect-cli.test.ts）
  const AGENT = "agent-sw";
  const state = join(dir, "state"), run = join(dir, "run"), bin = join(dir, "bin");
  for (const d of [state, run, bin, join(state, "locks")]) mkdirSync(d, { recursive: true });
  writeFileSync(join(bin, "tmux"), `#!/bin/sh\ncase "$*" in *list-windows*window_name*pane_pid*) printf '%s\\t%s\\n' ${AGENT} ${process.pid} ;; esac\nexit 0\n`);
  chmodSync(join(bin, "tmux"), 0o755);
  writeFileSync(join(state, "registry.json"), JSON.stringify({
    socket: "", agents: { [AGENT]: { sessionId: "s1", channelId: "local-sw", status: "active", cwd: dir, runtime: "codex", transport: "acp" } },
  }));
  const lock = join(state, "locks", `restart-${AGENT}.lock`);
  async function restart(): Promise<{ ok?: boolean; error?: string }> {
    const env: Record<string, string | undefined> = { ...process.env, PATH: `${bin}:${process.env.PATH}`, CLAUDESTRA_STATE_DIR: state,
      CLAUDESTRA_RUNTIME_DIR: run, BRIDGE_URL: "ws://127.0.0.1:9", BRIDGE_PORT: "9", [RETIRE_ENV]: "1" };
    delete env.DISCORD_CHANNEL_ID;
    const proc = Bun.spawn([process.execPath, "--no-env-file", resolve(import.meta.dir, "../src/manager.ts"), "restart", "--", AGENT], { env, stdout: "pipe", stderr: "pipe" });
    const out = await new Response(proc.stdout).text();
    await proc.exited;
    return (JSON.parse(out.trim().split("\n").pop() || "{}").results ?? [])[0] ?? {};
  }

  test("并发：另一个 restart 拿着锁时，就算窗口里是认得出的空闲宿主也不发信号", async () => {
    const h = await fakeHost("idle", AGENT);
    recordCodexRunning(AGENT, "0.159.3", state, { hostPid: h.pid });
    writeFileSync(lock, `${process.pid}\n${Date.now()}`);
    expect(await restart()).toMatchObject({ ok: false, error: expect.stringContaining("另一个 restart") });
    rmSync(lock);
    expect(await untouched(h)).toBe(true);
    h.kill();
  }, 60_000);

  test("锁里认不出（老宿主没写记录）：切换延后、不发信号；认得出但在跑回合：发了信号它不退，切换延后、不碰窗口", async () => {
    const old = await fakeHost("old", AGENT);
    staleRecord(AGENT, { hostPid: 2 ** 22 + 34567, hostStart: OLD_START }, state);
    expect((await restart()).error).toContain(`${DEFER_MARK}认不出`);
    expect(await untouched(old)).toBe(true);
    old.kill();
    const busy = await fakeHost("busy", AGENT);
    recordCodexRunning(AGENT, "0.159.3", state, { hostPid: busy.pid });
    expect((await restart()).error).toContain(`${DEFER_MARK}回合在跑`);
    expect(busy.exitCode).toBeNull();
  }, 60_000);
});
