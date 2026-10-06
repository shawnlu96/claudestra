/**
 * bridge/local-api/lend-quota-lines.ts（QLINE1）：门禁矩阵（owner 本人 + 全权 manage；guest / peer / 停用 / 缩权 / manage:false 拒，且拒时不读盘不读 body）、
 * GET 形状与脱敏（只有家族 / 百分比 / 时刻 / 来源 / 阈值 / 状态 / 容量合计）、实际可接容量与 hello 同口径（Claude 未就绪 / QP1 暂停 → 0，读不到 = null）、
 * 提醒区间按批准缩法、POST 改一族不动另一族、非法参数零副作用、写失败不报已生效、坏配置可重存修好、
 * 出错一律固定码（ENOTDIR 等带本机路径的原始错误、配置里的未知字段名只进本机日志）。
 */
import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { journalActualSlots, makeLendQuotaLinesApi, type ActualSlots, type LendQuotaLinesDeps } from "../src/bridge/local-api/lend-quota-lines.js";
import type { LendEntry } from "../src/lib/lend-config.js";
import { pauseForQuota } from "../src/lib/lend-health.js";
import { openLendJournal } from "../src/lib/lend-journal.js";
import { effectivePrincipal, type DeviceCredential, type Grant } from "../src/lib/devices.js";
import type { QuotaFacts } from "../src/lib/lend-quota-line-facts.js";
import type { Principal } from "../src/lib/principals.js";

const at = "2026-09-28T00:00:00Z";
const NOW = Date.parse("2026-10-06T06:00:00Z");
const RESET = NOW + 3 * 86_400_000;
const FP = "aaaa-bbbb-cccc-dddd";
const cred = (grant: Grant): DeviceCredential => ({ id: "dev_x", v: 1, type: "bearer", hash: "h", deviceName: "d", grant, createdAt: at, expiresAt: "2099-01-01T00:00:00Z" });
const OWNER_BASE: Principal = { id: "owner:self", role: "owner", agents: ["*", "master"], createdAt: at, terminal: true };
const device = (grant: Grant, base: Principal = OWNER_BASE) => effectivePrincipal({ principal: base, credential: cred(grant) });
const OWNER = device({ agents: ["*"], terminal: true, manage: true });
const DENIED: [string, Principal][] = [
  ["owner 设备 · 部分 scope（缩权）", device({ agents: ["worker"], terminal: true, manage: true })],
  ["owner 设备 · manage:false", device({ agents: ["*"], terminal: true, manage: false })],
  ["guest 设备", device({ agents: ["*"], terminal: false, manage: true }, { id: "guest:g", role: "external", agents: ["*"], createdAt: at })],
  ["peer token", { id: "token:tok_peer", role: "external", agents: ["*"], peer: "team-a", createdAt: at }],
  ["停用的 owner", { ...OWNER_BASE, disabled: true }],
  ["老的 * Bearer token", { id: "token:tok_old", role: "external", agents: ["*"], createdAt: at }],
];

const dirs: string[] = [];
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

/** 默认：实际可接 = 授权名额（Claude 已就绪、Codex 没暂停） */
const asGranted: ActualSlots = (es) => es.map((e) => ({ codex: e.families.codex ?? 0, claude: e.families.claude ?? 0 }));
const fact = (pct: number, observedAt = NOW - 1) => ({ weekUsedPct: pct, resetAt: RESET, observedAt, source: "live" as const });

function setup(facts: QuotaFacts = {}, actual: ActualSlots = asGranted) {
  const dir = mkdtempSync(join(tmpdir(), "qline-api-"));
  dirs.push(dir);
  const lendPath = join(dir, "lend.json");
  const until = new Date(NOW + 3 * 86_400_000).toISOString();
  const lend = [{ peer: "team-a", fp: FP, families: { codex: 3, claude: 2 }, roles: ["review"], repos: ["o/r"], ordersPerDay: 50,
    grantedAt: new Date(NOW - 86_400_000).toISOString(), until }];
  writeFileSync(lendPath, JSON.stringify({ version: 2, enabled: true, lend, borrow: [] }));
  const lendBefore = readFileSync(lendPath, "utf8");
  let io = 0;
  const logs: string[] = [];
  const deps: Partial<LendQuotaLinesDeps> = {
    linesPath: join(dir, "lend-quota-lines.json"), lendPath, now: () => NOW, actual, log: (m) => logs.push(m),
    facts: async () => { io++; return facts; }, context: async () => { io++; return { contacts: [{ name: "team-a", fp: FP }], projects: [] }; },
  };
  return { api: makeLendQuotaLinesApi(deps), deps, dir, linesPath: deps.linesPath!, lendPath, lendBefore, io: () => io, logs };
}
/** 回包按任意 JSON 读（形状由 toEqual 钉住） */
const json = async (r: Response | null): Promise<any> => r!.json();
const req = (method: string, body?: unknown) => new Request("http://x/api/v1/lend/quota-lines", {
  method, ...(body === undefined ? {} : { body: typeof body === "string" ? body : JSON.stringify(body), headers: { "content-type": "application/json" } }),
});

describe("门禁", () => {
  for (const [name, p] of DENIED) {
    test(`${name}：GET / POST 都 403，不读盘、不读 body、不写`, async () => {
      const s = setup();
      expect((await s.api(req("GET"), "/lend/quota-lines", p))!.status).toBe(403);
      const post = req("POST", { family: "codex", warnPct: 1, stopPct: 2 });
      expect((await s.api(post, "/lend/quota-lines", p))!.status).toBe(403);
      expect(post.bodyUsed).toBe(false);
      expect(s.io()).toBe(0);
      expect(existsSync(s.linesPath)).toBe(false);
    });
  }
  test("别的路径不接", async () => {
    expect(await setup().api(req("GET"), "/lend/grants", OWNER)).toBeNull();
  });
});

describe("GET", () => {
  test("缺配置 = 默认 70/80 on；状态由服务端判好；容量合计按授权与收窄", async () => {
    const s = setup({ codex: fact(80), claude: { ...fact(69), source: "live_stale" } });
    const r = await s.api(req("GET"), "/lend/quota-lines", OWNER);
    const j = await json(r);
    expect(j).toEqual({
      ok: true, config: { status: "missing", error: null, mode: "on" }, at: NOW,
      families: [
        { family: "codex", warnPct: 70, stopPct: 80, weekUsedPct: 80, resetAt: RESET, observedAt: NOW - 1, source: "live", freshness: "fresh",
          state: "stop", mode: "on", limit: "zero", wouldLimit: "zero", granted: 3, lineCap: 0, available: 3, slots: 0 },
        { family: "claude", warnPct: 70, stopPct: 80, weekUsedPct: 69, resetAt: RESET, observedAt: NOW - 1, source: "live_stale", freshness: "last_known",
          state: "below", mode: "on", limit: "none", wouldLimit: "none", granted: 2, lineCap: 2, available: 2, slots: 2 },
      ],
    });
  });
  test("提醒区间（已批缩法）：codex 75%、授权 3 → lineCap 1、slots 1；claude 70%、2 → 1", async () => {
    const j = await json(await setup({ codex: fact(75), claude: fact(70) }).api(req("GET"), "/lend/quota-lines", OWNER));
    expect(j.families.map((f: any) => [f.state, f.limit, f.granted, f.lineCap, f.available, f.slots])).toEqual([["warn", "half", 3, 1, 3, 1], ["warn", "half", 2, 1, 2, 1]]);
  });
  test("实际容量与 hello 同口径：Claude 未就绪 → available / slots 0，lineCap 仍是授权上的理论值", async () => {
    const notReady: ActualSlots = (es) => es.map((e) => ({ codex: e.families.codex ?? 0, claude: 0 }));
    const j = await json(await setup({ claude: fact(10) }, notReady).api(req("GET"), "/lend/quota-lines", OWNER));
    expect(j.families[1]).toMatchObject({ family: "claude", granted: 2, lineCap: 2, available: 0, slots: 0 });
  });
  test("实际容量读不到：available / slots = null（未知），原因只进日志", async () => {
    const s = setup({}, () => { throw new Error(`SQLITE_CANTOPEN ${"/Users/x/secret/journal.sqlite"}`); });
    const r = await s.api(req("GET"), "/lend/quota-lines", OWNER);
    const text = await r!.text();
    expect(JSON.parse(text).families.map((f: any) => [f.available, f.slots])).toEqual([[null, null], [null, null]]);
    expect(text).not.toContain("/Users/x");
    expect(s.logs.join("\n")).toContain("SQLITE_CANTOPEN");
  });
  test("读不到额度 = unknown（百分比 null），不显示成 0%", async () => {
    const j = await json(await setup({}).api(req("GET"), "/lend/quota-lines", OWNER));
    expect(j.families.map((f: { state: string; weekUsedPct: unknown }) => [f.state, f.weekUsedPct])).toEqual([["unknown", null], ["unknown", null]]);
  });
  test("回包不含路径 / 账户 / 凭据样的字段", async () => {
    const s = setup({ codex: fact(10, NOW) });
    const text = await (await s.api(req("GET"), "/lend/quota-lines", OWNER))!.text();
    expect(text).not.toContain(s.linesPath);
    expect(text).not.toContain("team-a");
    expect(text).not.toMatch(/token|account|session|email|\/Users\//i);
  });
  test("坏配置：status invalid + 固定码，按默认执行；原始原因只进日志", async () => {
    const s = setup();
    writeFileSync(s.linesPath, "{bad");
    const j = await json(await s.api(req("GET"), "/lend/quota-lines", OWNER));
    expect(j.config).toEqual({ status: "invalid", error: "config_unreadable", mode: "on" });
    expect(j.families[0]).toMatchObject({ warnPct: 70, stopPct: 80 });
    expect(s.logs.join("\n")).toContain("JSON");
  });
  test("配置里的未知字段名不出 bridge：config_invalid", async () => {
    const s = setup();
    writeFileSync(s.linesPath, JSON.stringify({ v: 1, mode: "on", families: { codex: { warnPct: 1, stopPct: 2 }, claude: { warnPct: 3, stopPct: 4 } }, leak_me_7f3a: 1 }));
    const r = await s.api(req("GET"), "/lend/quota-lines", OWNER);
    const text = await r!.text();
    expect(JSON.parse(text).config).toEqual({ status: "invalid", error: "config_invalid", mode: "on" });
    expect(text).not.toContain("leak_me_7f3a");
    expect(s.logs.join("\n")).toContain("leak_me_7f3a");
  });
  test("读配置 ENOTDIR（父级是普通文件）：回包不含本机路径", async () => {
    const s = setup();
    const blocker = join(s.dir, "blk");
    writeFileSync(blocker, "x");
    const api = makeLendQuotaLinesApi({ ...s.deps, linesPath: join(blocker, "q.json") });
    const text = await (await api(req("GET"), "/lend/quota-lines", OWNER))!.text();
    expect(JSON.parse(text).config).toEqual({ status: "invalid", error: "config_unreadable", mode: "on" });
    expect(text).not.toContain(s.dir);
    expect(text).not.toMatch(/ENOTDIR|\/private\/|\/var\/|\/tmp\//);
    expect(s.logs.join("\n")).toContain("ENOTDIR");
  });
});

describe("POST", () => {
  test("改 codex：写盘、回最新视图；claude 不变；lend.json 一字不动", async () => {
    const s = setup({ codex: fact(55, NOW) });
    const r = await s.api(req("POST", { family: "codex", warnPct: 40, stopPct: 50 }), "/lend/quota-lines", OWNER);
    expect(r!.status).toBe(200);
    const j = await json(r);
    expect(j.config).toEqual({ status: "ok", error: null, mode: "on" });
    expect(j.families[0]).toMatchObject({ family: "codex", warnPct: 40, stopPct: 50, state: "stop", slots: 0 });
    expect(j.families[1]).toMatchObject({ family: "claude", warnPct: 70, stopPct: 80 });
    expect(JSON.parse(readFileSync(s.linesPath, "utf8")).families.claude).toEqual({ warnPct: 70, stopPct: 80 });
    expect(readFileSync(s.lendPath, "utf8")).toBe(s.lendBefore);
  });
  const bad: [string, unknown][] = [
    ["坏 JSON", "{"], ["未知字段", { family: "codex", warnPct: 1, stopPct: 2, x: 1 }], ["缺家族", { warnPct: 1, stopPct: 2 }],
    ["提醒 >= 停", { family: "claude", warnPct: 80, stopPct: 80 }], ["越界", { family: "claude", warnPct: 1, stopPct: 101 }], ["空", {}],
  ];
  for (const [name, b] of bad) {
    test(`非法（${name}）：400，零副作用`, async () => {
      const s = setup();
      writeFileSync(s.linesPath, JSON.stringify({ v: 1, mode: "observe", families: { codex: { warnPct: 1, stopPct: 2 }, claude: { warnPct: 3, stopPct: 4 } } }));
      const before = readFileSync(s.linesPath, "utf8");
      const r = await s.api(req("POST", b), "/lend/quota-lines", OWNER);
      expect(r!.status).toBe(400);
      expect(readFileSync(s.linesPath, "utf8")).toBe(before);
    });
  }
  test("坏配置被这次保存修好：warning 固定码（不带原文件内容 / 原因），原文件另存", async () => {
    const s = setup();
    writeFileSync(s.linesPath, JSON.stringify({ v: 1, leak_me_9c1d: true }));
    const r = await s.api(req("POST", { mode: "observe" }), "/lend/quota-lines", OWNER);
    const text = await r!.text();
    const j = JSON.parse(text);
    expect(r!.status).toBe(200);
    expect(j.warning).toBe("replaced_invalid");
    expect(j.config).toMatchObject({ status: "ok", mode: "observe" });
    expect(text).not.toContain("leak_me_9c1d");
    expect(s.logs.join("\n")).toContain("leak_me_9c1d");
  });
  test("写失败（ENOTDIR）：500，ok:false（不报已生效），错误是固定文案、不含本机路径", async () => {
    const s = setup();
    const blocker = join(s.dir, "blk");
    writeFileSync(blocker, "x");
    const api = makeLendQuotaLinesApi({ ...s.deps, linesPath: join(blocker, "q.json") });
    const r = await api(req("POST", { mode: "off" }), "/lend/quota-lines", OWNER);
    expect(r!.status).toBeGreaterThanOrEqual(500);
    const text = await r!.text();
    expect(JSON.parse(text)).toEqual({ ok: false, code: "io", error: "保存额度线配置失败，没有生效（详情见本机日志）" });
    expect(text).not.toContain(s.dir);
    expect(s.logs.join("\n")).toContain("ENOTDIR");
  });
  test("PUT：405", async () => {
    expect((await setup().api(req("PUT", {}), "/lend/quota-lines", OWNER))!.status).toBe(405);
  });
});

describe("journalActualSlots（默认的实际容量口径）", () => {
  // Claude 位由注入的 claudeLendSlots 口径给（真实函数已由 lend-claude-* 测试覆盖）；这里不动进程里的 Claude 就绪缓存，免得串到别的测试文件
  const entry = { peer: "team-a", families: { codex: 3, claude: 2 } } as unknown as LendEntry;
  const journal = (): string => { const d = mkdtempSync(join(tmpdir(), "qline-journal-")); dirs.push(d); return join(d, "journal.sqlite"); };
  test("Claude 位照 claudeLendSlots（未就绪 0 / 就绪 = 名额）；journal 还没建 = Codex 没暂停", () => {
    const path = journal();
    expect(journalActualSlots(path, () => 0)([entry], NOW)).toEqual([{ codex: 3, claude: 0 }]);
    expect(journalActualSlots(path, (e) => e.families.claude ?? 0)([entry], NOW)).toEqual([{ codex: 3, claude: 2 }]);
  });
  test("QP1 Codex 撞额度暂停中 → codex 0（与 hello 的 paused 一致），Claude 不受影响；暂停过期即恢复", () => {
    const path = journal();
    const db = openLendJournal(path);
    pauseForQuota(db, "x", { full: true, resetsAt: NOW + 3_600_000 } as never, NOW, () => {});
    db.close();
    const claude = (e: LendEntry) => e.families.claude ?? 0;
    expect(journalActualSlots(path, claude)([entry], NOW)).toEqual([{ codex: 0, claude: 2 }]);
    expect(journalActualSlots(path, claude)([entry], NOW + 3_600_001)).toEqual([{ codex: 3, claude: 2 }]);
  });
});
