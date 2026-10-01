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
