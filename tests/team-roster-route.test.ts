/**
 * team-roster-ROSTER1：GET /api/v1/team/roster 的门与读失败（bridge/local-api/team-roster.ts）。
 * 门与 /team/quota 同一道（canReadLedger + 只许 GET）；被拒时注入的依赖一被调就抛，证明什么都没读。
 */
import type { Database } from "bun:sqlite";
import { afterEach, expect, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handleTeamApi } from "../src/bridge/local-api/team";
import { setTeamRosterDepsForTest, type TeamRosterDeps } from "../src/bridge/local-api/team-roster";
import { closeLedger, openLedger } from "../src/lib/ledger-store";
import type { Principal } from "../src/lib/principals";
import type { Roster } from "../src/lib/team-roster";

const URL_OK = "http://local/api/v1/team/roster?project=p";
const owner: Principal = { id: "owner:self", role: "owner", agents: ["*"], createdAt: "2026-01-01" };
const get = (url = URL_OK, principal = owner, method = "GET") => handleTeamApi(new Request(url, { method }), "/team/roster", principal);

const boom = (name: string) => () => { throw new Error(`${name} must not be read`); };
const throwing: TeamRosterDeps = {
  projectExists: boom("projectExists"), db: boom("db"), agents: boom("agents"), poolTotals: boom("poolTotals"), borrowPeers: boom("borrowPeers"),
  peers: boom("peers"), presence: boom("presence"), localQuota: boom("localQuota"), peerQuota: boom("peerQuota"), instanceId: boom("instanceId"), now: boom("now"),
};

afterEach(() => setTeamRosterDepsForTest());

test("[验收线 1] 部分 scope、peer 凭据、manage:false、guest 一律 403，处理函数什么都不读", async () => {
  setTeamRosterDepsForTest(throwing);
  const base: Principal = { id: "token:test", role: "external", agents: ["worker"], createdAt: "2026-01-01" };
  const denied: Principal[] = [
    base,
    { ...base, agents: ["*"], peer: "P" },
    { ...owner, manage: false },
    { id: "guest:g1", role: "external", agents: ["master"], manage: false, createdAt: "2026-01-01" },
  ];
  for (const principal of denied) expect((await get(URL_OK, principal))?.status).toBe(403);
  expect((await get(URL_OK, owner, "POST"))?.status).toBe(405);
});

function ledger(): { db: Database; done(): void } {
  const dir = mkdtempSync(join(tmpdir(), "roster1-route-")), path = join(dir, "ledger.sqlite"), db = openLedger(path);
  return { db, done: () => { closeLedger(path); rmSync(dir, { recursive: true, force: true }); } };
}

const okDeps = (db: Database | null, over: Partial<TeamRosterDeps> = {}): TeamRosterDeps => ({
  projectExists: async (p) => p === "p", db: () => db, agents: () => ({ claude: 2, codex: 1 }), poolTotals: (_d, _p, t) => t,
  borrowPeers: async () => ["Sekai"], peers: async () => [{ name: "Sekai", addedAt: "x", instanceId: "iid-sekai" }],
  presence: () => ({ online: true, checkedAt: "2026-10-14T03:00:00.000Z", latencyMs: 12 }),
  localQuota: async () => ({}), peerQuota: () => null, instanceId: () => "iid-self", now: () => 1_000, ...over,
});

test("缺 project → 400；项目不存在 → 404；台账打不开 → 503", async () => {
  setTeamRosterDepsForTest(okDeps(null));
  expect((await get("http://local/api/v1/team/roster"))?.status).toBe(400);
  expect((await get("http://local/api/v1/team/roster?project=nope"))?.status).toBe(404);
  const warn = spyOn(console, "warn").mockImplementation(() => {});
  try {
    expect((await get())?.status).toBe(503);
    setTeamRosterDepsForTest(okDeps(null, { db: () => { throw new Error("locked"); } }));
    const r = await get();
    expect(r?.status).toBe(503);
    expect(await r?.json()).toEqual({ error: "ledger unavailable" });
  } finally { warn.mockRestore(); }
});

test("全权 owner 拿到名册；scheduler.json 坏 → 本机两家位子 null；单个 peer 在线 / 额度读不到 → 那一格 null，整包照回", async () => {
  const l = ledger();
  const warn = spyOn(console, "warn").mockImplementation(() => {});
  try {
    setTeamRosterDepsForTest(okDeps(l.db));
    let r = await get();
    expect(r?.status).toBe(200);
    let body = await r!.json() as Roster;
    expect(body).toMatchObject({ now: 1_000, project: "p", self: { instanceId: "iid-self" }, unattributed: { merge: [], live: [], blocked: [] } });
    expect(body.machines.map((m) => m.machineKey)).toEqual(["local", "Sekai"]);
    expect(body.machines[0]!.slots.claude).toMatchObject({ total: 2, busy: 0, placeable: 2 });
    expect(body.machines[1]).toMatchObject({ instanceId: "iid-sekai", online: true, checkedAt: Date.parse("2026-10-14T03:00:00.000Z"), latencyMs: 12 });

    setTeamRosterDepsForTest(okDeps(l.db, { agents: () => { throw new Error("bad json"); }, presence: () => { throw new Error("probe"); },
      peerQuota: () => { throw new Error("mem"); }, localQuota: async () => { throw new Error("rollout"); } }));
    r = await get();
    expect(r?.status).toBe(200);
    body = await r!.json() as Roster;
    expect(body.machines[0]!.slots).toEqual({ claude: null, codex: null });
    expect(body.machines[0]!.quota).toEqual({ claude: null, codex: null });
    expect(body.machines[1]).toMatchObject({ online: null, checkedAt: null, latencyMs: null, quota: { claude: null, codex: null } });
    expect(warn).toHaveBeenCalled();
  } finally { warn.mockRestore(); l.done(); }
});
