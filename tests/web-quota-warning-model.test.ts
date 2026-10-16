/**
 * web/features/lend/quota-warning-model.ts（QWARN1）：只按 bridge 判好的 state / limit 出提醒（warn / stop），unknown / below / mode off 不出肯定提醒；
 * 停接 / 缩减 / 只观察的状态句；两族同时、互不顶替；旧关掉记录的解析（QUOTA1 起只为迁移读一次）。
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
import { parseDismissed, warnStatus, warningItems } from "../web/features/lend/quota-warning-model";

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

describe("状态句", () => {
  const one = (fl: FamilyLine, mode: "on" | "observe" = "on") => warnStatus(warningItems(view([fl], mode), NOW)[0]!);
  test("停接（执行）= 已不再接新活，在跑的活照常", () => expect(one(STOP)).toBe("已不再接新活，在跑的活照常做完"));
  test("提醒（执行）= 仍在接新活、能同时跑的数量减半", () => expect(one(WARN)).toBe("仍在接新活，能同时跑的数量已减半"));
  test("只观察：写明未停接", () => {
    expect(one(f({ ...STOP, limit: "none", mode: "observe" }), "observe")).toBe("只观察：没停，仍在接新活");
    expect(one(f({ ...WARN, limit: "none", mode: "observe" }), "observe")).toBe("只观察：仍在接新活，能同时跑的数量没减");
  });
});

/** 旧额度提醒条的关掉记录：QUOTA1 起只在迁移时读一次（tests/web-quota-notice-model.test.ts 测迁移结果），这里只测解析 */
describe("旧关掉记录（只读）", () => {
  const gen = `${RESET}|70/80|on`;
  test("新格式：保留世代与状态", () => {
    expect(parseDismissed(JSON.stringify({ "fp1|codex": { gen, since: 5, states: ["warn:half", "stop:zero"] } })))
      .toEqual({ "fp1|codex": { gen, since: 5, states: ["warn:half", "stop:zero"] } });
  });
  test("存储里的坏数据当没关过", () => {
    expect(parseDismissed(null)).toEqual({});
    expect(parseDismissed("{bad")).toEqual({});
    expect(parseDismissed("[1]")).toEqual({});
    expect(parseDismissed('{"a":1,"d":[],"e":{"gen":"g","since":"x","states":["s"]},"f":{"gen":"g","since":1,"states":[2]}}')).toEqual({});
    expect(parseDismissed('{"r":{"gen":"g","since":5,"states":["warn:half",3]}}')).toEqual({ r: { gen: "g", since: 5, states: ["warn:half"] } });
  });
  test("旧格式（单条 key / key 数组）保留最后世代的全部状态", () => {
    const warnKey = `${RESET}|warn:half|70/80|on`, stopKey = `${RESET}|stop:zero|70/80|on`, oldKey = `${RESET - 7 * 86_400_000}|warn:half|70/80|on`;
    const old = parseDismissed(JSON.stringify({ "fp1|codex": [oldKey, stopKey, warnKey], "fp1|claude": warnKey }));
    expect(old["fp1|codex"]).toEqual({ gen, since: 0, states: ["stop:zero", "warn:half"] });
    expect(old["fp1|claude"]).toEqual({ gen, since: 0, states: ["warn:half"] });
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
