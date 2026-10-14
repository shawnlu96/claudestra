import { describe, expect, test } from "bun:test";
import { masterSessionProbe, normSockPath, planSockHeal, sameSockServers, sockArgOf, type SockProbe, type SockProbePorts } from "../src/lib/tmux-sock-probe.ts";

const SOCK = "/fake/run/master.sock";
const SERVER_LINE = `  795     1 tmux -f /dev/null -S ${SOCK} new-session -d -s master -n master -c /x`;
const enoent = () => { throw Object.assign(new Error("ENOENT: no such file"), { code: "ENOENT" }); };

type Run = { code: number | null; out: string; err: string };
function ports(o: Partial<SockProbePorts> & { tmux?: { code: number | null; out?: string; err?: string }; psOut?: string | Error; lsofR?: Run | Error } = {}):
  SockProbePorts & { tmuxCalls: number; lsofPaths: string[] } {
  const p = {
    tmuxCalls: 0,
    lsofPaths: [] as string[],
    lsof: async (path: string) => { p.lsofPaths.push(path); if (o.lsofR instanceof Error) throw o.lsofR; return o.lsofR ?? { code: 1, out: "", err: "" }; },
    sockPath: SOCK,
    stat: o.stat ?? (() => ({ ino: 42 })),
    listSessions: o.listSessions ?? (async () => { p.tmuxCalls++; return { code: o.tmux ? o.tmux.code : 0, out: o.tmux?.out ?? "", err: o.tmux?.err ?? "" }; }),
    ps: async () => { if (o.psOut instanceof Error) throw o.psOut; return o.psOut ?? ""; },
    realpath: o.realpath ?? ((x: string) => x),
    now: () => 1000,
  };
  return p;
}

describe("masterSessionProbe 三态 [验收线 1]", () => {
  test("连接被拒但同路径服务还在 → unknown（改前当成不存在），不查 lsof", async () => {
    const r = await masterSessionProbe(ports({ tmux: { code: 1, err: `no server running on ${SOCK}` }, psOut: SERVER_LINE }));
    expect(r.state).toBe("unknown");
    expect(r.refused).toBe(true);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("no server running");
    expect(r.servers?.map((s) => s.pid)).toEqual([795]);
    expect(r.stale).toBe(false);
  });

  test("超时（被杀）→ unknown", async () => {
    for (const code of [null, 137]) {
      const r = await masterSessionProbe(ports({ tmux: { code } }));
      expect(r.state).toBe("unknown");
      expect(r.why).toBe("查询超时");
      expect(r.refused).toBe(false);
    }
  });

  test("套接字在但连不上（权限）→ unknown，不算被拒", async () => {
    const r = await masterSessionProbe(ports({ tmux: { code: 1, err: `error connecting to ${SOCK} (Permission denied)` } }));
    expect(r.state).toBe("unknown");
    expect(r.refused).toBe(false);
  });

  test("stderr 只留前 200 字", async () => {
    const r = await masterSessionProbe(ports({ tmux: { code: 1, err: "x".repeat(500) } }));
    expect(r.stderr.length).toBe(200);
  });

  test("套接字不存在 + 没有同路径服务进程 → absent，不跑 tmux", async () => {
    const p = ports({ stat: enoent, psOut: `  12  1 tmux -S /other.sock new-session\n  13 500 tmux -S ${SOCK} attach` });
    const r = await masterSessionProbe(p);
    expect(r.state).toBe("absent");
    expect(r.sock).toBe("missing");
    expect(p.tmuxCalls).toBe(0);
  });

  test("套接字不存在但同路径服务进程还在 → unknown", async () => {
    const r = await masterSessionProbe(ports({ stat: enoent, psOut: SERVER_LINE }));
    expect(r.state).toBe("unknown");
    expect(r.servers?.map((s) => s.pid)).toEqual([795]);
  });

  test("套接字不存在、进程表读不了 → unknown", async () => {
    const r = await masterSessionProbe(ports({ stat: enoent, psOut: new Error("ps 失败") }));
    expect(r.state).toBe("unknown");
    expect(r.servers).toBeNull();
  });

  test("stat 出别的错 → unknown", async () => {
    const r = await masterSessionProbe(ports({ stat: () => { throw Object.assign(new Error("EACCES"), { code: "EACCES" }); } }));
    expect(r.state).toBe("unknown");
    expect(r.sock).toBe("error");
  });

  test("连上了：有 master → exists；没有 master → absent", async () => {
    const yes = await masterSessionProbe(ports({ tmux: { code: 0, out: "webshell\nmaster" } }));
    expect(yes.state).toBe("exists");
    expect(yes.inode).toBe(42);
    const no = await masterSessionProbe(ports({ tmux: { code: 0, out: "webshell" } }));
    expect(no.state).toBe("absent");
  });
});

describe("同路径服务进程", () => {
  test("只认 argv[0] 是 tmux、PPID=1、-S 同路径（含 -S 连写）", () => {
    const ps = [
      SERVER_LINE,
      `  796   900 tmux -S ${SOCK} list-sessions`, // 客户端
      `  797     1 claude --x "tmux -S ${SOCK}"`, // 参数里提到 tmux
      `  798     1 /opt/homebrew/bin/tmux -S${SOCK} new-session -d`,
      `  799     1 tmux -S /other.sock new-session`,
    ].join("\n");
    expect(sameSockServers(ps, SOCK, (x) => x).map((s) => s.pid)).toEqual([795, 798]);
  });

  test("目录按 realpath 比（/tmp ↔ /private/tmp）", () => {
    const real = (x: string) => (x === "/tmp/co" ? "/private/tmp/co" : x);
    expect(normSockPath("/tmp/co/master.sock", real)).toBe("/private/tmp/co/master.sock");
    expect(sameSockServers("  5 1 tmux -S /private/tmp/co/master.sock new-session", "/tmp/co/master.sock", real).map((s) => s.pid)).toEqual([5]);
  });

  test("sockArgOf", () => {
    expect(sockArgOf("tmux -f /dev/null -S /a.sock new-session")).toBe("/a.sock");
    expect(sockArgOf("bun tmux -S /a.sock")).toBeNull();
    expect(sockArgOf("tmux new-session")).toBeNull();
  });
});

describe("planSockHeal", () => {
  const base: SockProbe = { state: "unknown", why: "连接被拒", code: 1, stderr: "", ms: 1, sock: "present", inode: 42, refused: true, servers: [{ pid: 795, ppid: 1, command: "tmux" }], stale: false };
  test("恰好一个同路径服务：on 发、observe 记、off 告警", () => {
    expect(planSockHeal(base, "on")).toEqual({ kind: "signal", pid: 795 });
    expect(planSockHeal(base, "observe")).toEqual({ kind: "observe", pid: 795 });
    expect(planSockHeal(base, "off").kind).toBe("alert");
  });
  test("两个以上：任何档都不发", () => {
    const two = { ...base, servers: [...base.servers!, { pid: 796, ppid: 1, command: "tmux" }] };
    for (const m of ["on", "observe", "off"] as const) expect(planSockHeal(two, m).kind).toBe("alert");
  });
  test("超时（没被拒、套接字在）、exists、进程表读不了：不动", () => {
    expect(planSockHeal({ ...base, refused: false }, "on").kind).toBe("none");
    expect(planSockHeal({ ...base, state: "exists" }, "on").kind).toBe("none");
    expect(planSockHeal({ ...base, servers: null }, "on").kind).toBe("none");
  });
  test("套接字不存在 + 一个服务进程 → 发", () => {
    expect(planSockHeal({ ...base, sock: "missing", refused: true }, "on")).toEqual({ kind: "signal", pid: 795 });
  });
});

describe("残留套接字 [验收线 2]", () => {
  const refusedNoServer = { tmux: { code: 1, err: `no server running on ${SOCK}` }, psOut: "  12 1 tmux -S /other.sock new-session" };
  test("被拒 + 无同路径服务 + lsof 无持有者 → absent（stale），lsof 用 realpath 后的路径", async () => {
    const p = ports({ ...refusedNoServer, realpath: (x) => (x === "/fake/run" ? "/private/fake/run" : x) });
    const r = await masterSessionProbe(p);
    expect(r.state).toBe("absent");
    expect(r.stale).toBe(true);
    expect(r.why).toContain("残留套接字");
    expect(p.lsofPaths).toEqual(["/private/fake/run/master.sock"]);
  });
  test("lsof 有持有者 → unknown", async () => {
    const r = await masterSessionProbe(ports({ ...refusedNoServer, lsofR: { code: 0, out: "4242\n", err: "" } }));
    expect(r.state).toBe("unknown");
    expect(r.why).toContain("4242");
  });
  test("lsof 报错 / 超时 / 起不来 → unknown", async () => {
    for (const lsofR of [{ code: 1, out: "", err: "lsof: status error" }, { code: null, out: "", err: "" }, { code: 0, out: "", err: "" }, new Error("ENOENT lsof")]) {
      const r = await masterSessionProbe(ports({ ...refusedNoServer, lsofR }));
      expect(r.state).toBe("unknown");
      expect(r.stale).toBe(false);
    }
  });
  test("进程表读不了 → unknown，不查 lsof", async () => {
    const p = ports({ ...refusedNoServer, psOut: new Error("ps 失败") });
    expect((await masterSessionProbe(p)).state).toBe("unknown");
    expect(p.lsofPaths).toEqual([]);
  });
  test("超时 / 权限这类非 ECONNREFUSED：不走残留判定", async () => {
    const p = ports({ tmux: { code: 1, err: `error connecting to ${SOCK} (Permission denied)` }, psOut: "" });
    expect((await masterSessionProbe(p)).state).toBe("unknown");
    expect(p.lsofPaths).toEqual([]);
  });
});
