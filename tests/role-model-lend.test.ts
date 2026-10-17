/**
 * TIER1b 借入方 A 这一半：领单材料带不带模型档位建议（claim 的 caps + roleModel 开关）、建议进摘要、入账记对方报的实际 / unknown。
 * 走真的 `ledger lend-claim / lend-write`（本机内存台账，对方是合成的 peer「mate」，不连网、不起模型）；开关与档位表经 useRoleModelPort 注入。
 * 出借方 B 那一半在 tests/role-model-lend-peer.test.ts。
 */
import type { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { fourRoundFix } from "./fix-strategy-helpers.js";
import { remoteProbe, resultDeps } from "./fix-strategy-remote-helpers.js";
import { fixSwapStep } from "../src/lib/fix-strategy-runtime.js";
import { remoteOrder } from "../src/lib/fix-strategy-remote-order.js";
import { claimLend } from "../src/lib/ledger-lend.js";
import { writeLendDeliver } from "../src/lib/ledger-lend-result.js";
import { LedgerError } from "../src/lib/ledger-store.js";
import { lendRequest } from "../src/lib/lend-remote.js";
import { parseLendRequest, type DeliverRequest } from "../src/lib/lend-wire.js";
import type { LendFamily, ModelActual, ModelActualRecord, ModelSuggest } from "../src/lib/lend-wire-types.js";
import { closeLedger, listEvents, openLedger } from "../src/lib/ledger-store.js";
import { createTask, setMeta } from "../src/lib/ledger-write.js";
import type { RecoveryMode } from "../src/lib/recovery-policy.js";
import { claimSuggest, intakeActual, lendActualOf, lendCardRole } from "../src/lib/role-model-settings-lend.js";
import { useRoleModelPort, type RoleModelPort } from "../src/lib/role-model-settings-local.js";
import { defaultRoleModels, type RoleModelRead } from "../src/lib/role-model-settings.js";
import { launchActual, parseModelActual, parseModelSuggest, suggestDigest, suggestFamilyProblem, withinGrant } from "../src/lib/role-model-settings-wire.js";
import { CODEX_EFFORT_LEVELS } from "../src/lib/codex-launch.js";
import { runLedger } from "../src/manager/ledger.js";

const P = "claude-orchestrator";
const H = "a".repeat(40);
const ORDER = "lend:T9:s1:r1:a0";
const WORKER = "agent-lend-0123456789";
const dir = mkdtempSync(join(tmpdir(), "role-model-lend-"));
const spec = join(dir, "T9.md");
writeFileSync(spec, "规格：只改 src/lib/x.ts\n验收：单测全绿");
const sha = (s: string) => createHash("sha256").update(s, "utf8").digest("hex");
let db: Database;
let now: number;

const deps = (actor: string) => ({
  db, actor, projectIds: [P], loadRegistry: async () => ({ socket: "", agents: {} }), saveRegistry: async () => {}, now: () => now,
  lend: {
    borrow: async () => [{ peer: "mate", projects: [P], roles: ["review" as const], maxOpen: 2 }], notifyPm: async () => {},
    result: { reportDir: () => dir, writeReport: (p: string, b: string) => writeFileSync(p, b), sign: () => ({ key: "KEY", sig: "SIG" }), peerFp: async () => null },
  },
});
const run = (args: string[], actor = "agent-pm") => runLedger(args, deps(actor)) as Promise<Record<string, unknown>>;
/** bridge 回给对方的那一份正文（同 tests/lend-wire-v1-golden.test.ts） */
async function peer(ep: "claim" | "result", body: unknown): Promise<string> {
  const { ok: _ok, notified: _n, ...rest } = await run([`lend-${ep === "result" ? "write" : ep}`, "--", "mate", JSON.stringify(body)], "owner");
  return JSON.stringify({ ok: true, ...rest });
}
/** 被拒时的 wire 码（bridge 取 current.lend，没有就台账的 code）；收下了 = accepted */
const refused = async (ep: "claim" | "result", body: unknown): Promise<string> => {
  const r = await run([`lend-${ep === "result" ? "write" : ep}`, "--", "mate", JSON.stringify(body)], "owner") as { ok?: boolean; code?: string; current?: { lend?: string } };
  return r.ok === true ? "accepted" : String(r.current?.lend ?? r.code);
};

/** 档位表：对抗审查的 codex 档是 high（owner 存过），别的照默认 */
const table = (): RoleModelRead => {
  const t = defaultRoleModels();
  t.rev = 3; t.roles["adversarial-reviewer"].codex = "high";
  return { status: "ok", table: t };
};
/** 读过几次 roleModel 开关（旧对端那条路一次都不许读） */
let policyReads = 0;
const port = (mode: RecoveryMode, read: RoleModelRead = table()): RoleModelPort => ({
  policy: () => { policyReads++; return { mode, manualAfterMs: null, source: "config" }; }, read: () => read,
  observe: () => { throw new Error("出借这一半不经本地的 observe 端口"); },
});
const UNKNOWN: ModelActualRecord = { model: null, effort: null, source: "unknown" };

const CLAIM = { v: 1, orderId: ORDER, worker: WORKER };
const CAPPED = { ...CLAIM, caps: ["suggest"] };
const RESULT = { v: 1, orderId: ORDER, gen: 1, verdict: { v: 1, orderId: ORDER, head: H, verdict: "pass", p0: 0, p1: 0, p2: 0, findings: [], reportPath: "r.md" },
  report: "## 结论\n通过", session: { id: "sess-1", family: "codex" } };
const ACTUAL: ModelActual = { model: null, effort: "high", source: "suggest" };
const events = () => listEvents(db, { project: P, target: "T9" });
const lendNotes = (op: string) => events().filter((e) => (e.data.lend as { op?: string } | undefined)?.op === op).map((e) => e.data.lend as Record<string, unknown>);
const wouldUse = () => events().filter((e) => e.data.op === "recovery_observe" && e.data.mechanism === "roleModel");

async function fresh(mode: RecoveryMode, read?: RoleModelRead): Promise<void> {
  closeLedger(":memory:");
  db = openLedger(":memory:");
  now = 1_000_000;
  policyReads = 0;
  useRoleModelPort(port(mode, read));
  setMeta(db, { actor: "owner", now }, { project: P, key: "pms", value: ["agent-pm"] });
  createTask(db, { actor: "owner", now }, { project: P, id: "T9", title: "T9", kind: "code", spec });
  db.run(`UPDATE tasks SET stage = 'review', headSHA = '${H}', round = 1 WHERE id = 'T9'`);
  await run(["lend-offer", "T9", "--peer", "mate", "--repo", "shawnlu96/claudestra", "--pr", "12"]);
}
/** 每种开关各开一本新台账跑同一段，返回各自的输出 */
async function perMode<T>(modes: RecoveryMode[], body: () => Promise<T>): Promise<T[]> {
  const out: T[] = [];
  for (const m of modes) { await fresh(m); out.push(await body()); }
  return out;
}

beforeEach(() => { db = openLedger(":memory:"); });
afterEach(() => { useRoleModelPort(); closeLedger(":memory:"); });

describe("[验收线 1] 旧 peer（claim 不带 caps）", () => {
  test("领单材料、摘要与开关无关，逐字节相同；摘要仍是派单全文的 sha256", async () => {
    const [off, observe, on] = await perMode(["off", "observe", "on"], () => peer("claim", CLAIM));
    expect(observe).toBe(off as string);
    expect(on).toBe(off as string);
    const body = JSON.parse(on as string) as Record<string, unknown>;
    expect(Object.keys(body)).toEqual(["ok", "v", "order", "text", "sha256", "lease"]);
    expect(body.sha256).toBe(sha(body.text as string));
    expect(lendNotes("claim")).toEqual([expect.not.objectContaining({ suggest: expect.anything() })]); // on 下也不替旧对端记建议
    expect(wouldUse()).toEqual([]);
  });

  test("它交回的结果没有 actual：入账照旧（回执、事件与 off 逐字节 / 逐条相同），这一单的实际读出来是 unknown；整条路不读 roleModel 开关", async () => {
    const [off, on] = await perMode(["off", "on"], async () => {
      await peer("claim", CLAIM);
      return { receipt: await peer("result", RESULT), kinds: events().map((e) => `${e.kind}:${e.text}`), actual: lendActualOf(events(), ORDER), reads: policyReads };
    });
    expect(on!.receipt).toBe(off!.receipt);
    expect(Object.keys((JSON.parse(on!.receipt) as { receipt: object }).receipt)).toEqual(["orderId", "sha256", "eventSeq", "taskId", "key", "sig"]);
    expect(on!.kinds).toEqual(off!.kinds);
    expect([on!.actual, off!.actual]).toEqual([UNKNOWN, UNKNOWN]); // 没报就是 unknown，不拿表值 / 建议充数
    expect([on!.reads, off!.reads]).toEqual([0, 0]); // tests/recovery-materials-wiring-process.test.ts 钉着「交付只读 uiDelivery」
  });
});

describe("[验收线 2] 新 peer、开关 on", () => {
  beforeEach(() => fresh("on"));

  test("材料带 suggest（codex 单只有推理档），摘要把建议算进去；别的字段和不带时一样", async () => {
    const got = JSON.parse(await peer("claim", CAPPED)) as Record<string, unknown>;
    const suggest = { effort: "high", source: "settings" };
    expect(got.suggest).toEqual(suggest);
    expect(got.sha256).toBe(suggestDigest(got.text as string, suggest as ModelSuggest));
    expect(got.sha256).not.toBe(sha(got.text as string));
    expect(lendNotes("claim")).toEqual([expect.objectContaining({ worker: WORKER, gen: 1, suggest })]);
    await fresh("on");
    const plain = JSON.parse(await peer("claim", CLAIM)) as Record<string, unknown>;
    const { suggest: _s, sha256: _d, ...rest } = got;
    const { sha256: _p, ...base } = plain;
    expect(rest).toEqual(base);
  });

  test("出借方核摘要：原样通过；改了建议、拿掉建议、给旧摘要配上建议都被拒", async () => {
    const body = JSON.parse(await peer("claim", CAPPED)) as Record<string, unknown>;
    const via = (b: unknown) => lendRequest(async () => ({ status: 200, body: b }), "mate", "claim", CAPPED);
    expect(await via(body)).toMatchObject({ ok: true, value: { suggest: { effort: "high", source: "settings" } } });
    const { suggest: _s, ...stripped } = body;
    for (const tampered of [{ ...body, suggest: { effort: "max", source: "settings" } }, { ...body, suggest: { effort: "high", source: "default" } }, stripped,
      { ...body, sha256: sha(body.text as string) }]) {
      expect(await via(tampered)).toMatchObject({ ok: false, code: "bad_response" });
    }
    expect(await via({ ...body, suggest: { effort: "high", source: "settings", extra: 1 } })).toMatchObject({ ok: false, code: "bad_response" });
  });

  test("持有人重复 claim：回第一次那一份建议，不按改过的表重算", async () => {
    const first = await peer("claim", CAPPED);
    const changed = table(); changed.table.roles["adversarial-reviewer"].codex = "low";
    useRoleModelPort(port("on", changed));
    expect(await peer("claim", CAPPED)).toBe(first);
    expect(Object.keys(JSON.parse(await peer("claim", CLAIM)) as object)).not.toContain("suggest"); // 这一次没带 caps：照旧版回
  });

  test("交付的 actual 记进卡和回执；同一份重发回同一张回执，换一份拒", async () => {
    await peer("claim", CAPPED);
    const body = { ...RESULT, actual: ACTUAL };
    const receipt = await peer("result", body);
    expect((JSON.parse(receipt) as { receipt: Record<string, unknown> }).receipt).toMatchObject({ orderId: ORDER, key: "KEY", sig: "SIG", actual: ACTUAL });
    expect(lendNotes("actual")).toEqual([{ orderId: ORDER, peer: "mate", op: "actual", actual: ACTUAL }]);
    expect(events().filter((e) => e.kind === "review").length).toBe(1);
    expect(await peer("result", body)).toBe(receipt);
    expect(await refused("result", { ...RESULT, actual: { ...ACTUAL, effort: "low" } })).toBe("conflict");
    expect(lendNotes("actual").length).toBe(1);
    expect(lendActualOf(events(), ORDER)).toEqual(ACTUAL);
  });

  test("给过建议、对方却没报 actual：卡上写明 unknown（不把建议记成实际），回执不多字段", async () => {
    await peer("claim", CAPPED);
    const receipt = (JSON.parse(await peer("result", RESULT)) as { receipt: Record<string, unknown> }).receipt;
    expect(Object.keys(receipt)).toEqual(["orderId", "sha256", "eventSeq", "taskId", "key", "sig"]);
    expect(lendNotes("actual")).toEqual([{ orderId: ORDER, peer: "mate", op: "actual", actual: UNKNOWN }]);
    expect(lendActualOf(events(), ORDER)).toEqual(UNKNOWN);
  });

  test("actual 严格校验：多字段、坏档位、codex 单带模型名整份不入账", async () => {
    await peer("claim", CAPPED);
    for (const bad of [{ ...ACTUAL, extra: 1 }, { model: null, effort: "high" }, { ...ACTUAL, source: "guess" }, { ...ACTUAL, effort: "HIGH" }, "high",
      { ...ACTUAL, model: "claude-opus-5-5" }, { ...ACTUAL, effort: "turbo" }]) {
      expect(await refused("result", { ...RESULT, actual: bad })).toBe("invalid");
    }
    expect(events().filter((e) => e.kind === "review")).toEqual([]);
    expect(lendNotes("actual")).toEqual([]);
  });

  test("表读不了 / 内容坏：不给建议（材料照旧版），诊断记在 claim 事件上", async () => {
    await fresh("on", { status: "invalid", error: "/secret/path 坏了", table: defaultRoleModels() });
    const got = JSON.parse(await peer("claim", CAPPED)) as Record<string, unknown>;
    expect(got.suggest).toBeUndefined();
    expect(got.sha256).toBe(sha(got.text as string));
    expect(lendNotes("claim")[0]).toMatchObject({ suggestDiagnostic: "模型档位表内容不合法，不给建议" }); // 本机路径不进事件
  });
});

describe("[验收线 2] 修复单的交付（writeLendDeliver，本机台账夹具）", () => {
  /** A 收一份修复交付：返回回执、卡上的 actual 记录、claim 给的建议；被拒返回 wire 码 */
  async function delivered(mode: RecoveryMode, actual: unknown, caps?: ["suggest"]) {
    useRoleModelPort(port(mode));
    const f = await fourRoundFix();
    const p = remoteProbe(f), intent = p.plan(); p.deps.localFamilyWait = () => "本机不接codex";
    await fixSwapStep(f.db, f.at("scheduler"), intent.id, p.deps); await fixSwapStep(f.db, f.at("scheduler"), intent.id, p.deps);
    const o = remoteOrder(f.db, intent.id)!;
    const claim = claimLend(f.db, f.at("owner"), "Peer", { v: 1, orderId: o.orderId, worker: "agent-lend-0123456789", ...(caps ? { caps } : {}) }, () => p.context.borrow[0]);
    const head = "5".repeat(40), req = { v: 1, orderId: o.orderId, gen: 1, branch: "feat/T1", pr: 7, session: { id: "peer-session", family: "codex" },
      deliver: { v: 1, orderId: o.orderId, head, evidence: "report.md", summary: "复现测试：remote-race，先红后绿", selfCheck: "先红后绿" }, ...(actual ? { actual } : {}) } as DeliverRequest;
    const d = { ...resultDeps, peerFp: async () => "abcd-bbbb-cccc-dddd", remoteHead: async () => ({ ok: true as const, head }) };
    const notes = () => listEvents(f.db, { project: f.task().project, target: f.task().id }).map((e) => e.data.lend as { op?: string; actual?: unknown } | undefined)
      .filter((l) => l?.op === "actual").map((l) => l!.actual);
    try {
      return { receipt: await writeLendDeliver(f.db, f.at("owner"), "Peer", req, "body", d), notes: notes(), stage: f.task().stage, suggest: (claim as { suggest?: unknown }).suggest };
    } catch (e) {
      if (!(e instanceof LedgerError)) throw e;
      return { code: (e.current?.lend ?? e.code) as string, notes: notes(), stage: f.task().stage };
    } finally { f.close(); }
  }
  const GRANT = { model: null, effort: "medium", source: "grant" };

  test("on：领单带 author 的建议（codex 只有推理档）；交付的 actual 记进卡和回执，没报记 unknown、回执不多字段", async () => {
    const told = await delivered("on", GRANT, ["suggest"]);
    expect(told).toMatchObject({ receipt: { sha256: "body", actual: GRANT }, notes: [GRANT], stage: "review", suggest: { effort: null, source: "settings" } });
    const silent = await delivered("on", null, ["suggest"]);
    expect(silent).toMatchObject({ notes: [UNKNOWN], stage: "review" }); // 给过建议却没报：写明 unknown
    expect(silent.receipt).not.toHaveProperty("actual");
    const old = await delivered("on", null);
    expect(old).toMatchObject({ notes: [], stage: "review" }); // 旧对端：不落账（读出来是 unknown）
    expect(old.suggest).toBeUndefined();
  });

  test("codex 单的 actual 带模型名：整份不入账，卡不动；off 下报了也不记", async () => {
    expect(await delivered("on", { ...GRANT, model: "gpt-9-codex" }, ["suggest"])).toMatchObject({ code: "invalid", notes: [], stage: "fix" });
    const off = await delivered("off", GRANT, ["suggest"]);
    expect(off).toMatchObject({ notes: [], stage: "review" });
    expect(off.receipt).not.toHaveProperty("actual");
    expect(off.suggest).toBeUndefined();
  });
});

describe("[验收线 3] 授权上限与家族", () => {
  const RANK = ["low", "medium", "high", "xhigh"];
  test("建议的一档开放了就用；没开放取已开放里最接近的一档（一样近取低的）", () => {
    expect(withinGrant("high", ["medium", "high"], RANK)).toEqual({ use: "high", source: "suggest" });
    expect(withinGrant("xhigh", ["low", "high"], RANK)).toMatchObject({ use: "high", source: "grant", diagnostic: expect.stringContaining("最接近的 high") });
    expect(withinGrant("medium", ["low", "high"], RANK)).toMatchObject({ use: "low", source: "grant" });
    expect(withinGrant("low", ["xhigh", "medium"], RANK)).toMatchObject({ use: "medium", source: "grant" });
  });

  test("排序或授权读不到、没开放任何一档：用对方原默认并有诊断，不猜", () => {
    for (const r of [withinGrant("high", ["medium"], null), withinGrant("high", null, RANK), withinGrant("high", [], RANK),
      withinGrant("turbo", ["medium"], RANK), withinGrant("high", ["mystery"], RANK)]) {
      expect(r).toEqual({ use: null, source: "default", diagnostic: expect.any(String) });
    }
    expect(withinGrant(null, ["medium"], RANK)).toEqual({ use: null, source: "default" }); // 没有建议：不是问题，不出诊断
  });

  test("起 worker 的实际只看授权带的参数：codex 只出现推理档，授权的那一档就是上限", () => {
    expect(launchActual("codex", { effort: "high", source: "settings" }, ["--effort", "high"])).toEqual({ actual: { model: null, effort: "high", source: "suggest" } });
    expect(launchActual("codex", { effort: "max", source: "settings" }, ["--model", "gpt-9", "--effort", "medium"]))
      .toEqual({ actual: { model: null, effort: "medium", source: "grant" }, diagnostic: expect.stringContaining("medium") });
    expect(launchActual("codex", { effort: "high", source: "settings" }, [])).toEqual({ actual: { model: null, effort: null, source: "default" }, diagnostic: expect.any(String) });
    expect(launchActual("codex", { effort: null, source: "default" }, ["--effort", "low"])).toEqual({ actual: { model: null, effort: "low", source: "grant" } });
    expect(launchActual("claude", { model: "claude-opus-5-5", source: "default" }, []))
      .toEqual({ actual: { model: null, effort: null, source: "default" }, diagnostic: expect.stringContaining("没有开放 Claude 模型选择") });
  });

  test("建议按家族给：claude 单是模型 id，codex 单只有推理档（表里是 null 也只是 null，不落到模型名）", () => {
    const order = (family: LendFamily, step = "write", node = "write") => ({ project: P, taskId: "T9", family, step, wire: { node } });
    useRoleModelPort(port("on"));
    // TIER3b：taskTierModels 缺省 on，建议取类型 × 角色有效值——code 作者的 Claude 格是产品默认 Opus（source default），不再是角色格
    expect(claimSuggest(db, order("claude"), ["suggest"], 1).suggest).toEqual({ model: "claude-opus-5-5", source: "default" });
    expect(claimSuggest(db, order("codex"), ["suggest"], 1).suggest).toEqual({ effort: null, source: "settings" });
    expect(claimSuggest(db, order("codex", "review", "adversarial_review"), ["suggest"], 1).suggest).toEqual({ effort: "high", source: "settings" });
    expect(claimSuggest(db, order("codex", "review", "arbitration"), ["suggest"], 1).suggest).toBeNull(); // 档位表里没有的角色不给建议
    expect([lendCardRole("fix", "fix"), lendCardRole("review", "adversarial_review"), lendCardRole("review", null)]).toEqual(["author", "adversarial-reviewer", null]);
    for (const s of Object.values(JSON.parse(JSON.stringify(claimSuggest(db, order("codex"), ["suggest"], 1))) as object)) expect(JSON.stringify(s)).not.toContain("claude-");
  });

  test("解析：suggest 只认两种形状；codex 单收到模型名、claude 单收到推理档都对不上", () => {
    expect(parseModelSuggest({ model: "claude-opus-5-5", source: "default" })).toEqual({ model: "claude-opus-5-5", source: "default" });
    expect(parseModelSuggest({ effort: null, source: "settings" })).toEqual({ effort: null, source: "settings" });
    for (const bad of [null, [], {}, { model: "gpt-9", source: "default" }, { model: "claude-x", effort: "high", source: "default" }, { effort: "turbo", source: "default" },
      { effort: "high" }, { effort: "high", source: "peer" }, { model: "--dangerous", source: "default" }]) expect(typeof parseModelSuggest(bad)).toBe("string");
    expect(suggestFamilyProblem("codex", { model: "claude-opus-5-5", source: "default" })).toContain("模型名");
    expect(suggestFamilyProblem("claude", { effort: "high", source: "default" })).toEqual(expect.any(String));
    expect([suggestFamilyProblem("codex", { effort: "high", source: "default" }), suggestFamilyProblem("codex", null)]).toEqual([null, null]);
    expect(typeof parseModelActual({ model: "-x", effort: null, source: "grant" })).toBe("string");
    expect(intakeActual({ project: P, family: "codex" }, { model: "gpt-9", effort: "high", source: "grant" }, () => true, port("on"))).toEqual({ refuse: expect.any(String) });
    expect(CODEX_EFFORT_LEVELS).toContain("high");
  });

  test("claim 的 caps 严格解析：只认 suggest，不能空、不能重复、不能是别的", () => {
    expect(parseLendRequest("claim", CAPPED)).toEqual({ ok: true, value: { v: 1, orderId: ORDER, worker: WORKER, caps: ["suggest"] } });
    expect(parseLendRequest("claim", CLAIM)).toEqual({ ok: true, value: { v: 1, orderId: ORDER, worker: WORKER } });
    for (const caps of [[], ["suggest", "suggest"], ["model"], "suggest", null]) expect(parseLendRequest("claim", { ...CLAIM, caps }).ok).toBe(false);
  });
});

describe("[验收线 4] observe 与 off", () => {
  test("observe：带了 caps 材料也不带 suggest（与旧对端逐字节相同），卡上记一条 would-use，重复 claim 不多记", async () => {
    await fresh("observe");
    const plain = await peer("claim", CLAIM);
    await fresh("observe");
    expect(await peer("claim", CAPPED)).toBe(plain);
    expect(await peer("claim", CAPPED)).toBe(plain);
    expect(wouldUse().map((e) => e.data)).toEqual([expect.objectContaining({ role: "adversarial-reviewer", family: "codex", wouldUse: "high", source: "settings", lend: true })]);
    expect(lendNotes("claim")).toEqual([expect.not.objectContaining({ suggest: expect.anything() })]);
    await peer("result", { ...RESULT, actual: ACTUAL }); // 对方若真报了，照实记（不当成建议）；回执带回
    expect(lendNotes("actual")).toEqual([expect.objectContaining({ actual: ACTUAL })]);
  });

  test("off：带了 caps 也与改前一致——材料不带 suggest、不记 would-use、结果里的 actual 不落账、回执不多字段", async () => {
    await fresh("off");
    const plain = await peer("claim", CLAIM);
    const plainReceipt = JSON.parse(await peer("result", RESULT)) as { receipt: Record<string, unknown> };
    await fresh("off");
    expect(await peer("claim", CAPPED)).toBe(plain);
    expect(wouldUse()).toEqual([]);
    const receipt = (JSON.parse(await peer("result", { ...RESULT, actual: ACTUAL })) as { receipt: Record<string, unknown> }).receipt;
    expect(Object.keys(receipt)).toEqual(Object.keys(plainReceipt.receipt));
    expect(lendNotes("actual")).toEqual([]);
  });
});

describe("[验收线 5] 迟到结果、同单两份", () => {
  beforeEach(() => fresh("on"));

  test("撤单之后带 actual 的结果照旧被拒（cancelled），卡上不留 actual", async () => {
    await peer("claim", CAPPED);
    await run(["lend-cancel", "T9", "--reason", "不借了"]);
    expect(await refused("result", { ...RESULT, actual: ACTUAL })).toBe("cancelled");
    expect(lendNotes("actual")).toEqual([]);
  });

  test("租约过期之后的结果照旧被拒（lease_expired）；代数不对照旧 stale_gen", async () => {
    await peer("claim", CAPPED);
    expect(await refused("result", { ...RESULT, gen: 2, actual: ACTUAL })).toBe("stale_gen");
    now += 3_600_000;
    expect(await refused("result", { ...RESULT, actual: ACTUAL })).toBe("lease_expired");
    expect(lendNotes("actual")).toEqual([]);
  });

  test("两个进程同单各交一份：先到的入账，后到的同字节拿同一张回执、不同字节 conflict，actual 只记一次", async () => {
    await peer("claim", CAPPED);
    const body = { ...RESULT, actual: ACTUAL };
    const [a, b] = await Promise.all([peer("result", body), peer("result", body)]);
    expect(a).toBe(b);
    expect(await refused("result", RESULT)).toBe("conflict");
    expect(lendNotes("actual").length).toBe(1);
  });
});
