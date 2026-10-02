/**
 * i28-W1d：lend grant / revoke 当场关掉出借 worker 窗口后的报告措辞。按 journal 里这个名字最新那张单分两类：
 * 单没结束 = 「已停掉在跑的」，单已结束（或 journal 里没单）= 「清理了已结束单的残留窗口」——残留的不说「停掉」。
 */
import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stopReportText, stopRevokedWorkers, workerOrderLive, type StopIo } from "../src/lib/lend-grant-spawn.js";
import { advance, openLendJournal, patchOrder, recordAsked } from "../src/lib/lend-journal.js";

/** 真 journal：running 的单停在 cloned，ended 的单已 released（He 10-01 那五个窗口的情形） */
function journal(rows: { orderId: string; agent: string; ended: boolean }[]) {
  const path = join(mkdtempSync(join(tmpdir(), "lend-stop-")), "journal.sqlite");
  const db = openLendJournal(path);
  rows.forEach((r, i) => {
    recordAsked(db, { orderId: r.orderId, peer: "a", fp: null, family: "codex", preview: { repo: "o/r", step: "review" } }, i);
    advance(db, r.orderId, "asked", "claimed", { leaseUntil: 9e15, leaseGen: 1 }, i);
    advance(db, r.orderId, "claimed", "cloned", { dir: "/w" }, i);
    patchOrder(db, r.orderId, ["cloned"], { agent: r.agent }, i);
    if (r.ended) advance(db, r.orderId, "cloned", "released", { reason: "做完了" }, i);
  });
  db.close();
  return path;
}

/** stopRevokedWorkers 的假 io：names 全是授权已不覆盖的，窗口一关就确认 no_window */
function closeAll(names: string[]): StopIo {
  const windows = new Set(names);
  return {
    workers: async () => names.map((name) => ({ name })),
    stopReason: () => "收回",
    isCreate: () => false,
    signal: () => {},
    killWindows: async (n) => void windows.delete(n),
    probe: async (n) => (windows.has(n) ? "running" : "no_window"),
    markStopped: async () => {},
    sleep: async () => {},
  };
}

const report = async (names: string[], path: string) => stopReportText(await stopRevokedWorkers(closeAll(names)), (n) => workerOrderLive(n, path));

describe("重新授权 / 收回时关掉的窗口：在跑的停掉和已结束单的残留分开说", () => {
  test("probe 的 no_window 快照返回前 create 建窗并退出：返回前关窗且计入报告", async () => {
    const name = "agent-lend-race";
    const io = closeAll([]);
    let window = false;
    let creating = true;
    let status = "creating";
    let probes = 0;
    const calls: string[] = [];
    io.workers = async () => [{ name, createPid: 7 }];
    io.isCreate = () => creating;
    io.probe = async () => {
      const snapshot = window ? "running" : "no_window";
      if (++probes === 1) {
        await Promise.resolve().then(() => {
          window = true;
          status = "active";
          creating = false;
          calls.push("create committed and exited");
        });
      }
      return snapshot;
    };
    io.killWindows = async () => { calls.push("kill"); window = false; };
    io.markStopped = async () => { calls.push("markStopped"); status = "stopped"; };
    const result = await stopRevokedWorkers(io);
    expect(window).toBe(false);
    expect(status).toBe("stopped");
    expect(result).toEqual({ stopped: [name], unconfirmed: [] });
    expect(calls).toEqual(["create committed and exited", "kill", "markStopped"]);
  });

  test("3 条 stopped 无窗口加 1 条有窗口：只报本次关闭的窗口，再授权不重复报告", async () => {
    const gone = ["agent-lend-gone1", "agent-lend-gone2", "agent-lend-gone3"];
    const active = "agent-lend-left";
    const registry = new Map([...gone.map((n) => [n, "stopped"] as const), [active, "active"]]);
    const path = journal([...registry.keys()].map((agent, i) => ({ orderId: `o${i}`, agent, ended: true })));
    const io = closeAll([active]);
    const marked: string[] = [];
    const killed: string[] = [];
    const kill = io.killWindows;
    io.workers = async () => [...registry.keys()].map((name) => ({ name }));
    io.killWindows = async (name) => { killed.push(name); await kill(name); };
    io.markStopped = async (name) => { marked.push(name); registry.set(name, "stopped"); };
    const first = await stopRevokedWorkers(io);
    expect(first).toEqual({ stopped: [active], unconfirmed: [] });
    expect(stopReportText(first, (n) => workerOrderLive(n, path)))
      .toBe("；清理了 1 个已结束单的残留窗口：agent-lend-left");
    expect(marked).toEqual([...registry.keys()]);
    expect([...registry.values()]).toEqual(["stopped", "stopped", "stopped", "stopped"]);
    const second = await stopRevokedWorkers(io);
    expect(second).toEqual({ stopped: [], unconfirmed: [] });
    expect(stopReportText(second, (n) => workerOrderLive(n, path))).toBe("");
    expect(killed).toEqual([active]);
    expect(marked).toEqual([...registry.keys(), ...registry.keys()]);
  });

  test("初始无窗口但 create 在途：SIGTERM 停掉后仍报告已停掉在跑的", async () => {
    const name = "agent-lend-creating";
    const path = journal([{ orderId: "creating", agent: name, ended: false }]);
    const io = closeAll([]);
    let creating = true;
    const signals: string[] = [];
    const marked: string[] = [];
    io.workers = async () => [{ name, createPid: 7 }];
    io.isCreate = (pid, worker) => pid === 7 && worker === name && creating;
    io.signal = (pid, sig) => { signals.push(`${sig} ${pid}`); creating = false; };
    io.markStopped = async (n) => void marked.push(n);
    const result = await stopRevokedWorkers(io);
    expect(signals).toEqual(["SIGTERM 7"]);
    expect(marked).toEqual([name]);
    expect(result).toEqual({ stopped: [name], unconfirmed: [] });
    expect(stopReportText(result, (n) => workerOrderLive(n, path)))
      .toBe("；已停掉在跑的 1 个：agent-lend-creating");
  });

  test("初始及最终 probe unknown：照旧尝试关窗口并报 unconfirmed", async () => {
    const name = "agent-lend-unknown";
    const io = closeAll([name]);
    const calls: string[] = [];
    io.probe = async () => { calls.push("probe"); return "unknown"; };
    io.killWindows = async () => void calls.push("kill");
    io.markStopped = async () => void calls.push("markStopped");
    expect(await stopRevokedWorkers(io)).toEqual({ stopped: [],
      unconfirmed: [{ name, why: "读不到 tmux，没法确认已退出" }] });
    expect(calls).toEqual(["probe", "kill", "probe"]);
  });

  test("只有已结束单的残留窗口：输出里不出现「停掉」", async () => {
    const path = journal([{ orderId: "o1", agent: "agent-lend-9b7d", ended: true }, { orderId: "o2", agent: "agent-lend-ab1e", ended: true }]);
    const text = await report(["agent-lend-9b7d", "agent-lend-ab1e", "agent-lend-none"], path); // none = journal 里没有它的单
    expect(text).toBe("；清理了 3 个已结束单的残留窗口：agent-lend-9b7d、agent-lend-ab1e、agent-lend-none");
    expect(text).not.toContain("停掉");
  });

  test("有在跑的单：两类分开列出，各自计数", async () => {
    const path = journal([{ orderId: "o1", agent: "agent-lend-run1", ended: false }, { orderId: "o2", agent: "agent-lend-old", ended: true },
      { orderId: "o3", agent: "agent-lend-run2", ended: false }]);
    expect(await report(["agent-lend-run1", "agent-lend-old", "agent-lend-run2"], path))
      .toBe("；已停掉在跑的 2 个：agent-lend-run1、agent-lend-run2；清理了 1 个已结束单的残留窗口：agent-lend-old");
  });

  test("看 journal 不看窗口：同一个名字最新那张单在跑就算在跑（旧单结束了也一样）", async () => {
    const path = journal([{ orderId: "o1", agent: "agent-lend-x", ended: true }, { orderId: "o2", agent: "agent-lend-x", ended: false }]);
    expect(workerOrderLive("agent-lend-x", path)).toBe(true);
    expect(await report(["agent-lend-x"], path)).toBe("；已停掉在跑的 1 个：agent-lend-x");
  });

  test("journal 不存在 = 没有单（残留）；journal 读不了按在跑算", () => {
    const dir = mkdtempSync(join(tmpdir(), "lend-stop-bad-"));
    expect(workerOrderLive("agent-lend-x", join(dir, "nope.sqlite"))).toBe(false);
    const bad = join(dir, "bad.sqlite");
    writeFileSync(bad, "不是 sqlite");
    expect(workerOrderLive("agent-lend-x", bad)).toBe(true);
  });

  test("没关窗口就没这段；没确认的那段照旧", () => {
    expect(stopReportText({ stopped: [], unconfirmed: [] }, () => true)).toBe("");
    expect(stopReportText({ stopped: [], unconfirmed: [{ name: "agent-lend-a", why: "关窗口之后窗口还在" }] }, () => true))
      .toBe("；没能确认停掉：agent-lend-a（关窗口之后窗口还在）");
  });
});
