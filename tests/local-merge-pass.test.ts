/**
 * ONB-2 验收 5：真实 schedulerPass（scheduler-merge-reclaim-world.ts：主线 CI → 合并列车 → ciQueueFull → 合并驱动 → 部署 → 回收 → 自动 tick，
 * GitHub 是假的）。同样两张就绪卡，PR 项目照旧组车合并（对照），localMerge 项目：不建合并意图、不占槽、不组车，假 GitHub 一次都没被读，
 * 每张卡一条 local_merge_ready、就绪 CLI 只调一次（= PM 只被通知一次），服务重启后也不重发。
 */
import { describe, expect, test } from "bun:test";
import { getTask, listEvents } from "../src/lib/ledger-store.js";
import { reclaimWorld, type ReclaimWorld } from "./scheduler-merge-reclaim-world.ts";

/** Every read of the fake GitHub goes through hub.main / pending or one of its maps' get / has: count them all from here on. */
function countReads(w: ReclaimWorld): { n: number } {
  const seen = { n: 0 }, hub = w.hub as unknown as Record<string, unknown>;
  for (const k of ["parents", "heads", "merged", "synced", "ci", "dirty"]) {
    const m = hub[k] as Map<unknown, unknown> | Set<unknown>;
    for (const op of ["get", "has"] as const) {
      const orig = (m as unknown as Record<string, (...a: unknown[]) => unknown>)[op]?.bind(m);
      if (orig) Object.defineProperty(m, op, { value: (...a: unknown[]) => { seen.n++; return orig(...a); } });
    }
    Object.defineProperty(m, "size", { get: () => { seen.n++; return Object.getPrototypeOf(m).__lookupGetter__("size").call(m); } });
  }
  for (const k of ["main", "pending"]) {
    let v = hub[k];
    Object.defineProperty(hub, k, { get: () => { seen.n++; return v; }, set: (x) => { v = x; } });
  }
  return seen;
}

const readyOf = (w: ReclaimWorld, id: string) => listEvents(w.db, { project: "p", target: id }).filter((e) => e.data.op === "local_merge_ready");

describe("ONB-2 本地合并（整轮）", () => {
  test("PR 项目照旧组车合并；localMerge 项目零 GitHub 读、无合并意图 / 槽 / 列车，每卡一条就绪、只通知一次，重启不重发", async () => {
    const pr = reclaimWorld({ store: "memory" }), local = reclaimWorld({ store: "memory" });
    try {
      // the pass's own config: localMerge with remote off (what parseSchedulerConfig demands of such a project)
      Object.assign(local.config.projects.p!, { localMerge: true, remote: { ...local.config.projects.p!.remote!, mode: "off" } });
      for (const w of [pr, local]) { w.card("T1"); w.card("T2"); }
      const prReads = countReads(pr);
      for (let i = 0; i < 12 && pr.phase("T2") !== "merged"; i++) await pr.pass();
      expect(pr.hub.calls).toEqual(["match-head:T1", "match-head:T2"]); // unchanged PR path, the pin
      expect(prReads.n).toBeGreaterThan(0); // the counter does see a PR project's reads

      const reads = countReads(local);
      for (let i = 0; i < 3; i++) expect(await local.pass()).toEqual([]);
      local.restart();
      for (let i = 0; i < 2; i++) expect(await local.pass()).toEqual([]);

      expect(reads.n).toBe(0);
      expect(local.store.load("p")).toBeNull();
      expect(local.events).toEqual([]);
      expect([local.intentOf("T1"), local.intentOf("T2"), local.slot()]).toEqual([null, null, null]);
      for (const id of ["T1", "T2"]) {
        expect(readyOf(local, id).map((e) => e.data)).toEqual([{ op: "local_merge_ready", head: getTask(local.db, id)!.headSHA }]);
        expect(getTask(local.db, id)!.stage).toBe("merge");
      }
    } finally { pr.close(); local.close(); }
  });
});
