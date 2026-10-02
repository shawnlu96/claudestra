import { afterEach, expect, test } from "bun:test";
import { handleProjectPmApi } from "../src/bridge/local-api/project-pm.js";
import { pmPointer } from "../src/lib/pm-role.js";
import { switchProjectPm } from "../src/lib/pm-role-switch.js";
import { openAsk, answerAsk } from "../src/lib/ledger-asks.js";
import { bindHash } from "../src/lib/ask-bind.js";
import { pmSwitchAuthorization } from "../src/manager/pm-switch.js";
import { runLedger } from "../src/manager/ledger.js";
import type { Principal } from "../src/lib/principals.js";
import { A, B, P, Q, pmFixture } from "./pm-role-fixture.test.js";

const fixtures: ReturnType<typeof pmFixture>[] = [];
const fixture = () => { const f = pmFixture(); fixtures.push(f); return f; };
afterEach(() => { for (const f of fixtures.splice(0)) f.close(); });
const owner: Principal = { id: "owner:self", role: "owner", agents: ["*"], createdAt: "2026-01-01", manage: true };
function api(f: ReturnType<typeof pmFixture>) {
  let runs = 0;
  const deps = {
    exists: async (p: string) => [P, Q].includes(p), db: () => f.db, read: f.deps.read, online: () => f.online,
    run: async (args: string[]) => {
      runs++;
      try { return await switchProjectPm(f.db, args[4]!, args[2]!, { actor: "owner", dryRun: args.includes("--dry-run") }, f.deps); }
      catch (e) { return { ok: false, code: "invalid", error: (e as Error).message }; }
    },
  };
  const call = (method: string, body?: unknown, principal = owner, project = P) => handleProjectPmApi(
    new Request(`http://localhost/api/v1/projects/${project}/pm`, { method, ...(body ? { body: JSON.stringify(body) } : {}) }),
    `/projects/${project}/pm`, principal, deps,
  );
  return { call, runs: () => runs };
}

test("GET returns active, filtered candidates with correct runtimes, and full sanitized health status", async () => {
  const f = fixture(), h = api(f), r = await h.call("GET");
  expect(r?.status).toBe(200);
  const body: any = await r!.json();
  expect(body.active).toBe(A);
  expect(body.candidates.map((c: { name: string }) => c.name)).toEqual([A, B]);
  expect(body.candidates[1]).toMatchObject({ runtime: "codex", online: true });
  expect(body.status.entries.length).toBeGreaterThan(4);
  expect(JSON.stringify(body)).not.toContain("SECRET");
  expect(JSON.stringify(body)).not.toContain("DO-NOT-RETURN");
});

test("POST/GET reject no-manage, scoped and peer credentials before inspecting any project", async () => {
  const f = fixture(), h = api(f);
  for (const p of [{ ...owner, manage: false }, { ...owner, agents: [A] }, { ...owner, peer: "remote" }]) {
    for (const method of ["GET", "POST"]) expect((await h.call(method, method === "POST" ? { agent: B } : undefined, p, "not-exist"))?.status).toBe(403);
  }
  expect(h.runs()).toBe(0);
  expect(pmPointer(f.db, P)).toBeNull();
});

test("POST dryRun leaves state unchanged; formal switch follows the exact same plan", async () => {
  const f = fixture(), h = api(f), before = f.bytes();
  const dry = await h.call("POST", { agent: B, dryRun: true });
  expect(dry?.status).toBe(200);
  expect(((await dry!.json()) as any).dryRun).toBe(true);
  expect(f.bytes()).toEqual(before);
  expect(pmPointer(f.db, P)).toBeNull();
  expect((await h.call("POST", { agent: B }))?.status).toBe(200);
  expect(pmPointer(f.db, P)).toBe(B);
});

test("POST rejects a candidate from another project and rejects malformed body or flags", async () => {
  const f = fixture(), h = api(f);
  const r = await h.call("POST", { agent: "agent-other" });
  expect(r?.status).toBe(400);
  expect(((await r!.json()) as any).error).toContain("another project");
  for (const body of [{ agent: "--project" }, { agent: B, dryRun: "yes" }, { agent: "" }]) expect((await h.call("POST", body))?.status).toBe(400);
  expect(pmPointer(f.db, P)).toBeNull();
});

test("POST adds a registered PM candidate missing from pms", async () => {
  const f = fixture(), h = api(f), state = await f.deps.read();
  f.db.query("UPDATE meta SET value=? WHERE project=? AND key='pms'").run(JSON.stringify([A]), P);
  expect(state.agents.find((a) => a.name === B)?.projectId).toBe(P);
  expect((await h.call("POST", { agent: B }))?.status).toBe(200);
  expect(pmPointer(f.db, P)).toBe(B);
});

test("two project API endpoints operate independently", async () => {
  const f = fixture(), h = api(f), state = await f.deps.read();
  state.principals[0]!.agents.push("agent-other");
  f.put("principals.json", { principals: state.principals });
  await h.call("POST", { agent: B });
  expect((await h.call("POST", { agent: "agent-other" }, owner, Q))?.status).toBe(200);
  const result: any = await (await h.call("GET"))!.json();
  expect(result.active).toBe(B);
  expect(pmPointer(f.db, Q)).toBe("agent-other");
});

test("agent CLI requires an actual bound owner authorization before it can write PM identity", async () => {
  const f = fixture();
  const r = await runLedger(["pm-switch", B, "--project", P], {
    db: f.db, actor: A, actorProject: P, projectIds: [P], now: () => 1,
    loadRegistry: async () => ({ agents: {}, socket: "" }), saveRegistry: async () => {},
  });
  expect(r).toMatchObject({ ok: false, code: "forbidden" });
  expect(String(r.error)).toContain("owner 授权");
  expect(pmPointer(f.db, P)).toBeNull();
});


test("bound owner authorization is caller-specific, parameter-specific and expires", () => {
  const f = fixture(), bind = { action: "pm-switch", params: { project: P, agent: B }, approve: ["go"] };
  const ask = openAsk(f.db, { project: P, source: "reply", kind: "authorize", title: "Switch PM", fromAgent: A,
    options: [{ type: "buttons", buttons: [{ id: "go", label: "Switch" }] }],
    bind: { ...bind, paramsHash: bindHash(bind, A) }, expiresAt: 1000 }, 10);
  expect(() => pmSwitchAuthorization(f.db, A, P, B, ask.id, 20)).toThrow("owner");
  answerAsk(f.db, ask.id, { choices: ["[button:go]"], labels: ["Switch"], text: "", principal: "owner:self", owner: true, via: "web_card", at: 20, final: true });
  expect(() => pmSwitchAuthorization(f.db, A, P, B, ask.id, 30)).not.toThrow();
  expect(() => pmSwitchAuthorization(f.db, B, P, B, ask.id, 30)).toThrow("asked by");
  expect(() => pmSwitchAuthorization(f.db, A, P, A, ask.id, 30)).toThrow("mismatch");
  expect(() => pmSwitchAuthorization(f.db, A, Q, B, ask.id, 30)).toThrow("owner");
  expect(() => pmSwitchAuthorization(f.db, A, P, B, ask.id, 1001)).toThrow("window ended");
});

test("an external answer or old answer without owner identity cannot authorize a PM switch", () => {
  const f = fixture(), bind = { action: "pm-switch", params: { project: P, agent: B }, approve: ["go"] };
  const ask = openAsk(f.db, { project: P, source: "reply", kind: "authorize", title: "Switch PM", fromAgent: A,
    options: [{ type: "buttons", buttons: [{ id: "go", label: "Switch" }] }],
    bind: { ...bind, paramsHash: bindHash(bind, A) } }, 10);
  answerAsk(f.db, ask.id, { choices: ["[button:go]"], labels: ["Switch"], text: "", principal: "guest:one", via: "web_card", at: 20, final: true });
  expect(() => pmSwitchAuthorization(f.db, A, P, B, ask.id, 30)).toThrow("owner");
});
