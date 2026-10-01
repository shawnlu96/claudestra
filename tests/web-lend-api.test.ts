/**
 * bridge/local-api/lend-grant.ts（i28-R7a）：出借方管理面三条接口。门禁矩阵（owner 本人 + 全权凭据，不过就不起进程）、
 * 授权 / 收回只经 W1 的 `lend grant` / `lend revoke`（argv 形状、`--xx` 注入反例、write 不起进程）、借出单的字段白名单、
 * journal 不存在、收回回包带在跑单快照、grants 与 W1 effectiveLend 一致。全部注入依赖 + 临时目录，不碰生产 ~/.claude-orchestrator。
 */
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handleLocalApi } from "../src/bridge/local-api/index.js";
import { grantArgv, makeLendGrantApi, type LendGrantDeps } from "../src/bridge/local-api/lend-grant.js";
import { effectivePrincipal, type DeviceCredential, type Grant } from "../src/lib/devices.js";
import { readLend, type LendEntry } from "../src/lib/lend-config.js";
import { GRANT_MAX_DAYS, SHELL_SENTENCE } from "../src/lib/lend-grant-rules.js";
import { advance, openLendJournal, recordAsked } from "../src/lib/lend-journal.js";
import { effectiveLend } from "../src/lib/lend-policy.js";
import type { Principal } from "../src/lib/principals.js";

const at = "2026-09-28T00:00:00Z";
const T = Date.parse("2026-10-01T00:00:00Z");
const DAY = 86_400_000;
const iso = (ms: number) => new Date(ms).toISOString();
const cred = (grant: Grant): DeviceCredential => ({ id: "dev_x", v: 1, type: "bearer", hash: "h", deviceName: "d", grant, createdAt: at, expiresAt: "2099-01-01T00:00:00Z" });
const OWNER_BASE: Principal = { id: "owner:self", role: "owner", agents: ["*", "master"], createdAt: at, terminal: true };
const device = (grant: Grant, base: Principal = OWNER_BASE) => effectivePrincipal({ principal: base, credential: cred(grant) });

const DENIED: [string, Principal][] = [
  ["owner 设备 · 部分 scope", device({ agents: ["worker"], terminal: true, manage: true })],
  ["owner 设备 · manage:false", device({ agents: ["*"], terminal: true, manage: false })],
  ["owner 设备 · messages-only", device({ agents: ["*"], terminal: false, manage: false })],
  ["guest 设备", device({ agents: ["*"], terminal: false, manage: true }, { id: "guest:g", role: "external", agents: ["*"], createdAt: at })],
  ["peer token", { id: "token:tok_peer", role: "external", agents: ["*"], peer: "team-a", createdAt: at }],
  ["老的 * Bearer token（能读台账，但不是 owner 本人）", { id: "token:tok_old", role: "external", agents: ["*"], createdAt: at }],
  ["部分 scope 的 Bearer token", { id: "token:tok_s", role: "external", agents: ["worker"], createdAt: at }],
];
const OWNER = device({ agents: ["*"], terminal: true, manage: true });

const FP = "aaaa-bbbb-cccc-dddd";
const dirs: string[] = [];
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

const G = (over: Partial<LendEntry> = {}): LendEntry => ({ peer: "team-a", fp: FP, families: { codex: 5 }, roles: ["review"], repos: ["o/r"], ordersPerDay: 200,
  grantedAt: iso(T - DAY), until: iso(T + 3 * DAY), ...over });
const contacts = [{ name: "team-a", fp: FP }, { name: "team-b", fp: "1111-2222-3333-4444" }, { name: "off", fp: "9", disabled: true }, { name: "nofp" }];

function setup(lend: LendEntry[] | null = [G()], journal = true) {
  const dir = mkdtempSync(join(tmpdir(), "web-lend-api-"));
  dirs.push(dir);
  const lendPath = join(dir, "lend.json");
  if (lend) writeFileSync(lendPath, JSON.stringify({ version: 2, enabled: true, lend, borrow: [] }));
  const journalPath = join(dir, "lend", "journal.sqlite");
  if (journal) seed(journalPath);
  const calls: string[][] = [];
  let reply: unknown = { ok: true, message: "done", warning: SHELL_SENTENCE, lend: { secret: "x" } };
  const deps: Partial<LendGrantDeps> = {
    lendPath, journalPath, now: () => T,
    run: async (args) => { calls.push(args); return reply; },
    context: async () => ({ contacts, projects: [] }),
  };
  return { api: makeLendGrantApi(deps), calls, lendPath, setReply: (r: unknown) => { reply = r; } };
}

const SENTINEL = "SENTINEL_LEAK";
function seed(path: string) {
  const db = openLendJournal(path);
  const preview = { taskId: "T1", repo: "o/r", pr: 7, head: "abc", step: "review" };
  recordAsked(db, { orderId: "o-live", peer: "team-a", fp: FP, family: "codex", preview }, T - 1000);
  advance(db, "o-live", "asked", "claimed", { wire: { order: { x: SENTINEL }, text: SENTINEL }, leaseUntil: T + 60_000 }, T - 900);
  advance(db, "o-live", "claimed", "cloned", { dir: `/tmp/${SENTINEL}` }, T - 800);
  advance(db, "o-live", "cloned", "started", { agent: "lend-w1", sessionId: SENTINEL, startedAt: T - 700, notices: { start: T - 710 } }, T - 700);
  recordAsked(db, { orderId: "o-b", peer: "team-b", fp: "1111", family: "codex", preview }, T - 500);
  recordAsked(db, { orderId: "o-done", peer: "team-a", fp: FP, family: "codex", preview }, T - 2 * DAY);
  advance(db, "o-done", "asked", "claimed", { payload: { s: SENTINEL }, receipt: { r: SENTINEL } }, T - 2 * DAY);
  advance(db, "o-done", "claimed", "stopped", { reason: "收回", notices: { start: T - 2 * DAY, end: { kind: "stopped", why: "收回", sentAt: null } } }, T - DAY);
  recordAsked(db, { orderId: "o-old", peer: "team-a", fp: FP, family: "codex", preview }, T - 9 * DAY);
  advance(db, "o-old", "asked", "declined", { reason: "过期" }, T - 8 * DAY);
  db.close();
}

const req = (path: string, method = "GET", json?: unknown) =>
  new Request(`http://bridge.local/api/v1${path}`, { method, ...(json !== undefined ? { body: JSON.stringify(json), headers: { "content-type": "application/json" } } : {}) });
const GOOD = { peer: "team-a", repos: ["o/r", "o/s"], codex: 5, ordersPerDay: 200, until: "7d" };

describe("门禁矩阵：非 owner 本人全权凭据三条都 403，且不起进程", () => {
  for (const [name, p] of DENIED) {
    test(name, async () => {
      const s = setup();
      for (const [path, method, body] of [["/lend/grants", "GET"], ["/lend/grants", "POST", GOOD], ["/lend/grants/revoke", "POST", { peer: "team-a" }]] as const) {
        const r = await s.api(req(path, method, body), path, p);
        expect(r?.status, `${method} ${path}`).toBe(403);
      }
      expect(s.calls).toEqual([]);
    });
  }

  test("owner 本人全权：GET 200，POST 起 manager", async () => {
    const s = setup();
    expect((await s.api(req("/lend/grants"), "/lend/grants", OWNER))?.status).toBe(200);
    expect((await s.api(req("/lend/grants", "POST", GOOD), "/lend/grants", OWNER))?.status).toBe(200);
    expect(s.calls.length).toBe(1);
  });

  test("挂在 local-api 上：经 handleLocalApi 进来的非 owner 也是 403；别的 lend 路径不归这里", async () => {
    for (const [, p] of DENIED) {
      const r = req("/lend/grants");
      expect((await handleLocalApi(r, new URL(r.url), p))?.status).toBe(403);
    }
    const s = setup();
    expect(await s.api(req("/lend/grants/x"), "/lend/grants/x", OWNER)).toBeNull();
    expect(await s.api(req("/lend/poll", "POST"), "/lend/poll", OWNER)).toBeNull();
  });
});

describe("授权：argv 形状、注入反例、write 拒绝", () => {
  test("值一律 --flag=value，roles 固定 review，peer 在 -- 之后", async () => {
    const s = setup();
    const r = await s.api(req("/lend/grants", "POST", GOOD), "/lend/grants", OWNER);
    expect(s.calls[0]).toEqual(["lend", "grant", "--repos=o/r,o/s", "--until=7d", "--codex=5", "--orders-per-day=200", "--roles=review", "--", "team-a"]);
    expect(await r!.json()).toEqual({ ok: true, message: "done", warning: SHELL_SENTENCE });
  });

  test("注入反例：peer / repos / until 里的 --xx 只会落在值位或 -- 之后", () => {
    const argv = grantArgv({ peer: "--peer=evil", repos: ["--roles=write"], until: "--codex=99", codex: "--x", ordersPerDay: 1 }) as string[];
    expect(argv).toEqual(["lend", "grant", "--repos=--roles=write", "--until=--codex=99", "--codex=--x", "--orders-per-day=1", "--roles=review", "--", "--peer=evil"]);
    const dash = argv.indexOf("--");
    expect(argv.slice(2, dash).every((a) => /^--(repos|until|codex|orders-per-day|roles)=/.test(a))).toBe(true);
    expect(argv.slice(dash + 1)).toEqual(["--peer=evil"]);
  });

  test("收回的 peer 也只走 --peer=值", async () => {
    const s = setup();
    await s.api(req("/lend/grants/revoke", "POST", { peer: "--all" }), "/lend/grants/revoke", OWNER);
    expect(s.calls[0]).toEqual(["lend", "revoke", "--peer=--all"]);
  });

  test("roles 带 write：400，不起进程、不写盘", async () => {
    const s = setup(null);
    for (const roles of [["review", "write"], ["write"]]) {
      const r = await s.api(req("/lend/grants", "POST", { ...GOOD, roles }), "/lend/grants", OWNER);
      expect(r?.status).toBe(400);
      expect(((await r!.json()) as { error: string }).error).toMatch(/write/);
    }
    expect(s.calls).toEqual([]);
    expect((await readLend(s.lendPath)).status).toBe("missing");
  });

  test("类型不对：400 不起进程；claude 名额不往 CLI 带", async () => {
    const s = setup();
    for (const bad of [{ ...GOOD, peer: "" }, { ...GOOD, repos: [] }, { ...GOOD, repos: ["a/b,c/d"] }, { ...GOOD, until: 7 }, { ...GOOD, codex: {} }, [1]]) {
      expect((await s.api(req("/lend/grants", "POST", bad), "/lend/grants", OWNER))?.status).toBe(400);
    }
    expect(s.calls).toEqual([]);
    await s.api(req("/lend/grants", "POST", { ...GOOD, claude: 3 }), "/lend/grants", OWNER);
    expect(s.calls[0].join(" ")).not.toMatch(/claude/);
  });

  test("CLI 拒了：原话回给前端（400），forbidden 回 403", async () => {
    const s = setup();
    s.setReply({ ok: false, error: "until 超过 7 天" });
    const r = await s.api(req("/lend/grants", "POST", GOOD), "/lend/grants", OWNER);
    expect(r?.status).toBe(400);
    expect(await r!.json()).toEqual({ ok: false, error: "until 超过 7 天" });
    s.setReply({ ok: false, code: "forbidden", error: "只许 owner" });
    expect((await s.api(req("/lend/grants", "POST", GOOD), "/lend/grants", OWNER))?.status).toBe(403);
  });
});

describe("GET：字段白名单、journal 不存在、grants 与 effectiveLend 一致", () => {
  test("单子只带白名单字段，wire.text / payload / receipt / dir / sessionId 不出", async () => {
    const s = setup();
    const r = await s.api(req("/lend/grants"), "/lend/grants", OWNER);
    const text = await r!.text();
    expect(text).not.toContain(SENTINEL);
    const j = JSON.parse(text);
    expect(Object.keys(j).sort()).toEqual(["grants", "maxDays", "ok", "orders", "peers", "shellSentence", "writeOpen"]);
    expect(j).toMatchObject({ writeOpen: false, maxDays: GRANT_MAX_DAYS, shellSentence: SHELL_SENTENCE });
    const KEYS = ["agent", "family", "notices", "orderId", "peer", "pr", "reason", "repo", "startedAt", "state", "step", "taskId", "updatedAt"];
    for (const o of j.orders) expect(Object.keys(o).sort()).toEqual(KEYS);
    expect(j.orders.map((o: { orderId: string }) => o.orderId)).toEqual(["o-b", "o-live", "o-done"]); // 在跑在前，8 天前结束的不列
    expect(j.orders[1]).toMatchObject({ repo: "o/r", pr: 7, step: "review", agent: "lend-w1", notices: { start: T - 710 } });
    expect(j.orders[2].notices).toEqual({ start: T - 2 * DAY, end: { kind: "stopped", why: "收回", sentAt: null } });
    expect(j.peers).toEqual([{ name: "team-a", fp: FP }, { name: "team-b", fp: "1111-2222-3333-4444" }]);
  });

  test("journal 不存在：orders 空列表", async () => {
    const s = setup([G()], false);
    const j = await (await s.api(req("/lend/grants"), "/lend/grants", OWNER))!.json() as { orders: unknown[] };
    expect(j.orders).toEqual([]);
  });

  test("每条声明的 problem 与 W1 effectiveLend 一致（暂停 / 过期 / 指纹变了 / 联系人没了 / write）", async () => {
    const lend = [G({ peer: "w", roles: ["review", "write"] }), G(), G({ peer: "team-b", fp: "1111-2222-3333-4444", paused: { reason: "旧条目" } }), G({ peer: "nofp", until: iso(T - 1) }),
      G({ peer: "gone", fp: "eeee-eeee-eeee-eeee" })];
    const s = setup(lend);
    const j = await (await s.api(req("/lend/grants"), "/lend/grants", OWNER))!.json() as { grants: { peer: string; problem: string | null; paused: string | null }[] };
    const eff = effectiveLend(await readLend(s.lendPath), contacts, [], T);
    expect(j.grants.length).toBe(5);
    expect(eff.lend.map((e) => e.peer)).toEqual(["team-a"]);
    expect(j.grants.filter((g) => !g.problem).map((g) => g.peer)).toEqual(eff.lend.map((e) => e.peer));
    for (const g of j.grants.filter((x) => x.problem)) expect(eff.dropped).toContain(`lend ${g.peer}：${g.problem}`);
    expect(j.grants.find((g) => g.peer === "team-b")?.paused).toBe("旧条目");
  });

  test("lend.json 无效（例如手改坏了指纹）：整份按关，grants 空", async () => {
    const s = setup([G({ fp: "ffff" })]);
    const j = await (await s.api(req("/lend/grants"), "/lend/grants", OWNER))!.json() as { grants: unknown[] };
    expect((await readLend(s.lendPath)).status).toBe("invalid");
    expect(j.grants).toEqual([]);
  });
});

describe("收回", () => {
  test("成功：回包带这个 peer 在跑的单（别的 peer 的不带）", async () => {
    const s = setup();
    const r = await s.api(req("/lend/grants/revoke", "POST", { peer: "team-a" }), "/lend/grants/revoke", OWNER);
    expect(s.calls[0]).toEqual(["lend", "revoke", "--peer=team-a"]);
    const j = await r!.json() as { ok: boolean; orders: { orderId: string; state: string }[] };
    expect(j.ok).toBe(true);
    expect(j.orders.map((o) => [o.orderId, o.state])).toEqual([["o-live", "started"]]);
  });

  test("不带 peer = 全部收回；CLI 失败不带快照、回非 2xx", async () => {
    const s = setup();
    await s.api(req("/lend/grants/revoke", "POST", {}), "/lend/grants/revoke", OWNER);
    expect(s.calls[0]).toEqual(["lend", "revoke"]);
    s.setReply({ ok: false, error: "lend 里没有 peer x" });
    const r = await s.api(req("/lend/grants/revoke", "POST", { peer: "x" }), "/lend/grants/revoke", OWNER);
    expect(r?.status).toBe(400);
    expect(await r!.json()).toEqual({ ok: false, error: "lend 里没有 peer x" });
  });

  test("GET 只接 GET / POST；其它方法 405", async () => {
    const s = setup();
    expect((await s.api(req("/lend/grants", "DELETE"), "/lend/grants", OWNER))?.status).toBe(405);
    expect((await s.api(req("/lend/grants/revoke"), "/lend/grants/revoke", OWNER))?.status).toBe(405);
  });
});
