/**
 * web/features/lend/quota-warning-model.ts（QWARN1）：只按 bridge 判好的 state / limit 出提醒（warn / stop），unknown / below / mode off 不出肯定提醒；
 * 停接 / 缩减 / 只观察的文案；两族同时、互不顶替；关掉 key 按 实例 + 家族 + 周窗口世代 + 状态 + 阈值 + 模式 绑定。
 * 组合：真实 bridge 处理器（makeLendQuotaLinesApi，隔离临时目录与注入的合成用量）的 GET 回包直接喂给模型。
 */
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeLendQuotaLinesApi, type ActualSlots } from "../src/bridge/local-api/lend-quota-lines.js";
import { effectivePrincipal, type Grant } from "../src/lib/devices.js";
import type { QuotaFacts } from "../src/lib/lend-quota-line-facts.js";
import type { Principal } from "../src/lib/principals.js";
import type { FamilyLine, QuotaLinesView } from "../web/features/lend/lend-quota-model";
import { isDismissed, mergeDismissed, observeDismissed, parseDismissed, warnTexts, warningItems, withDismissed, type WarnItem } from "../web/features/lend/quota-warning-model";

const NOW = Date.parse("2026-10-06T06:00:00Z");
const RESET = NOW + 3 * 86_400_000;
const f = (over: Partial<FamilyLine> = {}): FamilyLine => ({ family: "codex", warnPct: 70, stopPct: 80, weekUsedPct: 50, resetAt: RESET, observedAt: NOW, source: "live",
  freshness: "fresh", state: "below", mode: "on", limit: "none", wouldLimit: "none", granted: 2, lineCap: 2, available: 2, slots: 2, ...over });
const view = (families: FamilyLine[], mode: "on" | "observe" | "off" = "on"): QuotaLinesView => ({ ok: true, config: { status: "ok", error: null, mode }, at: NOW, families });
const STOP = f({ weekUsedPct: 82, state: "stop", limit: "zero", wouldLimit: "zero" });
const WARN = f({ family: "claude", weekUsedPct: 74, state: "warn", limit: "half", wouldLimit: "half" });

describe("出不出提醒", () => {
  test("无权限 / 还没读到 / 模式 off：不出", () => {
    expect(warningItems(null, NOW)).toEqual([]);
    expect(warningItems(undefined, NOW)).toEqual([]);
    expect(warningItems(view([STOP, WARN], "off"), NOW)).toEqual([]);
  });
  test("below / unknown 不出肯定提醒（unknown 不当 0 也不当已恢复）", () => {
    const unknown = f({ family: "claude", weekUsedPct: null, resetAt: null, observedAt: null, source: null, freshness: null, state: "unknown", available: null, slots: null });
    expect(warningItems(view([f(), unknown]), NOW)).toEqual([]);
  });
  test("只看 bridge 的 state：百分比再高、state 是 below 也不出；state 是 warn 就出", () => {
    expect(warningItems(view([f({ weekUsedPct: 99 })]), NOW)).toEqual([]);
    expect(warningItems(view([f({ weekUsedPct: 10, state: "warn", limit: "half" })]), NOW)).toHaveLength(1);
  });
  test("两族同时：各一条，顺序同回包，互不顶替", () => {
    const items = warningItems(view([STOP, WARN]), NOW);
    expect(items.map((i) => [i.family, i.level, i.usedPct, i.stopped])).toEqual([["codex", "stop", 82, true], ["claude", "warn", 74, false]]);
  });
  test("读数所属周窗口已过重置：不再断言", () => {
    expect(warningItems(view([f({ ...STOP, resetAt: NOW - 1 })]), NOW)).toEqual([]);
  });
  test("上次读数如实标出", () => {
    expect(warningItems(view([f({ ...STOP, freshness: "last_known", source: "live_stale" })]), NOW)[0]!.lastKnown).toBe(true);
  });
});

describe("文案", () => {
  const one = (fl: FamilyLine, mode: "on" | "observe" = "on") => warnTexts(warningItems(view([fl], mode), NOW)[0]!);
  test("停接（执行）= 已停止接新单，在跑的单照常", () => {
    expect(one(STOP)).toEqual({ title: "{family} 本周已用 {pct}%，达到停接线", status: "已停止接新单，在跑的单照常做完" });
  });
  test("提醒（执行）= 未停接、名额减半", () => expect(one(WARN).status).toBe("未停接，新单名额已减半"));
  test("只观察：写明未停接", () => {
    expect(one(f({ ...STOP, limit: "none", mode: "observe" }), "observe").status).toBe("只观察：未停接，仍在接新单");
    expect(one(f({ ...WARN, limit: "none", mode: "observe" }), "observe").status).toBe("只观察：未停接，名额未缩减");
  });
});

describe("关掉", () => {
  const item = (fl: FamilyLine, mode: "on" | "observe" = "on"): WarnItem => warningItems(view([fl], mode), NOW)[0]!;
  const warn = item(f({ weekUsedPct: 72, state: "warn", limit: "half" }));
  const m = withDismissed({}, "fp1", warn);
  test("同一条线：关掉后不再出（用量涨但仍在提醒区也不出）", () => {
    expect(isDismissed(m, "fp1", warn)).toBe(true);
    expect(isDismissed(m, "fp1", item(f({ weekUsedPct: 78, state: "warn", limit: "half" })))).toBe(true);
  });
  test("跨新线（提醒 → 停接）、改线、改模式、新的一周：再出现", () => {
    expect(isDismissed(m, "fp1", item(STOP))).toBe(false);
    expect(isDismissed(m, "fp1", item(f({ weekUsedPct: 72, warnPct: 60, state: "warn", limit: "half" })))).toBe(false);
    expect(isDismissed(m, "fp1", item(f({ weekUsedPct: 72, state: "warn", limit: "none" }), "observe"))).toBe(false);
    expect(isDismissed(m, "fp1", item(f({ weekUsedPct: 72, state: "warn", limit: "half", resetAt: RESET + 7 * 86_400_000 })))).toBe(false);
  });
  test("按实例、按家族分开", () => {
    expect(isDismissed(m, "fp2", warn)).toBe(false);
    expect(isDismissed(m, "fp1", { ...warn, family: "claude" })).toBe(false);
  });
  test("同一代先后关掉提醒、停接都记；scope 总数封顶", () => {
    const m2 = withDismissed(m, "fp1", item(STOP));
    expect(Object.keys(m2)).toEqual(["fp1|codex"]);
    expect(isDismissed(m2, "fp1", warn) && isDismissed(m2, "fp1", item(STOP))).toBe(true);
    let big = {};
    for (let i = 0; i < 50; i++) big = withDismissed(big, `fp${i}`, warn);
    expect(Object.keys(big)).toHaveLength(32);
    expect(isDismissed(big, "fp49", warn)).toBe(true);
  });
  test("settings-return-1：70/80 关掉 → 实际改 60/80 关掉 → 改回 70/80：再出现（旧代关掉不复活）", () => {
    const w60 = item(f({ weekUsedPct: 72, warnPct: 60, state: "warn", limit: "half" }));
    const m1 = withDismissed({}, "fp1", warn, 1000);
    const m2 = withDismissed(m1, "fp1", w60, 2000);
    expect(isDismissed(m2, "fp1", w60)).toBe(true);
    expect(isDismissed(m2, "fp1", warn)).toBe(false);
    // 另一 tab 内存里还留着第一次 70/80 的旧代：合并后仍不复活
    for (const merged of [mergeDismissed(m2, m1), mergeDismissed(m1, m2)]) expect(isDismissed(merged, "fp1", warn)).toBe(false);
    // 改回 70/80 后再关掉：是新的一代
    const m3 = withDismissed(m2, "fp1", warn, 3000);
    expect(isDismissed(m3, "fp1", warn)).toBe(true);
    expect(isDismissed(mergeDismissed(m3, m1), "fp1", item(STOP))).toBe(false);
  });
  test("dismiss-memory-1：合并同代取并集；旧内存里多少旧代都挤不掉别处已落盘的当前代（stop），反之亦然", () => {
    const stop = item(STOP);
    const sameGen = withDismissed({}, "fp1", warn, 1000);
    const persistedSame = withDismissed(sameGen, "fp1", stop, 1500);
    for (const merged of [mergeDismissed(persistedSame, sameGen), mergeDismissed(sameGen, persistedSame)]) {
      expect(isDismissed(merged, "fp1", stop) && isDismissed(merged, "fp1", warn)).toBe(true);
    }
    // 审查复现：A 存不下，依次关掉 60…67 八代 warn（只在内存）；升停接改线 70/80 后 B 落盘关掉 stop
    let unsaved = {};
    for (let i = 0; i < 8; i++) unsaved = withDismissed(unsaved, "fp1", item(f({ weekUsedPct: 74, warnPct: 60 + i, state: "warn", limit: "half" })), 1000 + i);
    const stop70 = item(f({ ...STOP, warnPct: 70 }));
    const persisted = withDismissed(parseDismissed(null), "fp1", stop70, 5000);
    for (const merged of [mergeDismissed(persisted, unsaved), mergeDismissed(unsaved, persisted)]) expect(isDismissed(merged, "fp1", stop70)).toBe(true);
    const written = withDismissed(mergeDismissed(persisted, unsaved), "fp1", { ...warn, family: "claude" }, 6000);
    expect(isDismissed(parseDismissed(JSON.stringify(written)), "fp1", stop70)).toBe(true);
  });
  test("settings-return-1 r4：成功读取推进失效，未关闭中间线的记录刷新仍有效", () => {
    const first = withDismissed({}, "fp1", warn, 1000);
    const changed = observeDismissed(first, "fp1", view([f({ warnPct: 60 })]), 2000);
    const returned = observeDismissed(changed, "fp1", view([f()]), 3000);
    expect(isDismissed(parseDismissed(JSON.stringify(returned)), "fp1", warn)).toBe(false);
    for (const merged of [mergeDismissed(first, returned), mergeDismissed(returned, first)]) {
      expect(isDismissed(merged, "fp1", warn)).toBe(false);
    }
    const closed = withDismissed(returned, "fp1", warn, 4000);
    expect(isDismissed(observeDismissed(closed, "fp1", view([f()]), 5000), "fp1", warn)).toBe(true);
    const off = observeDismissed(closed, "fp1", view([f()], "off"), 6000);
    expect(isDismissed(observeDismissed(off, "fp1", view([f()]), 7000), "fp1", warn)).toBe(false);
  });
  test("dismiss-memory-1 r4：独立关闭同代 warn/stop 的时刻不同也保留并集", () => {
    const a = withDismissed({}, "fp1", warn, 2000);
    const b = withDismissed({}, "fp1", item(STOP), 1000);
    for (const merged of [mergeDismissed(a, b), mergeDismissed(b, a)]) {
      expect(isDismissed(merged, "fp1", warn)).toBe(true);
      expect(isDismissed(merged, "fp1", item(STOP))).toBe(true);
    }
  });
  test("同配置的新 tab 关闭可合入已观察世代；旧关闭不能复活，unknown 不制造新周", () => {
    const old = withDismissed({}, "fp1", warn, 1000);
    const changed = observeDismissed(old, "fp1", view([f({ warnPct: 60 })]), 2000);
    const returned = observeDismissed(changed, "fp1", view([f()]), 3000);
    const stop = withDismissed({}, "fp1", item(STOP), 4000);
    for (const merged of [mergeDismissed(returned, stop), mergeDismissed(stop, returned)]) {
      expect(isDismissed(merged, "fp1", item(STOP))).toBe(true);
      expect(isDismissed(mergeDismissed(merged, old), "fp1", warn)).toBe(false);
    }
    const unknown = observeDismissed(old, "fp1", view([f({ resetAt: null, state: "unknown", weekUsedPct: null })]), 5000);
    expect(isDismissed(observeDismissed(unknown, "fp1", view([f()]), 6000), "fp1", warn)).toBe(true);
  });
  test("migration-dismiss-1 r4：旧数组保留最后世代的全部关闭状态", () => {
    for (const keys of [[warn.key, item(STOP).key], [item(STOP).key, warn.key]]) {
      const migrated = parseDismissed(JSON.stringify({ "fp1|codex": keys }));
      expect(isDismissed(migrated, "fp1", warn)).toBe(true);
      expect(isDismissed(migrated, "fp1", item(STOP))).toBe(true);
    }
  });
  test("存储里的坏数据当没关过", () => {
    expect(parseDismissed(null)).toEqual({});
    expect(parseDismissed("{bad")).toEqual({});
    expect(parseDismissed("[1]")).toEqual({});
    expect(parseDismissed('{"a":1,"d":[],"e":{"gen":"g","since":"x","states":["s"]},"f":{"gen":"g","since":1,"states":[2]}}')).toEqual({});
    expect(parseDismissed('{"r":{"gen":"g","since":5,"states":["warn:half",3]}}')).toEqual({ r: { gen: "g", since: 5, states: ["warn:half"] } });
  });
  test("旧格式（单条 key / key 数组）保留最后世代", () => {
    const old = parseDismissed(JSON.stringify({ "fp1|codex": [item(STOP).key, warn.key], "fp1|claude": warn.key }));
    expect(isDismissed(old, "fp1", warn)).toBe(true);
    expect(isDismissed(old, "fp1", item(STOP))).toBe(true);
    expect(isDismissed(old, "fp1", { ...warn, family: "claude" })).toBe(true);
  });
});

describe("组合：真实 bridge GET 回包 → 提醒", () => {
  const dirs: string[] = [];
  afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });
  const at = "2026-09-28T00:00:00Z";
  const OWNER_BASE: Principal = { id: "owner:self", role: "owner", agents: ["*", "master"], createdAt: at, terminal: true };
  const device = (grant: Grant) => effectivePrincipal({ principal: OWNER_BASE,
    credential: { id: "dev_x", v: 1, type: "bearer", hash: "h", deviceName: "d", grant, createdAt: at, expiresAt: "2099-01-01T00:00:00Z" } });
  const OWNER = device({ agents: ["*"], terminal: true, manage: true });
  const asGranted: ActualSlots = (es) => es.map((e) => ({ codex: e.families.codex ?? 0, claude: e.families.claude ?? 0 }));
  const fact = (pct: number) => ({ weekUsedPct: pct, resetAt: RESET, observedAt: NOW - 1, source: "live" as const });
  async function get(facts: QuotaFacts, lines?: unknown, principal: Principal = OWNER) {
    const dir = mkdtempSync(join(tmpdir(), "qwarn-"));
    dirs.push(dir);
    const lendPath = join(dir, "lend.json");
    writeFileSync(lendPath, JSON.stringify({ version: 2, enabled: true, borrow: [], lend: [{ peer: "team-a", fp: "aaaa-bbbb-cccc-dddd", families: { codex: 3, claude: 2 },
      roles: ["review"], repos: ["o/r"], ordersPerDay: 50, grantedAt: new Date(NOW - 86_400_000).toISOString(), until: new Date(RESET).toISOString() }] }));
    const linesPath = join(dir, "lend-quota-lines.json");
    if (lines) writeFileSync(linesPath, JSON.stringify(lines));
    const api = makeLendQuotaLinesApi({ linesPath, lendPath, now: () => NOW, actual: asGranted, log: () => {}, facts: async () => facts,
      context: async () => ({ contacts: [{ name: "team-a", fp: "aaaa-bbbb-cccc-dddd" }], projects: [] }) });
    return (await api(new Request("http://x/api/v1/lend/quota-lines"), "/lend/quota-lines", principal))!;
  }
  test("默认 70/80：codex 82% 停接、claude 74% 提醒，两族都出", async () => {
    const r = await get({ codex: fact(82), claude: fact(74) });
    const items = warningItems(await r.json() as QuotaLinesView, NOW);
    expect(items.map((i) => [i.family, i.level, i.usedPct, i.stopped, i.resetAt])).toEqual([["codex", "stop", 82, true, RESET], ["claude", "warn", 74, false, RESET]]);
  });
  test("一族没读数 = unknown，不出；另一族照出", async () => {
    const items = warningItems(await (await get({ claude: fact(90) })).json() as QuotaLinesView, NOW);
    expect(items.map((i) => i.family)).toEqual(["claude"]);
  });
  test("模式 off：不出；observe：出但未停接", async () => {
    const lines = (mode: string) => ({ v: 1, mode, families: { codex: { warnPct: 70, stopPct: 80 }, claude: { warnPct: 70, stopPct: 80 } } });
    expect(warningItems(await (await get({ codex: fact(90) }, lines("off"))).json() as QuotaLinesView, NOW)).toEqual([]);
    const obs = warningItems(await (await get({ codex: fact(90) }, lines("observe"))).json() as QuotaLinesView, NOW);
    expect(obs.map((i) => [i.level, i.stopped, i.enforced])).toEqual([["stop", false, false]]);
  });
  test("缩权设备 403（前端 fetchQuotaLines 据此回 null → 不显示）", async () => {
    expect((await get({ codex: fact(90) }, undefined, device({ agents: ["worker"], terminal: true, manage: true }))).status).toBe(403);
  });
});
