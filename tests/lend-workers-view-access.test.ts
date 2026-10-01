/**
 * i28-W6 A 侧远端行只给 owner、只读：GET /api/v1/lend/workers 的门；fleetState 的 remote 按调用方 allowed 过滤、零远端不带键；
 * runFleet 点名远端行只记 excluded（不发键、不投递）；readTeamActivity 补 remote、零远端时输出逐字不变。
 * 台账是临时文件库，经 setLedgerFeedForTest 换给 bridge 的只读连接，afterAll 换回；不碰真实 tmux（没有在线的 Claude Code 候选）。
 */
import type { Database } from "bun:sqlite";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { fleetState, initFleet, runFleet } from "../src/bridge/fleet/service.js";
import { setLedgerFeedForTest } from "../src/bridge/ledger-feed.js";
import { handleLendWorkersApi } from "../src/bridge/local-api/lend-workers.js";
import { handleLocalApi } from "../src/bridge/local-api/index.js";
import { readTeamActivity } from "../src/bridge/team-activity.js";
import { allowedForCaller, type FleetCaller } from "../src/lib/fleet-caller.js";
import type { PaneIO } from "../src/bridge/fleet/runner.js";
import { closeLedger, openLedger } from "../src/lib/ledger-store.js";
import { createTask, setMeta } from "../src/lib/ledger-write.js";
import { messagesOnlyAllows } from "../src/lib/peer-scope-gate.js";
import { agentInScope, type Principal } from "../src/lib/principals.js";
import { beatLend } from "../src/lib/ledger-lend-peers.js";
import { runLedger } from "../src/manager/ledger.js";

const P = "w6-proj";
const H = "a".repeat(40);
const dir = mkdtempSync(join(tmpdir(), "lend-workers-access-"));
const path = join(dir, "ledger.sqlite");
let db: Database;
const now = Date.now();

const principal = (over: Partial<Principal>): Principal => ({ id: "owner:self", role: "owner", agents: ["*"], createdAt: "2026-01-01T00:00:00Z", ...over });
const OWNER = principal({});
const PARTIAL = principal({ id: "token:tok_p", role: "external", name: "p", agents: ["claudestra"] });
const PEER = principal({ id: "token:tok_peer", role: "external", name: "mate", peer: "mate", agents: ["*"] });
const GUEST = principal({ id: "guest:g", role: "external", name: "g", agents: ["*"], manage: false });
const PM: FleetCaller = { kind: "pm", name: "agent-pm", projects: [P] };
const REMOTE = "lend-0123456789@mate";

const noIO: PaneIO = {
  capture: async () => { throw new Error("不该抓屏"); }, sendLine: async () => { throw new Error("不该发键"); },
  erase: async () => { throw new Error("不该发键"); }, escape: async () => { throw new Error("不该发键"); }, sleep: async () => {},
};
const delivered: unknown[] = [];

function card(id: string, executor: string): void {
  const spec = join(dir, `${id}.md`);
  writeFileSync(spec, "规格\n验收");
  createTask(db, { actor: "owner", now }, { project: P, id, title: id, kind: "code", spec, agent: executor } as never);
}

beforeAll(async () => {
  db = openLedger(path);
  setMeta(db, { actor: "owner", now }, { project: P, key: "pms", value: ["agent-pm"] });
  card("T1", "agent-dev");
  setLedgerFeedForTest({ path, emit: () => {} });
  initFleet({ clients: new Map(), deliver: async (env) => (delivered.push(env), { outcome: { kind: "sent" } }) }, { lpMonitor: false });
});
afterAll(() => {
  setLedgerFeedForTest(undefined);
  closeLedger(path);
  rmSync(dir, { recursive: true, force: true });
});

const ledger = (args: string[], actor = "agent-pm") => runLedger(args, {
  db, actor, projectIds: [P], loadRegistry: async () => ({ socket: "", agents: {} }), saveRegistry: async () => {}, now: () => now,
  lend: { borrow: async () => [{ peer: "mate", projects: [P], roles: ["review", "write"], maxOpen: 3 }], notifyPm: async () => {} },
} as never) as Promise<Record<string, any>>;

/** 挂一单 T2 给 mate、领下、beat 一次（lend-wire-v2 BeatRequest） */
async function lendOne(): Promise<void> {
  card("T2", "agent-dev");
  db.run(`UPDATE tasks SET stage = 'review', headSHA = '${H}', round = 1 WHERE id = 'T2'`);
  const { orderId } = await ledger(["lend-offer", "T2", "--peer", "mate", "--repo", "shawnlu96/claudestra", "--pr", "12"]);
  expect((await ledger(["lend-claim", "--", "mate", JSON.stringify({ v: 1, orderId, worker: "agent-lend-0123456789" })], "owner")).ok).toBe(true);
  const r = beatLend(db, { actor: "owner", now }, "mate", { v: 1, orders: [{ orderId, gen: 1, phase: "working", lastActivityAt: now, excerpt: "x", ended: null }] }, new Map());
  expect(r.orders[0]!.verdict).toBe("ok");
}

const get = (p: Principal, q = "") => handleLocalApi(new Request(`http://x/api/v1/lend/workers${q}`), new URL(`http://x/api/v1/lend/workers${q}`), p);

describe("零远端：输出与改动前一致", () => {
  test("fleetState 不带 remote 键；readTeamActivity 的 roles 没有 remote；/lend/workers 给空", async () => {
    const s = await fleetState((n) => agentInScope(OWNER, n));
    expect(Object.keys(s).sort()).toEqual(["agents", "compactKeep"]);
    const a = await readTeamActivity(P);
    expect(JSON.stringify(a.roles)).not.toContain("remote");
    expect(await (await get(OWNER))!.json()).toEqual({ ok: true, workers: [] });
  });
});

describe("有远端单", () => {
  let before: string;
  beforeAll(async () => {
    before = JSON.stringify((await readTeamActivity(P)).roles);
    await lendOne();
  });

  test("/lend/workers：owner 全 scope 看得到；部分 scope、peer、guest 一律 403；messages-only 白名单不含它", async () => {
    const r = await get(OWNER);
    expect(r!.status).toBe(200);
    expect(((await r!.json()) as { workers: { name: string; state: string }[] }).workers).toMatchObject([{ name: REMOTE, state: "running" }]);
    for (const p of [PARTIAL, PEER, GUEST]) expect((await get(p))!.status).toBe(403);
    expect(messagesOnlyAllows("GET", "/api/v1/lend/workers")).toBe(false);
    expect((await handleLendWorkersApi(new Request("http://x", { method: "POST" }), "/lend/workers", OWNER, new URL("http://x")))!.status).toBe(405);
    expect(await (await get(OWNER, `?project=nope`))!.json()).toEqual({ ok: true, workers: [] });
  });

  test("fleetState：owner 的 * 凭据带 remote；部分 scope、MCP 调用方（只认 registry 名）看不到，也不带键", async () => {
    const owner = await fleetState((n) => agentInScope(OWNER, n));
    expect(owner.remote).toMatchObject([{ name: REMOTE, peer: "mate", taskId: "T2" }]);
    expect(owner.agents.some((a) => a.name.includes("@"))).toBe(false);
    for (const allowed of [(n: string) => agentInScope(PARTIAL, n), allowedForCaller(PM, [{ name: "agent-dev", project: P }])]) {
      const s = await fleetState(allowed);
      expect("remote" in s).toBe(false);
    }
  });

  test("runFleet 点名远端行：记进 excluded「远端 worker 只读」，不发键、不投递（预演与真跑、owner 与 PM 调用方都一样）", async () => {
    for (const caller of [undefined, PM]) {
      for (const dryRun of [true, false]) {
        const rep = await runFleet({ action: { kind: "text", text: "hi" }, select: { agents: [REMOTE, `agent-${REMOTE}`] }, dryRun, actor: "owner", via: "test",
          allowed: () => true, caller }, noIO);
        expect(rep.targets).toEqual([]);
        expect(rep.results).toEqual([]);
        expect(rep.excluded).toEqual([{ name: REMOTE, reason: "远端 worker 只读" }, { name: REMOTE, reason: "远端 worker 只读" }]);
      }
    }
    const all = await runFleet({ action: { kind: "text", text: "hi" }, select: { all: true }, actor: "owner", via: "test", allowed: () => true }, noIO);
    expect(all.targets.some((t) => t.includes("@"))).toBe(false);
    expect(delivered).toEqual([]);
  });

  test("readTeamActivity：领单时 step 执行者已登记成 worker@peer，就在那一行补 remote、不重复加行", async () => {
    const all = (await readTeamActivity(P)).roles;
    const mine = all.filter((r) => r.id === "peer:mate/lend-0123456789");
    expect(mine).toEqual([{ id: "peer:mate/lend-0123456789", role: "审查员", remote: expect.objectContaining({ peer: "mate", state: "running", phase: "working" }) }]);
    expect(all.filter((r) => r.remote).length).toBe(1);
    expect(JSON.stringify(all.filter((r) => !r.remote))).toBe(JSON.stringify(JSON.parse(before).filter((r: { id: string }) => r.id !== mine[0]!.id)));
  });

  test("readTeamActivity：本项目有活出借单但 roles 里没有它，补一行；原有 roles 逐字保留在前", async () => {
    db.run("DELETE FROM task_steps WHERE taskId = 'T2' AND executorKind = 'peer'");
    const roles = (await readTeamActivity(P)).roles;
    expect(JSON.stringify(roles.slice(0, -1))).toBe(before);
    expect(roles.at(-1)).toEqual({ id: "peer:mate/lend-0123456789", role: "审查员", remote: expect.objectContaining({ peer: "mate", state: "running" }) });
  });
});
