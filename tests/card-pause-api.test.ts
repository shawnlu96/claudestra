/**
 * UXPAUSE1 · the bridge's card pause endpoint: GET reads switch + state + whether a pause is possible; POST pause / resume run the
 * ledger command as owner (the injected run executes the real ledger CLI as owner, as the manager child without a channel id does);
 * a credential without manage rights gets 403 and nothing runs.
 */
import { afterEach, expect, test } from "bun:test";
import { handleCardPauseApi, ownerEnv } from "../src/bridge/local-api/card-pause.js";
import { configureCardPausePolicy } from "../src/lib/card-pause.js";
import { listEvents } from "../src/lib/ledger-store.js";
import type { Principal } from "../src/lib/principals.js";
import { autoFixture } from "./scheduler-auto-helpers.js";

const cleanups: (() => void)[] = [];
afterEach(() => { configureCardPausePolicy(null); while (cleanups.length) cleanups.pop()!(); });
const owner: Principal = { id: "owner:self", role: "owner", agents: ["*"], createdAt: "2026-01-01", manage: true };
const readOnly = { ...owner, id: "dev:phone", manage: false } as Principal;
const scoped = { ...owner, id: "dev:scoped", agents: ["agent-task-one"], manage: undefined } as Principal;

function api() {
  configureCardPausePolicy((_p, key) => ({ mode: key === "cardPause" ? "on" : "observe", manualAfterMs: null, source: "config" }));
  const f = autoFixture();
  cleanups.push(f.close);
  const runs: string[][] = [];
  const deps = { exists: async (p: string) => p === "p", db: () => f.db,
    run: async (args: string[]) => { runs.push(args); return f.cli("owner", ...args.slice(1)) as Promise<Record<string, unknown>>; } };
  const call = async (method: string, verb: "pause" | "resume", body?: unknown, principal = owner, project = "p", task = "T1") => {
    const path = `/ledger/${project}/tasks/${task}/${verb}`;
    const r = await handleCardPauseApi(new Request(`http://localhost/api/v1${path}`, { method, ...(body ? { body: JSON.stringify(body) } : {}) }), path, principal, deps);
    return { status: r!.status, body: await r!.json() as Record<string, any> };
  };
  return { f, call, runs };
}

test("[验收线 6] owner credential: read, pause, read, resume; the ledger events' actor is owner", async () => {
  const { f, call, runs } = api();
  expect(await call("GET", "pause")).toEqual({ status: 200, body: { mode: "on", paused: false, actor: null, at: null, reason: null, stage: "spec",
    canPause: true, refusal: null } });
  const paused = await call("POST", "pause", { reason: "  等 owner 拍板  " });
  expect(paused).toMatchObject({ status: 200, body: { ok: true, duplicate: false, view: { paused: true, actor: "owner", reason: "等 owner 拍板", canPause: false, refusal: "已暂停" } } });
  expect(runs).toEqual([["ledger", "card-pause", "T1", "--reason", "等 owner 拍板"]]);
  expect((await call("GET", "pause")).body).toMatchObject({ paused: true, actor: "owner", at: expect.any(Number) });
  expect(await call("POST", "pause", { reason: "again" })).toMatchObject({ status: 200, body: { duplicate: true } });
  expect(await call("POST", "resume")).toMatchObject({ status: 200, body: { ok: true, duplicate: false, view: { paused: false } } });
  expect(runs.at(-1)).toEqual(["ledger", "card-resume", "T1"]);
  const decisions = listEvents(f.db, { project: "p", target: "T1" }).filter((e) => ["card_pause", "card_resume"].includes(String(e.data.op)));
  expect(decisions.map((e) => [e.data.op, e.actor])).toEqual([["card_pause", "owner"], ["card_resume", "owner"]]);
  expect("DISCORD_CHANNEL_ID" in ownerEnv() && ownerEnv().DISCORD_CHANNEL_ID === undefined).toBe(true); // no channel = the owner identity
});

test("[验收线 6] a credential without manage rights gets 403 and nothing runs", async () => {
  const { call, runs } = api();
  for (const p of [readOnly, scoped]) {
    expect((await call("GET", "pause", undefined, p)).status).toBe(403);
    expect((await call("POST", "pause", { reason: "x" }, p)).status).toBe(403);
    expect((await call("POST", "resume", undefined, p)).status).toBe(403);
  }
  expect(runs).toEqual([]);
});

test("refusals map to status codes: a stage refusal is 409 with the reason; bad input 400; unknown project / task 404; wrong method 405", async () => {
  const { f, call, runs } = api();
  f.db.query("UPDATE tasks SET stage = 'merge' WHERE id = 'T1'").run();
  expect((await call("GET", "pause")).body).toMatchObject({ canPause: false, refusal: expect.stringContaining("在 merge 阶段") });
  expect(await call("POST", "pause", { reason: "停" })).toMatchObject({ status: 409, body: { ok: false, code: "conflict" } });
  expect((await call("POST", "pause", {})).status).toBe(400);
  expect((await call("POST", "pause", { reason: "x".repeat(601) })).status).toBe(400);
  expect((await call("GET", "pause", undefined, owner, "nope")).status).toBe(404);
  expect((await call("GET", "pause", undefined, owner, "p", "T404")).status).toBe(404);
  expect((await call("GET", "resume")).status).toBe(405);
  expect(runs).toHaveLength(1);
});
