/**
 * bridge/local-api/lend-grant.ts（i28-R7a）：出借方管理面三条接口。门禁矩阵（owner 本人 + 全权凭据，不过就不起进程）、
 * 授权 / 收回只经 W1 的 `lend grant` / `lend revoke`（argv 形状、`--xx` 注入反例、roles 原样传、重授沿用 roles / 模型 / 推理档）、借出单的字段白名单、
 * journal 不存在、收回回包带在跑单快照、grants 与 W1 effectiveLend 一致。全部注入依赖 + 临时目录，不碰生产 ~/.claude-orchestrator。
 */
import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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

describe("授权：argv 形状、注入反例", () => {
  test("值一律 --flag=value，缺失字段交给 CLI 沿用，peer 在 -- 之后", async () => {
    const s = setup();
    const r = await s.api(req("/lend/grants", "POST", GOOD), "/lend/grants", OWNER);
    expect(s.calls[0]).toEqual(["lend", "grant", "--repos=o/r,o/s", "--until=7d", "--codex=5", "--orders-per-day=200", "--keep-unset=roles,codex-model,codex-effort", "--", "team-a"]);
    expect(await r!.json()).toEqual({ ok: true, message: "done", warning: SHELL_SENTENCE });
  });

  test("注入反例：peer / repos / until 里的 --xx 只会落在值位或 -- 之后", () => {
    const argv = grantArgv({ peer: "--peer=evil", repos: ["--roles=write"], until: "--codex=99", codex: "--x", ordersPerDay: 1, codexModel: "--roles=write",
      codexEffort: "-- x" }) as string[];
    expect(argv).toEqual(["lend", "grant", "--repos=--roles=write", "--until=--codex=99", "--codex=--x", "--orders-per-day=1", "--codex-model=--roles=write",
      "--codex-effort=-- x", "--keep-unset=roles", "--", "--peer=evil"]);
    const dash = argv.indexOf("--");
    expect(argv.slice(2, dash).every((a) => /^--(repos|until|codex|orders-per-day|codex-model|codex-effort|roles|keep-unset)=/.test(a))).toBe(true);
    expect(argv.slice(dash + 1)).toEqual(["--peer=evil"]);
  });

  test("收回的 peer 也只走 --peer=值", async () => {
    const s = setup();
    await s.api(req("/lend/grants/revoke", "POST", { peer: "--all" }), "/lend/grants/revoke", OWNER);
    expect(s.calls[0]).toEqual(["lend", "revoke", "--peer=--all"]);
  });

  test("roles：review / write 任意非空组合去重后原样传；空数组、null、不认得的值 400，不起进程、不写盘", async () => {
    const s = setup(null);
    const rolesOf = async (roles: unknown) => {
      await s.api(req("/lend/grants", "POST", { ...GOOD, roles }), "/lend/grants", OWNER);
      return s.calls.at(-1)!.find((a) => a.startsWith("--roles="));
    };
    expect(await rolesOf(["review", "write"])).toBe("--roles=review,write");
    expect(await rolesOf(["write"])).toBe("--roles=write");
    expect(await rolesOf(["write", "review", "write"])).toBe("--roles=write,review");
    const n = s.calls.length;
    for (const roles of [[], null, "write", ["admin"], ["review", "admin"], ["Write"], [1]]) {
      const r = await s.api(req("/lend/grants", "POST", { ...GOOD, roles }), "/lend/grants", OWNER);
      expect(r?.status, JSON.stringify(roles)).toBe(400);
      expect(((await r!.json()) as { error: string }).error).toMatch(/roles/);
    }
    expect(s.calls.length).toBe(n);
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
    expect(j).toMatchObject({ writeOpen: true, maxDays: GRANT_MAX_DAYS, shellSentence: SHELL_SENTENCE });
    const KEYS = ["agent", "family", "live", "notices", "orderId", "peer", "pr", "reason", "repo", "startedAt", "state", "step", "taskId", "updatedAt"];
    for (const o of j.orders) expect(Object.keys(o).sort()).toEqual(KEYS);
    expect(j.orders.map((o: { orderId: string }) => o.orderId)).toEqual(["o-b", "o-live", "o-done"]); // 在跑在前，8 天前结束的不列
    expect(j.orders.map((o: { live: boolean }) => o.live)).toEqual([true, true, false]); // live 由 bridge 按 W1 LIVE_STATES 判
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

  test("不带 peer = 全部收回；CLI 失败且条目还在：不带快照、回非 2xx", async () => {
    const s = setup();
    await s.api(req("/lend/grants/revoke", "POST", {}), "/lend/grants/revoke", OWNER);
    expect(s.calls[0]).toEqual(["lend", "revoke"]);
    s.setReply({ ok: false, error: "等 lend 锁超时" });
    const r = await s.api(req("/lend/grants/revoke", "POST", { peer: "team-a" }), "/lend/grants/revoke", OWNER);
    expect(r?.status).toBe(400);
    expect(await r!.json()).toEqual({ ok: false, error: "等 lend 锁超时" });
    const all = await s.api(req("/lend/grants/revoke", "POST", {}), "/lend/grants/revoke", OWNER);
    expect(all?.status).toBe(400);
  });

  test("超时但已删：CLI 停 worker 时被强杀，lend.json 里条目已不在 → 按收回成功回、带快照，CLI 原话进 warning", async () => {
    const s = setup([G(), G({ peer: "team-b", fp: "1111-2222-3333-4444" })]);
    s.setReply({ ok: false, error: "manager lend 超时（>50s）已强杀" });
    writeFileSync(s.lendPath, JSON.stringify({ version: 2, enabled: true, lend: [G({ peer: "team-b", fp: "1111-2222-3333-4444" })], borrow: [] }));
    const r = await s.api(req("/lend/grants/revoke", "POST", { peer: "team-a" }), "/lend/grants/revoke", OWNER);
    expect(r?.status).toBe(200);
    const j = await r!.json() as { ok: boolean; warning: string; orders: { orderId: string }[] };
    expect(j.ok).toBe(true);
    expect(j.warning).toBe("manager lend 超时（>50s）已强杀");
    expect(j.orders.map((o) => o.orderId)).toEqual(["o-live"]);
    // 全部收回：总开关还开着、还有条目 = 没收回
    expect((await s.api(req("/lend/grants/revoke", "POST", {}), "/lend/grants/revoke", OWNER))?.status).toBe(400);
    writeFileSync(s.lendPath, JSON.stringify({ version: 2, enabled: false, lend: [], borrow: [] }));
    expect((await s.api(req("/lend/grants/revoke", "POST", {}), "/lend/grants/revoke", OWNER))?.status).toBe(200);
  });

  test("GET 只接 GET / POST；其它方法 405", async () => {
    const s = setup();
    expect((await s.api(req("/lend/grants", "DELETE"), "/lend/grants", OWNER))?.status).toBe(405);
    expect((await s.api(req("/lend/grants/revoke"), "/lend/grants/revoke", OWNER))?.status).toBe(405);
  });
});

describe("重授沿用：请求体没带的字段交给 CLI 在写锁内沿用", () => {
  const KEPT = G({ roles: ["review", "write"], codexModel: "gpt-6-astra", codexEffort: "xhigh" });
  const post = async (s: ReturnType<typeof setup>, body: Record<string, unknown>) => {
    const r = await s.api(req("/lend/grants", "POST", body), "/lend/grants", OWNER);
    return { status: r!.status, argv: s.calls.at(-1) };
  };
  const tail = (argv: string[] | undefined) => argv!.slice(argv!.indexOf("--orders-per-day=200") + 1);

  test("没带：只传继承字段名；peer 名与指纹均原样交给 CLI", async () => {
    const s = setup([KEPT]);
    expect(tail((await post(s, GOOD)).argv)).toEqual(["--keep-unset=roles,codex-model,codex-effort", "--", "team-a"]);
    expect(tail((await post(s, { ...GOOD, peer: FP.toUpperCase() })).argv)).toEqual(["--keep-unset=roles,codex-model,codex-effort", "--", FP.toUpperCase()]);
  });

  test("带了：用新值覆盖（roles 收窄也照传）；null：不传，CLI 规则即清掉；只清一个，另一个照旧沿用", async () => {
    const s = setup([KEPT]);
    expect(tail((await post(s, { ...GOOD, roles: ["review"], codexModel: "gpt-6-sol", codexEffort: "high" })).argv))
      .toEqual(["--codex-model=gpt-6-sol", "--codex-effort=high", "--roles=review", "--", "team-a"]);
    expect(tail((await post(s, { ...GOOD, codexModel: null })).argv)).toEqual(["--keep-unset=roles,codex-effort", "--", "team-a"]);
    expect(tail((await post(s, { ...GOOD, codexModel: null, codexEffort: null })).argv)).toEqual(["--keep-unset=roles", "--", "team-a"]);
  });

  test("不存在 / 暂停 / 过期条目均不在 bridge 判定：只传缺失字段", async () => {
    const s = setup([KEPT, G({ peer: "team-b", fp: "1111-2222-3333-4444", roles: ["write"], codexModel: "m1", paused: { reason: "旧" }, until: iso(T - 1) })]);
    expect(tail((await post(s, { ...GOOD, peer: "stranger" })).argv)).toEqual(["--keep-unset=roles,codex-model,codex-effort", "--", "stranger"]);
    expect(tail((await post(s, { ...GOOD, peer: "team-b" })).argv)).toEqual(["--keep-unset=roles,codex-model,codex-effort", "--", "team-b"]);
    const fresh = setup(null);
    expect(tail((await post(fresh, GOOD)).argv)).toEqual(["--keep-unset=roles,codex-model,codex-effort", "--", "team-a"]);
  });

  test("POST 不读 lend.json / 联系人：坏文件交 CLI 拒绝，错误原样回传", async () => {
    const s = setup(null);
    writeFileSync(s.lendPath, "{oops");
    s.setReply({ ok: false, error: "lend.json 无效，已按关处理" });
    for (const body of [GOOD, { ...GOOD, roles: ["review"] }, { ...GOOD, roles: ["review"], codexModel: null, codexEffort: "high" }]) {
      expect((await post(s, body)).status).toBe(400);
    }
    expect(s.calls.length).toBe(3);
    const api = makeLendGrantApi({ lendPath: s.lendPath, context: async () => { throw new Error("POST 不应读联系人"); },
      run: async () => ({ ok: false, error: "CLI 拒写坏文件" }) });
    const r = await api(req("/lend/grants", "POST", GOOD), "/lend/grants", OWNER);
    expect(await r!.json()).toEqual({ ok: false, error: "CLI 拒写坏文件" });
    expect(readFileSync(s.lendPath, "utf8")).toBe("{oops");
  });

  test("模型字段类型不对：400 不起进程", async () => {
    const s = setup([KEPT]);
    for (const bad of [{ codexModel: 5 }, { codexModel: "" }, { codexEffort: false }, { codexEffort: ["xhigh"] }, { codexModel: "a\0b" }]) {
      expect((await post(s, { ...GOOD, ...bad })).status, JSON.stringify(bad)).toBe(400);
    }
    expect(s.calls).toEqual([]);
  });

  function cliSetup() {
    const state = mkdtempSync(join(tmpdir(), "web-lend-e2e-"));
    dirs.push(state);
    writeFileSync(join(state, "registry.json"), JSON.stringify({ socket: "", agents: {} }));
    writeFileSync(join(state, "peers.json"), JSON.stringify({ httpPeers: [{ name: "team-a", fp: FP, addedAt: "" }], pendingInvites: [] }));
    mkdirSync(join(state, "lend"), { recursive: true });
    const manager = join(import.meta.dir, "../src/manager.ts");
    const run = async (args: string[]) => {
      const env: Record<string, string | undefined> = { ...process.env, CLAUDESTRA_STATE_DIR: state };
      delete env.DISCORD_CHANNEL_ID;
      const r = Bun.spawnSync([process.execPath, manager, ...args], { env, stdout: "pipe", stderr: "pipe" });
      return JSON.parse(r.stdout.toString().trim().split("\n").at(-1)!);
    };
    const lendPath = join(state, "lend.json");
    const apiWith = (invoke = run) => makeLendGrantApi({ lendPath, journalPath: join(state, "lend", "journal.sqlite"), run: invoke,
      context: async () => ({ contacts: [{ name: "team-a", fp: FP }], projects: [] }) });
    const entry = () => JSON.parse(readFileSync(lendPath, "utf8")).lend[0] as LendEntry;
    return { run, lendPath, entry, apiWith };
  }

  test("P1 真 CLI 端到端：命令行设了 write + 模型 + 推理档，网页（不带这三个字段）重授后盘上原值都在；传 null 才清掉", async () => {
    const { run, entry, lendPath, apiWith } = cliSetup();
    const api = apiWith();
    expect(await run(["lend", "grant", "team-a", "--repos", "o/r", "--until", "3d", "--roles", "review,write", "--codex-model", "gpt-6-astra", "--codex-effort", "xhigh"]))
      .toMatchObject({ ok: true });
    const web = async (body: Record<string, unknown>) => (await api(req("/lend/grants", "POST", body), "/lend/grants", OWNER))!;
    expect((await web({ peer: "team-a", repos: ["o/r", "o/s"], until: "5d" })).status).toBe(200);
    expect(entry()).toMatchObject({ repos: ["o/r", "o/s"], roles: ["review", "write"], codexModel: "gpt-6-astra", codexEffort: "xhigh" });
    expect((await web({ peer: "team-a", repos: ["o/r"], until: "5d", codexModel: null })).status).toBe(200);
    expect(entry().codexModel).toBeUndefined();
    expect(entry()).toMatchObject({ roles: ["review", "write"], codexEffort: "xhigh" });
    expect((await web({ ...GOOD, roles: ["write"], codexModel: "gpt-6-sol", codexEffort: "high" })).status).toBe(200);
    expect(entry()).toMatchObject({ roles: ["write"], codexModel: "gpt-6-sol", codexEffort: "high" });
    expect((await web({ ...GOOD, codexEffort: null })).status).toBe(200);
    expect(entry()).toMatchObject({ roles: ["write"], codexModel: "gpt-6-sol" });
    expect(entry().codexEffort).toBeUndefined();
    expect((await web({ ...GOOD, codexModel: null, codexEffort: null })).status).toBe(200);
    expect(entry().codexModel).toBeUndefined();
    expect(entry().codexEffort).toBeUndefined();
    const before = readFileSync(lendPath, "utf8");
    expect((await web({ ...GOOD, roles: [] })).status).toBe(400);
    expect(readFileSync(lendPath, "utf8")).toBe(before);
    writeFileSync(lendPath, "{oops");
    expect((await web(GOOD)).status).toBe(400);
    expect((await web({ ...GOOD, roles: ["review"], codexModel: null, codexEffort: null })).status).toBe(400);
    expect(readFileSync(lendPath, "utf8")).toBe("{oops");
  }, 30_000);

  test("真 CLI：首次授权走缺省；暂停 / 过期条目按指纹重授仍沿用三个字段", async () => {
    const { entry, lendPath, apiWith } = cliSetup();
    const api = apiWith();
    const web = (body: Record<string, unknown>) => api(req("/lend/grants", "POST", body), "/lend/grants", OWNER);
    expect((await web(GOOD))?.status).toBe(200);
    expect(entry().roles).toEqual(["review"]);
    expect(entry().codexModel).toBeUndefined();
    expect(entry().codexEffort).toBeUndefined();
    const old = { ...entry(), roles: ["write"], codexModel: "gpt-6-sol", codexEffort: "high", until: iso(0), paused: { reason: "旧授权" } };
    writeFileSync(lendPath, JSON.stringify({ version: 2, enabled: false, lend: [old], borrow: [] }));
    expect((await web({ ...GOOD, peer: FP.toUpperCase() }))?.status).toBe(200);
    expect(entry()).toMatchObject({ peer: "team-a", roles: ["write"], codexModel: "gpt-6-sol", codexEffort: "high" });
    expect(entry().paused).toBeUndefined();
  }, 30_000);

  test("P1 R7e-carry-race：网页已组 argv，CLI 先收窄 roles / 改模型，网页随后写入不能复活旧值", async () => {
    const { run, entry, apiWith } = cliSetup();
    const base = ["lend", "grant", "team-a", "--repos=o/r", "--until=3d"];
    for (const clear of [false, true]) {
      expect(await run([...base, "--roles=review,write", "--codex-model=gpt-6-astra", "--codex-effort=xhigh"])).toMatchObject({ ok: true });
      // 固定旧竞态窗口：bridge 已完成所有预处理，另一个真实 CLI 先提交，再执行网页的 CLI。
      const api = apiWith(async (args) => {
        expect(await run([...base, "--roles=review", ...(clear ? [] : ["--codex-model=gpt-6-sol", "--codex-effort=low"])]))
          .toMatchObject({ ok: true });
        return run(args);
      });
      expect((await api(req("/lend/grants", "POST", GOOD), "/lend/grants", OWNER))?.status).toBe(200);
      expect(entry().roles).toEqual(["review"]);
      expect(entry().codexModel).toBe(clear ? undefined : "gpt-6-sol");
      expect(entry().codexEffort).toBe(clear ? undefined : "low");
    }
  }, 30_000);
});
