import { expect, test } from "bun:test";
import { dirOf, mayTouch, parsePs, procLine, termThenKill, type Proc, type ProcPorts } from "../src/lib/proc-reap-core.js";

const UID = 501;
const proc = (pid: number, cwd: string, extra: Partial<Proc & { stubborn: boolean }> = {}) => ({ pid, uid: UID, cwd, comm: "/opt/x/bin/bun", ageSec: 9, ...extra });

function fakePorts(procs: (Proc & { stubborn?: boolean })[]) {
  const sent: string[] = [];
  const live = new Map(procs.map((p) => [p.pid, p]));
  const ports: ProcPorts = {
    uid: UID, self: 4242,
    list: async () => [...live.values()].map(({ stubborn: _s, ...p }) => p),
    signal: (pid, sig) => {
      sent.push(`${sig}:${pid}`);
      const p = live.get(pid);
      if (!p) return false;
      if (sig === "SIGKILL" || !p.stubborn) live.delete(pid);
      return true;
    },
    sleep: async (ms) => void sent.push(`sleep:${ms}`),
  };
  return { ports, sent, live };
}

test("parsePs：带 ppid 列与不带都认，comm 带空格", () => {
  expect(parsePs("  12     1   501  01:02 /A B.app/x\n")).toEqual(new Map([[12, { ppid: 1, uid: 501, ageSec: 62, comm: "/A B.app/x" }]]));
  expect(parsePs("  12   501  4-16:00:01 x\n").get(12)).toEqual({ uid: 501, ageSec: 4 * 86400 + 16 * 3600 + 1, comm: "x" });
  expect(parsePs("junk\n").size).toBe(0);
});

test("dirOf / mayTouch / procLine：根外、根本身、前缀相同的兄弟目录都不算；别的 uid、自己、pid ≤ 1 不碰；日志只写 basename", () => {
  expect(dirOf("/w", "/w/a/b")).toBe("a");
  expect(dirOf("/w", "/w")).toBeNull();
  expect(dirOf("/w", "/w-x/a")).toBeNull();
  expect(dirOf("/w", "/elsewhere")).toBeNull();
  const { ports } = fakePorts([]);
  expect(mayTouch(proc(10, "/w"), ports)).toBe(true);
  expect(mayTouch(proc(10, "/w", { uid: 0 }), ports)).toBe(false);
  expect(mayTouch(proc(4242, "/w"), ports)).toBe(false);
  expect(mayTouch(proc(1, "/w"), ports)).toBe(false);
  const l = procLine(proc(10, "/w"), "卡=T1", "SIGTERM", "已发");
  expect(l).toBe("回收残留进程 pid=10 命令=bun 卡=T1 存活=9s 信号=SIGTERM 结果=已发");
});

test("termThenKill：TERM → 宽限 → 只 KILL 仍被选中的；pick 之外与不可碰的零信号；发信号前核租约", async () => {
  const { ports, sent } = fakePorts([proc(10, "/w/a"), proc(11, "/w/a", { stubborn: true }), proc(12, "/w/b"), proc(13, "/w/a", { uid: 0 }), proc(4242, "/w/a")]);
  const lines: string[] = [];
  let checks = 0;
  const n = await termThenKill((ps) => ps.filter((p) => p.cwd === "/w/a").map((p) => ({ p, owner: "卡=A" })),
    { ports, log: (m) => lines.push(m), active: () => void checks++, graceMs: 7 });
  expect(n).toBe(2);
  expect(sent).toEqual(["SIGTERM:10", "SIGTERM:11", "sleep:7", "SIGKILL:11"]);
  expect(checks).toBe(2);
  expect(lines).toHaveLength(3);
  for (const l of lines) expect(l).not.toContain("/opt/x");
});

test("termThenKill：没进程可收不核租约、不睡；失租抛出不吞、零信号", async () => {
  const { ports, sent } = fakePorts([proc(10, "/w/a")]);
  expect(await termThenKill(() => [], { ports, log: () => {}, active: () => { throw new Error("不该核") } })).toBe(0);
  await expect(termThenKill((ps) => ps.map((p) => ({ p, owner: "x" })), { ports, log: () => {}, active: () => { throw new Error("lost") } })).rejects.toThrow("lost");
  expect(sent).toEqual([]);
});
