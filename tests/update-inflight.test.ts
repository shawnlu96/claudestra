import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { clearUpdateMarker, readUpdateMarker, updateVerdict, writeUpdateMarker, type UpdateMarker } from "../src/lib/update-inflight";

const NOW = Date.parse("2026-09-28T12:00:00Z");
const m = (over: Partial<UpdateMarker> = {}): UpdateMarker => ({
  pid: 7, channel: "release", target: "T".repeat(40), targetLabel: "v9.9.9", fromHead: "F".repeat(40),
  step: "reloading", startedAt: new Date(NOW - 5 * 60_000).toISOString(), reloadAt: new Date(NOW - 60_000).toISOString(), ...over,
});
const dead = () => false;
const fresh = { a: NOW - 30_000, b: NOW - 20_000, c: NOW - 10_000 };

describe("updateVerdict", () => {
  test("持有者还活着 = 在途，不碰", () => {
    expect(updateVerdict(m(), "T".repeat(40), NOW, () => true, fresh).action).toBe("live");
  });
  test("launcher 自杀的正常情况：三个 daemon 都在 reload 之后起来过 → 只清标记", () => {
    expect(updateVerdict(m(), "T".repeat(40), NOW, dead, fresh).action).toBe("clear");
  });
  test("lstart 只到秒：同一秒内起来的不误判", () => {
    expect(updateVerdict(m(), "T".repeat(40), NOW, dead, { ...fresh, c: NOW - 60_500 }).action).toBe("clear");
  });
  test("有 daemon 没重启 / 没在跑 → 补 reload，列出是哪几个", () => {
    expect(updateVerdict(m(), "T".repeat(40), NOW, dead, { ...fresh, b: NOW - 3_600_000, c: null })).toEqual({ action: "finish-reload", stale: ["b", "c"] });
  });
  test("切到目标但没走到 reload → 从尾段补", () => {
    for (const step of ["checkout", "installed", "built", "migrated"] as const) {
      expect(updateVerdict(m({ step }), "T".repeat(40), NOW, dead, fresh).action).toBe("finish-tail");
    }
  });
  test("还在升级前 → 清标记照常走；HEAD 被人动过且没做完 → report（不补）", () => {
    expect(updateVerdict(m({ step: "checkout" }), "F".repeat(40), NOW, dead, fresh).action).toBe("clear");
    expect(updateVerdict(m({ step: "migrated" }), "X".repeat(40), NOW, dead, fresh).action).toBe("report");
    expect(updateVerdict(m(), "X".repeat(40), NOW, dead, { ...fresh, a: null }).action).toBe("report");
  });
  test("HEAD 在目标之后（又提交过）→ 照样补完", () => {
    expect(updateVerdict(m({ step: "migrated" }), "X".repeat(40), NOW, dead, fresh, true).action).toBe("finish-tail");
    expect(updateVerdict(m(), "X".repeat(40), NOW, dead, { ...fresh, a: null }, true)).toEqual({ action: "finish-reload", stale: ["a"] });
  });
  test("reload 已完成（launcher 连坐回收的常态）之后 HEAD 被人动过 → 仍只清标记，不挡以后的更新", () => {
    expect(updateVerdict(m(), "X".repeat(40), NOW, dead, fresh).action).toBe("clear");
  });
  test("持有者活着但超过 30 分钟 = 残留（pid 复用）", () => {
    expect(updateVerdict(m({ startedAt: new Date(NOW - 31 * 60_000).toISOString() }), "T".repeat(40), NOW, () => true, fresh).action).toBe("clear");
  });
});

describe("标记文件", () => {
  test("读写清；坏文件当没有", async () => {
    const p = join(mkdtempSync(join(tmpdir(), "upd-")), "update-inflight.json");
    expect(readUpdateMarker(p)).toBeNull();
    await writeUpdateMarker(m(), p);
    expect(readUpdateMarker(p)).toEqual(m());
    clearUpdateMarker(p);
    expect(readUpdateMarker(p)).toBeNull();
    writeFileSync(p, "{half");
    expect(readUpdateMarker(p)).toBeNull();
  });
});
