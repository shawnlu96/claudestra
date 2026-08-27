/**
 * usage-cache-write.sh 集成测试(真跑脚本,隔离 HOME;v2.20.2+):
 * 多写者竞争的合并规则(peer 实报 2026-08-27)——
 * ① 字段级合并:数据不全的 agent(CC 不给 five_hour)渲染一次,不得把
 *   全机 5h 用量抹成 null;
 * ② 窗口单调:同 reset 窗口内更小的 pct 是陈旧快照,丢弃;reset 变了
 *   (窗口轮转)无条件覆盖。session/week 两窗口独立判。
 */
import { describe, test, expect, beforeEach } from "bun:test";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

const SCRIPT = join(import.meta.dir, "..", "scripts", "usage-cache-write.sh");

let home: string;
let cachePath: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "ucw-"));
  mkdirSync(join(home, ".claude-orchestrator"), { recursive: true });
  cachePath = join(home, ".claude-orchestrator", "usage-cache.json");
});

async function run(payload: unknown): Promise<void> {
  const p = Bun.spawn(["bash", SCRIPT], {
    stdin: new TextEncoder().encode(typeof payload === "string" ? payload : JSON.stringify(payload)),
    env: { ...process.env, HOME: home },
    stdout: "ignore",
    stderr: "ignore",
  });
  await p.exited;
}

const input = (five: number | null, week: number | null, fiveReset: number | null, weekReset: number | null) => ({
  rate_limits: {
    ...(five !== null || fiveReset !== null
      ? { five_hour: { ...(five !== null ? { used_percentage: five } : {}), ...(fiveReset !== null ? { resets_at: fiveReset } : {}) } }
      : {}),
    ...(week !== null || weekReset !== null
      ? { seven_day: { ...(week !== null ? { used_percentage: week } : {}), ...(weekReset !== null ? { resets_at: weekReset } : {}) } }
      : {}),
  },
});

const cache = () => JSON.parse(readFileSync(cachePath, "utf8"));

describe("usage-cache-write.sh 多写者合并", () => {
  test("首写全量落盘", async () => {
    await run(input(8, 94, 1787846400, 1788296400));
    const c = cache();
    expect(c.sessionPct).toBe(8);
    expect(c.weekPct).toBe(94);
    expect(c.sessionResets).toBe(1787846400);
  });

  test("① 缺 five_hour 的写者不抹掉 5h(peer 复现场景)", async () => {
    await run(input(8, 94, 1787846400, 1788296400));
    await run(input(null, 84, null, 1788296400)); // 空闲 agent:没有 five_hour,7d 还是陈旧的 84
    const c = cache();
    expect(c.sessionPct).toBe(8);          // 5h 保住
    expect(c.sessionResets).toBe(1787846400);
    expect(c.weekPct).toBe(94);            // 同窗口 84 < 94 = 陈旧快照,丢弃
  });

  test("② 同窗口更小 pct 丢弃;更大覆盖", async () => {
    await run(input(20, 50, 1787846400, 1788296400));
    await run(input(12, 50, 1787846400, 1788296400)); // 陈旧
    expect(cache().sessionPct).toBe(20);
    await run(input(25, 50, 1787846400, 1788296400)); // 前进
    expect(cache().sessionPct).toBe(25);
  });

  test("② reset 变了(窗口轮转)无条件覆盖,两窗口独立", async () => {
    await run(input(90, 50, 1787846400, 1788296400));
    await run(input(2, 50, 1787864400, 1788296400)); // 5h 窗口轮转:2 < 90 也要收
    const c = cache();
    expect(c.sessionPct).toBe(2);
    expect(c.sessionResets).toBe(1787864400);
    expect(c.weekPct).toBe(50); // week 窗口没动
  });

  test("旧缓存缺字段(peer 早期手抄格式)→ 直接写新", async () => {
    writeFileSync(cachePath, JSON.stringify({ sessionPct: 22, scrapedAt: 1, source: "statusline" }));
    await run(input(5, 60, 1787846400, 1788296400));
    const c = cache();
    expect(c.sessionPct).toBe(5); // 旧 reset 缺失,无窗口可比 → 写新
    expect(c.weekPct).toBe(60);
  });

  test("坏输入/无 rate_limits:静默不写不残留", async () => {
    await run("not json");
    await run({ model: { display_name: "x" } });
    expect(existsSync(cachePath)).toBe(false);
  });
});
