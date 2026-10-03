/**
 * 借入方管理面的 bridge 端点（src/bridge/local-api/lend-peers-view.ts，i28-R7b）：读门 / 写门、写只经注入的 manager runner、
 * peer 容量与同一 now 下 peerCapacity 逐字段一致、远端行 = LEND_LIVE 集合且不带 excerpt、写回后 borrow status 读回一致、老库不崩。
 * 台账是内存库，lend.json / scheduler.json 在临时目录，联系人与项目注入；不起 bridge、不连 peer。
 */
import type { Database } from "bun:sqlite";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { handleLocalApi } from "../src/bridge/local-api/index.js";
import { borrowView, setBorrowViewDepsForTest, type PeerView, type RemoteRowView } from "../src/bridge/local-api/lend-peers-view.js";
import type { BorrowView } from "@/features/borrow/borrow-api";
import { stalePeers } from "@/features/borrow/borrow-model";
import { effectivePrincipal, type DeviceCredential, type Grant } from "../src/lib/devices.js";
import { peerCapacity, recordHello } from "../src/lib/ledger-lend-peers.js";
import { closeLedger, openLedger } from "../src/lib/ledger-store.js";
import { createTask } from "../src/lib/ledger-write.js";
import { readLend, updateLend } from "../src/lib/lend-config.js";
import { effectiveLend, type LendContact } from "../src/lib/lend-policy.js";
import type { Principal } from "../src/lib/principals.js";
import type { ProjectDef } from "../src/lib/projects.js";
import { parseLedgerArgs } from "../src/manager/ledger-identity.js";
import { BORROW_BOOLS, BORROW_FLAGS, buildBorrowSet } from "../src/manager/lend.js";

const at = "2026-09-29T00:00:00Z";
const cred = (grant: Grant): DeviceCredential => ({ id: "dev_x", v: 1, type: "bearer", hash: "h", deviceName: "d", grant, createdAt: at, expiresAt: "2099-01-01T00:00:00Z" });
const OWNER_BASE: Principal = { id: "owner:self", role: "owner", agents: ["*", "master"], createdAt: at, terminal: true };
const device = (grant: Grant, base: Principal = OWNER_BASE) => effectivePrincipal({ principal: base, credential: cred(grant) });
const OWNER = device({ agents: ["*"], terminal: true, manage: true });
/** 非 owner：读写都 403（读门 canReadLedger、写门 canRunFleet） */
const OUTSIDERS: [string, Principal][] = [
  ["owner 设备 · 部分 scope", device({ agents: ["worker"], terminal: true, manage: true })],
  ["guest 设备", device({ agents: ["*"], terminal: false, manage: true }, { id: "guest:g", role: "external", agents: ["*"], createdAt: at })],
  ["peer token", { id: "token:tok_peer", role: "external", agents: ["*"], peer: "mate", createdAt: at }],
  ["部分 scope 的 Bearer token", { id: "token:tok_s", role: "external", agents: ["worker"], createdAt: at }],
];
/** 过得了读门、过不了写门：不是 owner 本人的全 scope 老 Bearer token（canManage 过渡期放行） */
const LEGACY_FULL: Principal = { id: "token:tok_old", role: "external", agents: ["*"], createdAt: at };

const DAY = 86_400_000;
const NOW = 10_000_000;
const dir = mkdtempSync(join(tmpdir(), "web-borrow-view-"));
const work = join(dir, "repo");
mkdirSync(work, { recursive: true });
const PROJECTS: (ProjectDef & { personal?: boolean })[] = [
  { id: "claude-orchestrator", name: "Claudestra", dirs: [work], createdAt: at },
  { id: "side", name: "Side", dirs: [work], createdAt: at },
  { id: "diary", name: "Diary", dirs: [work], personal: true, createdAt: at },
];
let contacts: LendContact[];
let db: Database;
let lendPath: string;
let schedPath: string;
let calls: string[][];
let runner: (args: string[]) => Promise<Record<string, unknown> | null>;

/** 假 runner：按 CLI 同一个解析器与组条目函数（buildBorrowSet，锁内读旧值）写临时 lend.json —— 写进去的就是 CLI 会写的 */
async function fakeCli(args: string[]): Promise<Record<string, unknown>> {
  const [kind, sub, ...rest] = args;
  expect(kind).toBe("borrow");
  const p = parseLedgerArgs(rest, sub === "off" ? ["peer"] : BORROW_FLAGS, sub === "off" ? [] : BORROW_BOOLS);
  if ("error" in p) return { ok: false, error: p.error };
  if (sub === "off") {
    const err = await updateLend((f) => {
      const i = f.borrow.findIndex((e) => e.peer === p.flags.peer);
      if (i < 0) return "没有";
      f.borrow.splice(i, 1);
      return null;
    }, lendPath);
    return err ? { ok: false, error: err } : { ok: true };
  }
  const built = await updateLend((f) => {
    const b = buildBorrowSet(p.pos[0]!, p.flags, p.bools.has("keep-unset"), f, { contacts, projects: PROJECTS });
    if (!b.ok) return b;
    const i = f.borrow.findIndex((e) => e.peer === b.entry.peer);
    if (i >= 0) f.borrow[i] = b.entry;
    else f.borrow.push(b.entry);
    return b;
  }, lendPath);
  return built.ok ? { ok: true } : { ok: false, error: `${built.error}（manager project-list 看项目 id）` };
}

const writeLend = (borrow: unknown[]) => writeFileSync(lendPath, JSON.stringify({ version: 1, enabled: false, lend: [], borrow }));
const entry = (peer: string, maxOpen = 3, projects = ["claude-orchestrator"]) => ({ peer, projects, roles: ["review"], maxOpen });
const call = (p: Principal, path: string, init?: RequestInit) => handleLocalApi(new Request(`http://x/api/v1${path}`, init), new URL(`http://x/api/v1${path}`), p);
const put = (body: unknown) => ({ method: "PUT", body: JSON.stringify(body), headers: { "content-type": "application/json" } });
const view = async () => (await (await call(OWNER, "/borrow"))!.json()) as Record<string, any>;

beforeEach(() => {
  db = openLedger(":memory:");
  const d = mkdtempSync(join(dir, "case-"));
  lendPath = join(d, "lend.json");
  schedPath = join(d, "scheduler.json");
  calls = [];
  runner = fakeCli;
  contacts = ["mate", "fresh", "stale", "revoked", "expired", "spent", "paused", "old"].map((name) => ({ name }));
  writeFileSync(schedPath, JSON.stringify({ enabled: true, projects: {
    "claude-orchestrator": { maxActiveWorkers: 4, requiredChecks: ["ci"], repoDir: work, remote: { mode: "prefer" } },
    side: { maxActiveWorkers: 1, requiredChecks: ["ci"], repoDir: work, remote: { mode: "off" } },
  } }));
  writeLend([entry("mate")]);
  setBorrowViewDepsForTest({
    db: () => db, lendPath, schedulerPath: schedPath, now: () => NOW,
    context: async () => ({ contacts, projects: PROJECTS }),
    run: async (args) => { calls.push(args); return runner(args); },
  });
});
afterEach(() => {
  setBorrowViewDepsForTest();
  closeLedger(":memory:");
});

describe("鉴权", () => {
  for (const [name, p] of OUTSIDERS) {
    test(`${name}：GET 与两个写端点都 403，runner 没被调，文件字节不变`, async () => {
      const before = [readFileSync(lendPath), readFileSync(schedPath)];
      expect((await call(p, "/borrow"))?.status).toBe(403);
      expect((await call(p, "/borrow/peers/mate", put({ projects: ["side"], maxOpen: 2 })))?.status).toBe(403);
      expect((await call(p, "/borrow/peers/mate", { method: "DELETE" }))?.status).toBe(403);
      expect(calls).toEqual([]);
      expect([readFileSync(lendPath), readFileSync(schedPath)]).toEqual(before);
    });
  }
  test("能读台账但不是 owner 本人：GET 200，写 403 且不动文件", async () => {
    const before = readFileSync(lendPath);
    expect((await call(LEGACY_FULL, "/borrow"))?.status).toBe(200);
    expect((await call(LEGACY_FULL, "/borrow/peers/mate", put({ projects: ["side"], maxOpen: 2 })))?.status).toBe(403);
    expect((await call(LEGACY_FULL, "/borrow/peers/mate", { method: "DELETE" }))?.status).toBe(403);
    expect(calls).toEqual([]);
    expect(readFileSync(lendPath)).toEqual(before);
  });
  test("方法不对 405；别的路径不归这里（null）", async () => {
    expect((await call(OWNER, "/borrow", put({})))?.status).toBe(405);
    expect((await call(OWNER, "/borrow/peers/mate"))?.status).toBe(405);
    expect(await call(OWNER, "/borrow/peers/mate/x")).toBeNull();
    expect(await call(OWNER, "/borrowx")).toBeNull();
  });
});

describe("写路径只经 CLI", () => {
  test("PUT：参数逐字（--keep-unset、值用 --k=v、peer 在 -- 之后、没带的不传），写回后 borrow status 与 GET 一致", async () => {
    const r = await call(OWNER, "/borrow/peers/fresh", put({ projects: ["claude-orchestrator", "side"], maxOpen: 5 }));
    expect(r?.status).toBe(200);
    expect(calls).toEqual([["borrow", "set", "--keep-unset", "--projects=claude-orchestrator,side", "--max-open=5", "--", "fresh"]]);
    const status = effectiveLend(await readLend(lendPath), contacts, PROJECTS, NOW).borrow;
    const v = await view();
    expect(v.borrow.effective).toEqual(status);
    expect(v.peers.map((p: PeerView) => [p.peer, p.maxOpen, p.projects])).toEqual(status.map((b) => [b.peer, b.maxOpen, b.projects]));
  });
  test("DELETE：borrow off --peer，读回少了这一条", async () => {
    expect((await call(OWNER, "/borrow/peers/mate", { method: "DELETE" }))?.status).toBe(200);
    expect(calls).toEqual([["borrow", "off", "--peer", "mate"]]);
    expect((await view()).borrow.effective).toEqual([]);
  });
  test("不在联系人里 / 已禁用 → 404，不起 CLI；声明里还有的旧联系人可以删", async () => {
    contacts = [{ name: "mate", disabled: true }];
    expect((await call(OWNER, "/borrow/peers/ghost", put({ projects: ["side"], maxOpen: 1 })))?.status).toBe(404);
    expect((await call(OWNER, "/borrow/peers/mate", put({ projects: ["side"], maxOpen: 1 })))?.status).toBe(404);
    expect((await call(OWNER, "/borrow/peers/ghost", { method: "DELETE" }))?.status).toBe(404);
    expect(calls).toEqual([]);
    expect((await call(OWNER, "/borrow/peers/mate", { method: "DELETE" }))?.status).toBe(200);
  });
  test("形状不对 → 400，不起 CLI（旗标样的 peer、空项目、越界 maxOpen、旗标样的项目、非 JSON）", async () => {
    contacts.push({ name: "--projects" });
    const bad: [string, RequestInit][] = [
      ["/borrow/peers/a%2Fb", put({ projects: ["side"], maxOpen: 1 })],
      ["/borrow/peers/%E0%A4%A", put({ projects: ["side"], maxOpen: 1 })],
      ["/borrow/peers/mate", put({ projects: [], maxOpen: 1 })],
      ["/borrow/peers/mate", put({ projects: ["side", "side"], maxOpen: 1 })],
      ["/borrow/peers/mate", put({ projects: ["--roles"], maxOpen: 1 })],
      ["/borrow/peers/mate", put({ projects: ["side"], maxOpen: 0 })],
      ["/borrow/peers/mate", put({ projects: ["side"], maxOpen: 21 })],
      ["/borrow/peers/mate", put({ projects: ["side"], maxOpen: 1.5 })],
      ["/borrow/peers/mate", { method: "PUT", body: "{" }],
    ];
    for (const [path, init] of bad) expect([path, (await call(OWNER, path, init))?.status]).toEqual([path, 400]);
    expect(calls).toEqual([]);
  });
  test("旗标样的 peer 名也在 -- 之后：CLI 当它是位置参数", async () => {
    contacts.push({ name: "--max-open" });
    await call(OWNER, "/borrow/peers/--max-open", put({ projects: ["side"], maxOpen: 2 }));
    expect(calls[0]!.slice(-2)).toEqual(["--", "--max-open"]);
    expect(parseLedgerArgs(calls[0]!.slice(2), BORROW_FLAGS, BORROW_BOOLS)).toMatchObject({ pos: ["--max-open"], flags: { "max-open": "2" } });
  });
  test("个人项目选进来：CLI 拒（准入以 buildBorrowEntry 为准），回固定码不透传原文，文件不变", async () => {
    const before = readFileSync(lendPath);
    const r = await call(OWNER, "/borrow/peers/mate", put({ projects: ["diary"], maxOpen: 1 }));
    expect(r?.status).toBe(409);
    const body = await r!.text();
    expect(JSON.parse(body)).toEqual({ ok: false, code: "refused" });
    expect(body).not.toContain("manager");
    expect(readFileSync(lendPath)).toEqual(before);
  });
  test("CLI 起不来 / 说 forbidden：502 / 403", async () => {
    runner = async () => null;
    expect((await call(OWNER, "/borrow/peers/mate", { method: "DELETE" }))?.status).toBe(502);
    runner = async () => ({ ok: false, code: "forbidden", error: "只许 owner" });
    expect((await call(OWNER, "/borrow/peers/mate", { method: "DELETE" }))?.status).toBe(403);
  });
});

const slots = (codex: [number, number], claude: [number, number]) => ({ codex: { total: codex[0], busy: codex[1] }, claude: { total: claude[0], busy: claude[1] } });
const grant = (over: Record<string, unknown> = {}) => ({ until: NOW + DAY, roles: ["review"], repos: ["o/r"], ordersPerDay: 9, ordersLeftToday: 4, ...over });
let seq = 0;
function hello(peer: string, over: Record<string, unknown> = {}, at = NOW - 10_000): void {
  const req = { v: 1, proto: 2, boot: "b", seq: ++seq, grant: grant(), slots: slots([3, 1], [2, 0]), paused: null, ...over };
  recordHello(db, peer, null, req as never, at);
}
let orderN = 0;
function order(peer: string, status: string, taskId = `T${++orderN}`, beat?: unknown): string {
  const id = `ord-${++orderN}`;
  db.prepare(`INSERT INTO lend_orders (orderId, taskId, project, peer, family, step, specRev, round, head, repo, wire, text, sha256, status, leaseMs,
    leaseUntil, createdBy, createdAt, updatedAt, beatAt, beat) VALUES (?, ?, 'claude-orchestrator', ?, 'codex', 'review', 1, 1, 'h', 'o/r', '{}', 't', 's', ?, 60000,
    ?, 'owner', ?, ?, ?, ?)`).run(id, taskId, peer, status, NOW + 60_000, orderN, orderN, beat ? NOW - 5000 : null, beat ? JSON.stringify(beat) : null);
  return id;
}

describe("容量与协议版本如实（同一 now 下与 peerCapacity 逐字段一致）", () => {
  test("表驱动：无 hello、hello 超 180 秒、收回、到期、当日用完、单家族 paused、正常", async () => {
    writeLend(["old", "fresh", "stale", "revoked", "expired", "spent", "paused"].map((p) => entry(p, 2)));
    hello("fresh");
    hello("stale", {}, NOW - 181_000);
    hello("revoked", { grant: null });
    hello("expired", { grant: grant({ until: NOW - 1 }) });
    hello("spent", { grant: grant({ ordersLeftToday: 0 }) });
    hello("paused", { paused: { reason: "codex_quota", until: NOW + 60_000 } });
    order("fresh", "claimed");
    const v = await view();
    for (const p of v.peers as PeerView[]) {
      expect([p.peer, p.capacity]).toEqual([p.peer, JSON.parse(JSON.stringify(peerCapacity(db, p.peer, 2, NOW)))]);
    }
    const by = Object.fromEntries((v.peers as PeerView[]).map((p) => [p.peer, p]));
    expect(by.old!.capacity).toMatchObject({ proto: 1, helloAt: null });
    expect(by.stale!.capacity!.why).toContain("180");
    expect(by.fresh!.capacity).toMatchObject({ proto: 2, open: 1, slots: { codex: 1, claude: 1 }, why: null });
    expect(by.fresh!.reported).toEqual(slots([3, 1], [2, 0]));
    expect(by.fresh!.grant).toEqual({ roles: ["review"], repos: ["o/r"], until: NOW + DAY, ordersLeftToday: 4 });
    expect(by.paused!.capacity!.slots).toEqual({ codex: 0, claude: 2 });
    expect(by.paused!.paused).toEqual({ reason: "codex_quota", until: NOW + 60_000 });
    expect(by.revoked!.grant).toBeNull();
    for (const p of ["revoked", "expired", "spent"]) expect(by[p]!.capacity!.why).toBeTruthy();
  });
  test("projects：overflow / prefer 显示成 balance，off 原样；maxActiveWorkers 照抄；档位缺省 balance、角色缺省 review", async () => {
    const local = { agents: null, localPriority: "balance", roles: ["review"], repo: null, reviewFirst: [] };
    expect((await view()).projects).toEqual([
      { id: "claude-orchestrator", mode: "balance", maxActiveWorkers: 4, ...local },
      { id: "side", mode: "off", maxActiveWorkers: 1, ...local },
    ]);
  });
  test("可选项目不含个人项目；可选 peer 不含禁用联系人；失效条目按码给原因", async () => {
    contacts = [{ name: "mate" }, { name: "fresh", disabled: true }, { name: "stale", fp: "aaaa-bbbb-cccc-dddd" }];
    writeLend([entry("mate", 2, ["claude-orchestrator", "diary", "gone"]), entry("fresh"), { ...entry("stale"), fp: "1111-2222-3333-4444" }, entry("nobody")]);
    const b = (await view()).borrow;
    expect(b.projects.map((p: { id: string }) => p.id)).toEqual(["claude-orchestrator", "side"]);
    expect(b.contacts).toEqual(["mate", "stale"]);
    expect(b.dropped).toEqual([
      { peer: "mate", project: "diary", code: "personal" }, { peer: "mate", project: "gone", code: "project_gone" },
      { peer: "fresh", code: "contact_disabled" }, { peer: "stale", code: "fp_changed" }, { peer: "nobody", code: "contact_gone" },
    ]);
    expect(b.effective).toEqual([entry("mate", 2, ["claude-orchestrator"])]);
  });
});

describe("远端行", () => {
  test("= lend_orders 里 status ∈ LEND_LIVE 的单，带卡标题与 beat 阶段，不带 excerpt", async () => {
    createTask(db, { actor: "owner", now: NOW }, { project: "claude-orchestrator", id: "T-live", title: "活的卡", kind: "code", spec: "s.md", agent: "a" } as never);
    const live = [order("mate", "pooled"), order("mate", "claimed", "T-live", { phase: "working", excerpt: "SECRET-EXCERPT" }), order("fresh", "unknown")];
    for (const s of ["done", "cancelled", "released"]) order("mate", s);
    const r = await call(OWNER, "/borrow");
    const text = await r!.text();
    expect(text).not.toContain("SECRET-EXCERPT");
    const rows = JSON.parse(text).remote as RemoteRowView[];
    expect(rows.map((x) => x.orderId)).toEqual(live);
    expect(rows.map((x) => x.status)).toEqual(["pooled", "claimed", "unknown"]);
    expect(rows[1]).toMatchObject({ taskId: "T-live", title: "活的卡", phase: "working", peer: "mate", family: "codex", step: "review", beatAt: NOW - 5000 });
    expect(rows[0]).toMatchObject({ title: null, phase: null, beatAt: null });
    expect(Object.keys(rows[0]!).sort()).toEqual(["beatAt", "family", "leaseUntil", "orderId", "peer", "phase", "placement", "project", "status", "step", "taskId", "title"]);
    // 卡不在台账里：放置只给固定码，不抛、不带原文
    expect(rows[0]!.placement).toEqual({ error: "unavailable" });
  });
});

describe("声明了但没生效的借入：一条不漏，能删，联系人还在的能重选项目", () => {
  /** 网页实际渲染的两组：生效卡片 + 失效行（stalePeers） */
  const rendered = (v: Record<string, any>) => ({ cards: v.peers.map((p: PeerView) => p.peer), stale: stalePeers(v as BorrowView) });
  test("全部项目失效（删掉 + 个人项目）：失效行里有它，原因 projects_gone，可重选；删除与重选都走 CLI", async () => {
    writeLend([entry("mate", 2, ["gone", "diary"])]);
    const v = await view();
    expect(effectiveLend(await readLend(lendPath), contacts, PROJECTS).borrow).toEqual([]);
    expect(rendered(v)).toEqual({ cards: [], stale: [{ peer: "mate", reason: "projects_gone", maxOpen: 2, canRepick: true }] });
    expect((await call(OWNER, "/borrow/peers/mate", put({ projects: ["side"], maxOpen: 2 })))?.status).toBe(200);
    expect(rendered(await view())).toEqual({ cards: ["mate"], stale: [] });
    writeLend([entry("mate", 2, ["gone"])]);
    expect((await call(OWNER, "/borrow/peers/mate", { method: "DELETE" }))?.status).toBe(200);
    expect(calls.at(-1)).toEqual(["borrow", "off", "--peer", "mate"]);
    expect(rendered(await view())).toEqual({ cards: [], stale: [] });
  });
  test("所有组合：每条声明要么是生效卡片、要么是失效行；联系人失效的只能删", async () => {
    contacts = [{ name: "mate" }, { name: "part" }, { name: "off", disabled: true }, { name: "moved", fp: "aaaa-bbbb-cccc-dddd" }, { name: "allgone" }];
    writeLend([entry("mate"), entry("part", 3, ["side", "gone"]), entry("off"), { ...entry("moved"), fp: "1111-2222-3333-4444" }, entry("nobody"),
      entry("allgone", 4, ["diary"])]);
    const v = await view();
    const r = rendered(v);
    expect([...r.cards, ...r.stale.map((s) => s.peer)].sort()).toEqual(v.borrow.declared.map((e: { peer: string }) => e.peer).sort());
    expect(r.stale.map((s) => [s.peer, s.reason, s.canRepick])).toEqual([
      ["off", "contact_disabled", false], ["moved", "fp_changed", false], ["nobody", "contact_gone", false], ["allgone", "projects_gone", true],
    ]);
    for (const s of r.stale) expect((await call(OWNER, `/borrow/peers/${s.peer}`, { method: "DELETE" }))?.status).toBe(200);
    expect(rendered(await view()).stale).toEqual([]);
  });
});

describe("回归：没有台账 / 没有 lend 表 / 没有 lend.json / scheduler.json 坏了都照常回 200", () => {
  test("台账不存在", async () => {
    setBorrowViewDepsForTest({ db: () => null, lendPath, schedulerPath: schedPath, now: () => NOW, context: async () => ({ contacts, projects: PROJECTS }) });
    const v = await view();
    expect(v).toMatchObject({ ok: true, ledger: false, remote: [] });
    expect(v.peers[0]).toMatchObject({ peer: "mate", capacity: null });
  });
  test("老库没有 lend 表；台账打不开", async () => {
    db.run("DROP TABLE lend_orders");
    db.run("DROP TABLE lend_peers");
    expect(await view()).toMatchObject({ ok: true, ledger: false, remote: [] });
    setBorrowViewDepsForTest({ db: () => { throw new Error("locked"); }, lendPath, schedulerPath: schedPath, context: async () => ({ contacts, projects: PROJECTS }) });
    expect((await borrowView(NOW)).ledger).toBe(false);
  });
  test("没有 lend.json、scheduler.json 坏了", async () => {
    setBorrowViewDepsForTest({ db: () => db, lendPath: join(dir, "none.json"), schedulerPath: lendPath, now: () => NOW, context: async () => ({ contacts, projects: PROJECTS }) });
    const v = await view();
    expect(v).toMatchObject({ ok: true, schedulerOk: false, projects: [], peers: [], borrow: { file: "missing", declared: [] } });
  });
});
