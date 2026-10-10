import { describe, expect, test } from "bun:test";
import { acpExitPrelude } from "../src/lib/runtimes/acp-control.ts";
import type { WindowOps } from "../src/lib/runtimes/types.ts";

// manager restart / kill / 切换收 ACP 宿主：新宿主输入行把终端设成 raw，C-c 不再是 SIGINT——改发 SIGTERM，新老宿主都得收得掉

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

function win(pids: () => Promise<number[]>): WindowOps & { keys: string[] } {
  const keys: string[] = [];
  return {
    name: "agent-x", target: "master:agent-x", keys,
    capture: async () => "", sendLine: async () => {}, sendLiteral: async () => {}, sendEscape: async () => {},
    sendKey: async (k) => void keys.push(k),
    getOption: async () => null, setOption: async () => true,
    childPids: pids,
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
  };
}

/** 真子进程模拟宿主：new = 不认 SIGINT（raw 模式下按键根本到不了信号），只认 SIGTERM；old = 两个都认（老宿主） */
function fakeHost(kind: "new" | "old") {
  const code = kind === "new"
    ? `process.on("SIGINT", () => {}); process.on("SIGTERM", () => setTimeout(() => process.exit(0), 100)); setInterval(() => {}, 1000);`
    : `for (const s of ["SIGINT", "SIGTERM"]) process.on(s, () => setTimeout(() => process.exit(0), 100)); setInterval(() => {}, 1000);`;
  const p = Bun.spawn([process.execPath, "-e", code], { stdio: ["ignore", "ignore", "ignore"] });
  return p;
}

describe("acpExitPrelude", () => {
  for (const kind of ["new", "old"] as const) {
    test(`${kind === "new" ? "新" : "老"}宿主：SIGTERM 收掉，回到 shell，一个键都不发`, async () => {
      const p = fakeHost(kind);
      await Bun.sleep(200); // 等它装好信号处理
      const w = win(async () => (alive(p.pid) ? [p.pid] : []));
      expect(await acpExitPrelude(w)).toBe("at-shell");
      expect(w.keys).toEqual([]);
      expect(alive(p.pid)).toBe(false);
    });
  }

  test("新宿主只按 C-c 收不掉（误按一次不退的代价）：这正是退出改走信号的原因", async () => {
    const p = fakeHost("new");
    await Bun.sleep(200);
    process.kill(p.pid, "SIGINT");
    await Bun.sleep(300);
    expect(alive(p.pid)).toBe(true);
    p.kill("SIGKILL");
  });

  test("查不到窗口子进程（tmux / ps 读失败）：退回按键，连按两下 C-c（老宿主一下就退，新宿主空闲时连按两下退）", async () => {
    let n = 0;
    const w = win(async () => (n++ === 0 ? Promise.reject(new Error("tmux 读失败")) : []));
    const signals: number[] = [];
    expect(await acpExitPrelude(w, (pid) => void signals.push(pid))).toBe("at-shell");
    expect(w.keys).toEqual(["C-c", "C-c"]);
    expect(signals).toEqual([]);
  });

  test("宿主在发信号前自己退了（kill 抛 ESRCH）：不算失败，照样等回 shell", async () => {
    let n = 0;
    const w = win(async () => (n++ === 0 ? [999_999] : []));
    expect(await acpExitPrelude(w, () => { throw new Error("ESRCH"); })).toBe("at-shell");
  });

  test("等够轮次还没回 shell：交回 continue（manager 接着走强杀兜底）", async () => {
    const w = win(async () => [123]);
    w.sleep = async () => {};
    expect(await acpExitPrelude(w, () => {})).toBe("continue");
  });
});
