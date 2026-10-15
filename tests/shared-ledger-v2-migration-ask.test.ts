/** peer-MIGASK1 验收线 1–5：迁移授权 ask 经正常命令创建、owner 批准经 bridge 转发、dry-run / commit 复用同一份冻结清单。
 * 隔离 fixture：mkdtemp 演练根（单成员「本机」）+ 独立台账库；假中心按 CMIGAUTH1 的规则核权（actionDigest 在本文件独立算一遍）。
 */
import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  parseAsk, parseCommand, parseReceipt, V2ContractError, v2ObjectDigest, type V2Ask, type V2Command,
} from "../src/lib/shared-ledger-contract-v2.js";
import { V2_DTO_FIXTURES } from "../src/lib/shared-ledger-contract-v2-fixtures.js";
import { writeSharedLedgerModes } from "../src/lib/shared-ledger-mode.js";
import { closeLedger, openLedger } from "../src/lib/ledger-store.js";
import { getAsk, listAsks, type Ask } from "../src/lib/ledger-asks.js";
import type { Stage2Transport } from "../src/lib/shared-ledger-v2-transport.js";
import type { Stage2Wiring } from "../src/lib/shared-ledger-v2-wiring.js";
import { migrationCenter, runExecutionMigration, type MigrationPlan } from "../src/lib/shared-ledger-v2-migration.js";
import { frozenManifestPath, readFrozenManifest } from "../src/lib/shared-ledger-v2-migration-ask-frozen.js";
import { configureMigrationAsks } from "../src/lib/shared-ledger-v2-migration-ask-answer.js";
import { LedgerCli } from "../src/manager/ledger-context.js";
import { sharedExecRun } from "../src/manager/ledger-shared-exec-cmds.js";
import { commitAnswer, onAsk, setAsksForTest } from "../src/bridge/asks.js";
import { answerFromCard } from "../src/bridge/ask-entry.js";
import { displaySharedAsk, publishMigrationAsks } from "../src/bridge/shared-ledger-v2-asks.js";
import { owner as ownerPrincipal } from "./asks-test-kit.js";
import { initSharedAskWiring } from "../src/bridge/shared-ledger-v2-asks-wiring.js";
import type { Endpoint } from "../src/bridge/router.js";

const PROJECT = "proj";
const cleanup: (() => void)[] = [];
afterEach(() => {
  configureMigrationAsks(null);
  setAsksForTest(undefined);
  for (const fn of cleanup.splice(0)) fn();
});

/** 中心的 migrationActionDigest（私仓 asks/migration.ts），这里独立写一遍：整份冻结清单去掉 authorizationAskId、manifestDigest。 */
function centerActionDigest(manifest: Record<string, unknown>): string {
  const { authorizationAskId: _ask, manifestDigest: _self, ...frozen } = manifest;
  return v2ObjectDigest(frozen);
}

type Obj = Record<string, any>;
/** 假中心：ask.create / ask.answer 走 commands，迁移按 CMIGAUTH1 核批准的 ask、范围集合与 actionDigest；每次写都记账。 */
function fakeCenter() {
  const asks = new Map<string, V2Ask>(), commands: V2Command[] = [], migrations: { mode: string; manifestDigest: string; actionDigest: string }[] = [];
  const state = { seq: 0, now: Date.now(), committed: null as Obj | null };
  const receipt = (c: V2Command, entityId: string, rev: number) => parseReceipt({ ...V2_DTO_FIXTURES.receipt.valid as object,
    requestId: c.requestId, command: c.type, commandDigest: v2ObjectDigest(c), serverSeq: ++state.seq, committedAt: state.now,
    result: { entityId, rev, specRev: null, version: null, epoch: c.epoch, operationId: null } });
  function command(raw: unknown) {
    const c = parseCommand(structuredClone(raw));
    commands.push(c);
    if (c.type === "ask.create") {
      const id = `center-ask-${commands.length}`;
      asks.set(id, parseAsk({ ...c.payload, teamId: c.teamId, projectId: c.projectId, id, source: "business", state: "open", rev: 1,
        createdBy: "person", createdAt: state.now, answeredBy: null, answeredAt: null, answer: null, decision: null, auditEventSeq: state.seq + 1 }));
      return receipt(c, id, 1);
    }
    if (c.type === "ask.answer") {
      const a = asks.get(c.payload.askId) ?? fail("not_found");
      if (a.rev !== c.payload.expectedRev || a.state !== "open") fail("conflict");
      if (v2ObjectDigest(a.bind) !== c.payload.bindDigest) fail("authorization_mismatch");
      const want = c.payload.decision === "approved" ? "approve" : "reject";
      if (c.payload.answer.kind !== "option" || c.payload.answer.optionId !== want) fail("authorization_mismatch");
      asks.set(a.id, parseAsk({ ...a, rev: a.rev + 1, state: "answered", answer: c.payload.answer, decision: c.payload.decision,
        answeredBy: "person", answeredAt: state.now + 1 }));
      return receipt(c, a.id, a.rev + 1);
    }
    if (c.type === "lease.acquire") return receipt(c, c.payload.taskId, 1);
    return fail("invalid_field");
  }
  function migrate(body: { mode: string; manifest: Obj }) {
    const m = body.manifest, a = asks.get(m.authorizationAskId), action = centerActionDigest(m);
    migrations.push({ mode: body.mode, manifestDigest: m.manifestDigest, actionDigest: action });
    if (!a || a.state !== "answered" || a.decision !== "approved" || !a.bind) fail("authorization_mismatch");
    const range = new Set(a.bind!.featureIds ?? [a.bind!.featureId]);
    if (range.size !== m.featureIds.length || !m.featureIds.every((f: string) => range.has(f))
      || a.bind!.actionDigest !== action || a.bind!.homeInstanceId !== m.sourceInstanceId) fail("authorization_mismatch");
    const result = { schemaVersion: 2, teamId: m.teamId, projectId: m.projectId, batchId: m.batchId, manifestDigest: m.manifestDigest,
      serviceGeneration: 1, serverSeq: state.seq + 1, committedAt: state.now, mappings: m.mappings, featureIds: m.featureIds };
    if (body.mode === "commit") state.committed = result;
    return result;
  }
  const transport = {
    scope: { teamId: "team", projectId: "project" },
    // Planted connection material: none of it may reach command output, the local card or logs.
    connection: { bearer: "SECRET-BEARER-0123456789", signature: "SECRET-SIG" },
    call: async (name: string, _params: unknown, body: unknown) => name === "commands" ? command(body) : fail("not_found"),
    ask: async (askId: string) => structuredClone(asks.get(askId) ?? fail("not_found")),
    migrate: async (body: { mode: string; manifest: Obj }) => migrate(body),
    migration: async (batchId: string) => ({ teamId: "team", projectId: "project", batchId,
      status: state.committed ? "committed" : "unknown", result: state.committed }),
    snapshot: async () => ({ feature: { epoch: 2 } }),
    receipt: async () => ({ status: "unknown", receipt: null }),
  } as unknown as Stage2Transport;
  const writes = () => commands.length + migrations.length;
  return { transport, asks, commands, migrations, state, writes };
}
function fail(code: string): never { throw new V2ContractError(code as never); }

/** 演练根：一个成员目录（最小台账 + planning 模式文件）+ plan.json；另起一个独立台账库给 CLI 和 bridge 开卡、作答。 */
async function world(edit: (m: Obj) => void = () => {}) {
  const root = mkdtempSync(join(tmpdir(), "migask-drill-")), state = mkdtempSync(join(tmpdir(), "migask-state-"));
  const ledgerPath = join(state, "ledger.sqlite");
  cleanup.push(() => { closeLedger(ledgerPath); rmSync(root, { recursive: true, force: true }); rmSync(state, { recursive: true, force: true }); });
  const { manifestDigest: _d, evidence: _e, featureIds: _f, frozenAt: _z, batchId: _b, ...manifest } =
    structuredClone(V2_DTO_FIXTURES.migrationManifest.valid) as Obj;
  // 已结清的出借单不进清单；feature 映射用同 id（X7 执行闸按中心 id 读模式）
  for (const k of ["lendOrders", "lendClaims", "lendLeases", "lendResults"]) manifest[k] = [];
  manifest.mappings = manifest.mappings.filter((x: Obj) => x.kind !== "order").map((x: Obj) => x.kind === "feature" ? { ...x, sourceId: "feature" } : x);
  edit(manifest);
  const member = join(root, "local");
  mkdirSync(member);
  const db = new Database(join(member, "ledger.sqlite"));
  db.run("CREATE TABLE tasks (id TEXT PRIMARY KEY, featureId TEXT, extra TEXT NOT NULL DEFAULT '{}', stage TEXT)");
  db.run("INSERT INTO tasks VALUES ('old-task', 'feature', '{}', ?)", [manifest.tasks[0].stage]);
  db.close();
  await writeSharedLedgerModes({ feature: { authorityMode: "planning", sharedPlanning: true } }, member, join(member, "ledger.sqlite"));
  const plan: MigrationPlan = { batchId: "batch-migask", centerId: "center", featureIds: ["feature"], homeBootId: "center-boot",
    manifest: manifest as MigrationPlan["manifest"], members: [{ label: "本机", instanceId: "local", dir: "local", versionVerified: false }] };
  writeFileSync(join(root, "plan.json"), JSON.stringify(plan));
  const center = fakeCenter(), ledger = openLedger(ledgerPath);
  const wiring = { scope: () => ({ localProjectId: PROJECT, centerId: "center", teamId: "team", projectId: "project" }),
    transportFor: () => center.transport } as unknown as Stage2Wiring;
  const cli = (actor: string, ...args: string[]) => new LedgerCli({ db: ledger, actor, actorProject: PROJECT, projectIds: [PROJECT],
    now: () => center.state.now, loadRegistry: async () => ({ agents: {}, socket: "/tmp/synthetic.sock" }), saveRegistry: async () => {} },
  { pos: ["shared-exec", ...args], flags: {}, bools: new Set() });
  const ask = async (actor = "owner", expiresIn = "3600") => {
    const c = cli(actor, "migration-ask", PROJECT);
    Object.assign(c.p.flags, { root, plan: "plan.json", "expires-in": expiresIn });
    return sharedExecRun(c, { wiring }) as Promise<Obj>;
  };
  const run = (mode: "dry-run" | "commit", p: MigrationPlan = plan) =>
    runExecutionMigration({ root, plan: p, center: migrationCenter(center.transport), mode });
  return { root, plan, center, ledger, ledgerPath, ask, run, cli, wiring };
}
const owner: Endpoint = { kind: "user", userId: "owner-discord", channelId: "123" };
const pmApi: Endpoint = { kind: "api", tokenId: "tok-pm", name: "agent-claudestra" };
/** The bridge side: ask database, shared-ask runtime and the owner transport port. */
function bridge(w: Awaited<ReturnType<typeof world>>) {
  setAsksForTest({ path: w.ledgerPath, registry: [] });
  initSharedAskWiring();
  configureMigrationAsks({ transportFor: () => w.center.transport });
}
function answer(w: Awaited<ReturnType<typeof world>>, a: Ask, wire: string, from: Endpoint) {
  bridge(w);
  return commitAnswer({ ask: getAsk(w.ledger, a.id)!, picks: [{ wire, label: wire, group: "0" }], text: "", from,
    principal: from.kind === "user" ? "owner:self" : "guest:pm", via: "web_card" });
}
const localCard = (w: Awaited<ReturnType<typeof world>>) => listAsks(w.ledger, { project: PROJECT })[0]!;

describe("验收线 1：正常命令建迁移授权 ask", () => {
  test("ask.create = authorize / taskId null / actions [migration] / featureIds 清单集合，actionDigest = 中心算法对冻结清单的结果", async () => {
    const w = await world();
    const out = await w.ask();
    expect(w.center.commands.map(c => c.type)).toEqual(["ask.create"]);
    const c = w.center.commands[0]!;
    if (c.type !== "ask.create") throw new Error("unexpected");
    expect(c.payload).toMatchObject({ kind: "authorize", taskId: null, featureId: "feature", allowText: false });
    expect(c.payload.bind).toMatchObject({ actions: ["migration"], featureIds: ["feature"], taskId: null, taskRev: null, specRev: null,
      workflowRev: null, head: null, proposalDigest: null, homeInstanceId: "local", redactionVersion: 1 });
    expect(c.payload.options.map(o => o.id).sort()).toEqual(["approve", "reject"]);
    // 冻结清单只生成一次、0600、ask id 写回；actionDigest 与中心独立算法一致，且不含 ask id
    const path = frozenManifestPath(w.root, "batch-migask"), frozen = JSON.parse(readFileSync(path, "utf8"));
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(frozen.authorizationAskId).toBe("center-ask-1");
    expect(c.payload.bind!.actionDigest).toBe(centerActionDigest(frozen));
    expect(c.payload.bind!.originalDigest).toBe(frozen.snapshotDigest);
    expect(c.payload.bind!.baseVersion).toBe(frozen.features.find((f: Obj) => f.id === "feature").currentVersion);
    expect(c.epoch).toBe(frozen.features.find((f: Obj) => f.id === "feature").epoch);
    expect(`${c.payload.title}\n${c.payload.context}`).toContain("local");
    // 本机给 owner 的 authorize 卡：列批次、feature、有效期、actionDigest 前 12 位
    const card = localCard(w);
    expect(card).toMatchObject({ kind: "authorize", state: "open", taskId: null, fromAgent: null, allowText: false, expiresAt: c.payload.expiresAt });
    for (const s of ["batch-migask", "feature", c.payload.bind!.actionDigest.slice(0, 12), new Date(c.payload.expiresAt).toISOString()]) {
      expect(`${card.title}\n${card.context}\n${card.body}`).toContain(s);
    }
    expect(card.extra.migrationAsk).toMatchObject({ centerAskId: "center-ask-1", actionDigest: c.payload.bind!.actionDigest, batchId: "batch-migask" });
    expect(out).toMatchObject({ ok: true, centerAskId: "center-ask-1", localAskId: card.id, featureIds: ["feature"] });
  });

  test("非 PM / owner 不能建；中心拒绝原样报错、不开本机卡", async () => {
    const w = await world();
    await expect(w.ask("agent-nobody")).rejects.toThrow("PM / master / owner");
    expect(w.center.writes()).toBe(0);
    const center = w.center.transport as unknown as { call: unknown };
    center.call = async () => fail("forbidden");
    await expect(w.ask()).rejects.toMatchObject({ code: "forbidden" });
    expect(listAsks(w.ledger, { project: PROJECT })).toEqual([]);
  });
});

describe("验收线 2：dry-run / commit 复用同一份冻结清单", () => {
  test("先 dry-run 再 commit：两次送中心的 manifestDigest、actionDigest 完全相同，frozenAt 不重算", async () => {
    const w = await world();
    await w.ask();
    await answer(w, localCard(w), "[button:approve]", owner);
    const frozen = readFrozenManifest(w.root, "batch-migask")!;
    w.center.state.now += 60_000;
    expect((await w.run("dry-run")).status).toBe("dry-run");
    expect((await w.run("commit")).status).toBe("switched");
    expect(w.center.migrations.map(m => m.mode)).toEqual(["dry-run", "commit"]);
    expect(new Set(w.center.migrations.map(m => m.manifestDigest))).toEqual(new Set([frozen.manifestDigest]));
    expect(new Set(w.center.migrations.map(m => m.actionDigest))).toEqual(new Set([centerActionDigest(frozen)]));
    expect(readFrozenManifest(w.root, "batch-migask")).toEqual(frozen);
  });

  test("改了 plan 再跑：拒绝并提示重跑 migration-ask，假中心零写入", async () => {
    const w = await world();
    await w.ask();
    const before = w.center.writes(), changed = structuredClone(w.plan);
    changed.manifest.tasks[0]!.title = "被改过的标题";
    for (const mode of ["dry-run", "commit"] as const) {
      const out = await w.run(mode, changed);
      expect(out.status === "refused" && out.findings.map(f => f.code)).toEqual(["frozen_manifest_mismatch"]);
      expect(out.status === "refused" && out.findings[0]!.detail).toContain("migration-ask");
    }
    expect(w.center.writes()).toBe(before);
  });

  test("没有冻结清单：拒绝并提示先跑 migration-ask；建 ask 失败留下的待授权清单也不送中心", async () => {
    const w = await world();
    const none = await w.run("dry-run");
    expect(none.status === "refused" && none.findings.map(f => f.code)).toEqual(["frozen_manifest_missing"]);
    (w.center.transport as unknown as { call: unknown }).call = async () => fail("unavailable");
    await expect(w.ask()).rejects.toMatchObject({ code: "unavailable" });
    expect(existsSync(frozenManifestPath(w.root, "batch-migask"))).toBe(true);
    const pending = await w.run("commit");
    expect(pending.status === "refused" && pending.findings.map(f => f.code)).toEqual(["frozen_manifest_unauthorized"]);
    expect(w.center.migrations).toEqual([]);
  });

  test("plan 没变时重跑 migration-ask：沿用 frozenAt（actionDigest 不变），只换新 ask", async () => {
    const w = await world();
    await w.ask();
    const first = readFrozenManifest(w.root, "batch-migask")!;
    w.center.state.now += 5_000;
    await w.ask();
    const second = readFrozenManifest(w.root, "batch-migask")!;
    expect(second.frozenAt).toBe(first.frozenAt);
    expect(centerActionDigest(second)).toBe(centerActionDigest(first));
    expect(second.authorizationAskId).toBe("center-ask-2");
  });
});

describe("验收线 3：owner 批准经 bridge 转发到中心", () => {
  test("owner 批准：假中心收到 approved（option approve），本机卡结案", async () => {
    const w = await world();
    await w.ask();
    const done = await answer(w, localCard(w), "[button:approve]", owner);
    const sent = w.center.commands.filter(c => c.type === "ask.answer");
    expect(sent.map(c => c.type === "ask.answer" && [c.payload.decision, c.payload.answer])).toEqual([["approved", { kind: "option", optionId: "approve" }]]);
    expect(w.center.asks.get("center-ask-1")).toMatchObject({ state: "answered", decision: "approved" });
    expect(done.state).toBe("answered");
    expect(getAsk(w.ledger, done.id)!.state).toBe("answered");
  });

  test("owner 驳回：只转发 rejected，中心批次仍会被拒", async () => {
    const w = await world();
    await w.ask();
    await answer(w, localCard(w), "[button:reject]", owner);
    expect(w.center.commands.filter(c => c.type === "ask.answer").map(c => c.type === "ask.answer" && c.payload.decision)).toEqual(["rejected"]);
    const out = await w.run("dry-run");
    expect(out.status === "refused" && out.findings.map(f => f.code)).toEqual(["center_refused"]);
  });

  test("过期、非 owner（PM 的 API 身份 / guest）作答：都不转发批准，本机卡不动", async () => {
    const w = await world();
    await w.ask();
    const card = localCard(w);
    for (const from of [pmApi, { kind: "api", tokenId: "tok-guest", name: "guest" } as Endpoint, { kind: "local", channelId: "111", ws: {} as never } as Endpoint]) {
      await expect(answer(w, card, "[button:approve]", from)).rejects.toMatchObject({ status: 403 });
    }
    w.ledger.run("UPDATE asks SET expiresAt = ? WHERE id = ?", [Date.now() - 1, card.id]);
    await expect(answer(w, card, "[button:approve]", owner)).rejects.toMatchObject({ status: 403, code: "authorization_expired" });
    expect(w.center.commands.map(c => c.type)).toEqual(["ask.create"]);
    expect(getAsk(w.ledger, card.id)!.state).toBe("open");
  });

  test("中心拒绝作答：原样报错，本机不记批准、卡保持 open", async () => {
    const w = await world();
    await w.ask();
    const card = localCard(w), transport = w.center.transport as unknown as { call: unknown };
    transport.call = async () => fail("authorization_mismatch");
    await expect(answer(w, card, "[button:approve]", owner)).rejects.toMatchObject({ status: 403, code: "authorization_mismatch" });
    expect(getAsk(w.ledger, card.id)!.state).toBe("open");
  });

  test("中心 409（stale_epoch）经网页作答入口仍是中心的码，不显示成「已处理」", async () => {
    const w = await world();
    await w.ask();
    const card = localCard(w), transport = w.center.transport as unknown as { call: unknown };
    transport.call = async () => fail("stale_epoch");
    bridge(w);
    const res = await answerFromCard(PROJECT, card.id, { choices: ["[button:approve]"] }, ownerPrincipal());
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ ok: false, code: "stale_epoch" });
    expect(getAsk(w.ledger, card.id)!.state).toBe("open");
  });

  test("中心已结案（别处答过 / 撤回）：作答报 409，本机卡跟到中心的终态（只作展示）", async () => {
    const w = await world();
    await w.ask();
    const card = localCard(w), a = w.center.asks.get("center-ask-1")!;
    w.center.asks.set(a.id, { ...a, state: "cancelled" });
    await expect(answer(w, card, "[button:approve]", owner)).rejects.toMatchObject({ status: 409, code: "conflict" });
    expect(getAsk(w.ledger, card.id)).toMatchObject({ state: "cancelled", answer: null, extra: { migrationAskCenter: { state: "cancelled" } } });
  });
});

describe("中心批准后回包丢失：本机卡能恢复", () => {
  test("owner 再点同一个批准：报 409，本机卡跟到中心的 answered / approved，不再停在 open", async () => {
    const w = await world();
    await w.ask();
    const card = localCard(w), transport = w.center.transport as unknown as { call: (...a: unknown[]) => Promise<unknown> };
    const send = transport.call;
    transport.call = async (...args) => { await send(...args); return fail("unavailable"); };
    await expect(answer(w, card, "[button:approve]", owner)).rejects.toMatchObject({ status: 503 });
    expect(w.center.asks.get("center-ask-1")).toMatchObject({ state: "answered", decision: "approved" });
    expect(getAsk(w.ledger, card.id)!.state).toBe("open");
    await expect(answer(w, card, "[button:approve]", owner)).rejects.toMatchObject({ status: 409 });
    expect(getAsk(w.ledger, card.id)).toMatchObject({ state: "answered", extra: { migrationAskCenter: { state: "answered", decision: "approved" } } });
    expect(w.center.commands.filter(c => c.type === "ask.answer")).toHaveLength(1);
  });

  test("不再点：列表展示读中心，本机卡同步成 answered", async () => {
    const w = await world();
    await w.ask();
    const card = localCard(w), transport = w.center.transport as unknown as { call: (...a: unknown[]) => Promise<unknown> };
    const send = transport.call;
    transport.call = async (...args) => { await send(...args); return fail("unavailable"); };
    await expect(answer(w, card, "[button:approve]", owner)).rejects.toMatchObject({ status: 503 });
    expect((await displaySharedAsk(getAsk(w.ledger, card.id)!)).state).toBe("answered");
    expect(getAsk(w.ledger, card.id)!.state).toBe("answered");
  });
});

describe("验收线 3：owner 收到授权卡", () => {
  test("命令在 CLI 进程建卡后，bridge 补发一次 ask 事件（推送 / Discord / 网页都订 onAsk），再扫不重复", async () => {
    const w = await world();
    const out = await w.ask();
    bridge(w);
    const seen: Ask[] = [], off = onAsk(a => { seen.push(a); });
    try {
      expect(publishMigrationAsks()).toBe(1);
      expect(seen.map(a => [a.id, a.state, a.kind, a.fromAgent])).toEqual([[out.localAskId, "open", "authorize", null]]);
      expect(publishMigrationAsks()).toBe(0);
      expect(seen).toHaveLength(1);
    } finally { off(); }
  });
});

describe("验收线 5：不读新凭据、不打印 bearer / 签名", () => {
  test("命令输出与本机卡里没有 bearer、签名；凭据只经注入的 Stage2Wiring 取", async () => {
    const w = await world();
    const logs: string[] = [], orig = { log: console.log, info: console.info, warn: console.warn, error: console.error };
    for (const k of ["log", "info", "warn", "error"] as const) console[k] = (...a: unknown[]) => { logs.push(a.map(String).join(" ")); };
    try {
      const out = await w.ask();
      await answer(w, localCard(w), "[button:approve]", owner);
      const text = JSON.stringify([out, localCard(w), logs]);
      expect(text).not.toMatch(/SECRET-|bearer|signature|BEGIN PRIVATE/i);
    } finally { Object.assign(console, orig); }
  });
});
