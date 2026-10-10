/**
 * LENDUI1 交付登记：真 `ledger lend-write`（runLedger）收写单交付，图由收图函数（lib/lend-ui-store.ts）真实写进临时工件根，
 * 清单用它回的 ref / sha256 拼。uiDelivery 与 lendUiShots 各自一把键，都写在临时策略文件里；不带清单、或 uiDelivery = on 的交付
 * 在 lendUiShots 三态下逐字相同（新键不插手）。
 */
import type { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { instanceKeySync, signPurpose } from "../src/lib/instance-key.js";
import { uiDeliverPort } from "../src/lib/ledger-deliver-ui-port.js";
import { RECEIPT_PURPOSE } from "../src/lib/ledger-lend-result.js";
import { closeLedger, getTask, listEvents, openLedger } from "../src/lib/ledger-store.js";
import { createTask, setMeta } from "../src/lib/ledger-write.js";
import type { BorrowEntry } from "../src/lib/lend-config.js";
import { lendUiPort, type LendUiPort } from "../src/lib/lend-ui-deliver.js";
import { receiveLendShot, type LendShotStored } from "../src/lib/lend-ui-store.js";
import { lendShotBody, parseLendShot } from "../src/lib/lend-ui-wire.js";
import type { RemoteHead } from "../src/lib/order-deliver.js";
import { uiEvidenceDigest, type UiEvidence, type UiShot } from "../src/lib/order-deliver-ui.js";
import type { RecoveryMode } from "../src/lib/recovery-policy.js";
import { observeSnapshot } from "../src/lib/scheduler-snapshot.js";
import { uiPassStep } from "../src/lib/scheduler-ui-gate.js";
import { runLedger } from "../src/manager/ledger.js";

const P = "claude-orchestrator";
const H2 = "c".repeat(40);
const OLD = "e".repeat(40);
const REPO = "shawnlu96/claudestra";
const FP = "abcd-ef01-2345-6789";
const BR = "lend/T9-abcd";
const WORKER = "agent-lend-0123456789";
const MODES: RecoveryMode[] = ["on", "observe", "off"];
let db: Database;
let now: number;
let remote: Record<string, RemoteHead>;
/** 注入的 lendUi 记下被问过几次；injectLendUi = false 时不注入，走缺省（读本机策略文件，测试进程里是空的临时状态目录） */
let lendUiCalls: number;
let injectLendUi: boolean;
const dir = mkdtempSync(join(tmpdir(), "lend-ui-deliver-test-"));
const root = join(dir, "ui-artifacts");
const policyPath = join(dir, "recovery-policy.json");
const key = instanceKeySync(dir);
const borrow: BorrowEntry[] = [{ peer: "mate", projects: [P], roles: ["review", "write"], maxOpen: 2 }];

function countedLendUi(): LendUiPort {
  const real = lendUiPort({ policyPath, now });
  return { mode: (p) => { lendUiCalls++; return real.mode(p); }, observe: (d, a) => { lendUiCalls++; real.observe(d, a); } };
}
const deps = (actor: string) => ({
  db, actor, projectIds: [P], loadRegistry: async () => ({ socket: "", agents: {} }), saveRegistry: async () => {}, now: () => now,
  lend: {
    borrow: async () => borrow, notifyPm: async () => {},
    result: {
      reportDir: () => dir, writeReport: (p: string, b: string) => writeFileSync(p, b), sign: (f: string[]) => signPurpose(RECEIPT_PURPOSE, f, key),
      remoteHead: async (_repo: string, branch: string): Promise<RemoteHead> => remote[branch] ?? { ok: false, error: "没有这个分支" },
      peerFp: async (peer: string) => (peer === "mate" ? FP : null),
      uiPort: (p: { peer: string; worker: string; orderId: string }) => uiDeliverPort({ peer: p, root, policyPath, now }),
      ...(injectLendUi ? { lendUi: countedLendUi() } : {}),
    },
  },
});
const run = (args: string[], actor = "agent-pm") => runLedger(args, deps(actor)) as Promise<Record<string, any>>;
const call = (ep: string, body: unknown) => run([`lend-${ep}`, "--", "mate", JSON.stringify(body)], "owner");
const body = (orderId: string, ui?: unknown) => ({
  v: 1, orderId, gen: 1, branch: BR, pr: 7, session: { id: "sess-1", family: "codex" },
  deliver: { v: 1, orderId, head: H2, evidence: BR, summary: "改了首页", selfCheck: "逐条对了", ...(ui === undefined ? {} : { uiEvidence: ui }) },
});
const policy = (uiDelivery: RecoveryMode, lendUiShots: RecoveryMode) =>
  writeFileSync(policyPath, JSON.stringify({ projects: { [P]: { keys: { uiDelivery, lendUiShots } } } }));

function chunk(type: string, data: Uint8Array): Buffer {
  const b = Buffer.alloc(12 + data.length);
  b.writeUInt32BE(data.length, 0);
  b.write(type, 4, "latin1");
  b.set(data, 8);
  return b;
}
function png(seed: string): Buffer {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(390, 0);
  ihdr.writeUInt32BE(844, 4);
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", ihdr), chunk("IDAT", Buffer.from(seed)), chunk("IEND", Buffer.alloc(0))]);
}

/** 走真实收图函数把一张图存进导入目录（收图开关按 observe：存盘不看 lendUiShots 是 observe 还是 on） */
function stored(orderId: string, view: string, phase: "before" | "after", seed = `${view}-${phase}`): UiShot {
  const shot = parseLendShot(JSON.parse(lendShotBody({ orderId, gen: 1, head: H2, view, size: "390x844", phase }, png(seed))));
  if (!shot.ok) throw new Error(shot.error);
  const r = receiveLendShot(db, "mate", shot.value, { importedRoot: uiDeliverPort({ root }).roots.imported, mode: () => "observe", now: () => now });
  expect(r).toMatchObject({ ok: true });
  return { view, size: "390x844", phase, ref: (r as LendShotStored).ref, sha256: (r as LendShotStored).sha256 };
}
function manifest(shots: UiShot[], over: Partial<UiEvidence> = {}): UiEvidence {
  const e = { v: 1 as const, taskId: "T9", head: H2, specRev: 1, round: 1, source: "imported" as const, summary: "手机首页前后", shots, ...over };
  return { ...e, digest: uiEvidenceDigest(e) };
}
const pair = (orderId: string) => [stored(orderId, "home", "before"), stored(orderId, "home", "after")];

async function claimed(): Promise<string> {
  const { orderId } = await run(["lend-offer", "T9", "--peer", "mate", "--repo", REPO]);
  expect(await call("claim", { v: 1, orderId, worker: WORKER })).toMatchObject({ ok: true });
  remote[BR] = { ok: true, head: H2 };
  return orderId;
}
function fresh(): void {
  closeLedger(":memory:");
  rmSync(root, { recursive: true, force: true });
  db = openLedger(":memory:");
  now = 1_000_000;
  remote = { main: { ok: true, head: "b".repeat(40) } };
  lendUiCalls = 0;
  injectLendUi = true;
  setMeta(db, { actor: "owner", now }, { project: P, key: "pms", value: ["agent-pm"] });
  const spec = join(dir, "T9.md");
  writeFileSync(spec, "规格：只改 src/lib/x.ts\n验收：单测全绿");
  createTask(db, { actor: "owner", now }, { project: P, id: "T9", title: "T9", kind: "code", spec, agent: "agent-dev" } as never);
  db.run("UPDATE tasks SET stage = 'build', round = 0 WHERE id = 'T9'");
  db.run(`INSERT INTO task_workflows (taskId, project, template, templateVersion, mode, authorFamily, fallback, specRev, createdAt, updatedAt)
    VALUES ('T9', ?, 'ui', 3, 'manual', 'codex', '', 1, 1, 1)`, [P]);
}
const notes = (mechanism: string) => listEvents(db, { target: "T9" }).filter((e) => e.kind === "note" && e.data.mechanism === mechanism);
const delivers = () => listEvents(db, { target: "T9" }).filter((e) => e.kind === "deliver");
const passStep = () => uiPassStep(observeSnapshot(db, getTask(db, "T9")!, { maxWorkers: 2, now } as never), "pm_ui", 0);
/** 回执、卡、事件（含 note）、单的状态：两次交付「逐字一致」比的就是这一份 */
const facts = (receipt: unknown) => JSON.stringify({ receipt, tasks: db.query("SELECT * FROM tasks").all(), orders: db.query("SELECT orderId, status, resultSha, receipt FROM lend_orders").all(),
  events: db.query("SELECT seq, kind, actor, target, text, data, dedupKey FROM events ORDER BY seq").all() });

beforeEach(fresh);
afterEach(() => closeLedger(":memory:"));

describe("[验收线 3] 出借写单交付的截图登记", () => {
  test("uiDelivery = observe、lendUiShots = on、清单合法 → 登记到卡和交付事件，调度不再报缺截图；lendUiShots = off 时同一份交付报缺", async () => {
    policy("observe", "off");
    let orderId = await claimed();
    expect(await call("write", body(orderId, manifest(pair(orderId))))).toMatchObject({ ok: true });
    expect(getTask(db, "T9")!.extra.screenshots).toBeUndefined();
    expect(passStep()).toMatchObject({ kind: "escalate", code: "ui_missing_screenshots" });

    fresh();
    policy("observe", "on");
    orderId = await claimed();
    const e = manifest(pair(orderId));
    expect(await call("write", body(orderId, e))).toMatchObject({ ok: true });
    const t = getTask(db, "T9")!;
    expect(t).toMatchObject({ stage: "review", headSHA: H2, round: 1 });
    expect(t.extra.screenshotsDigest).toBe(e.digest);
    expect(t.extra.screenshots).toEqual(["s01.png", "s02.png"].map((ref) => join(root, "imported", "mate", orderId.replaceAll(":", "_"), ref)));
    expect(delivers()).toHaveLength(1);
    expect(delivers()[0]!.data.uiEvidence).toMatchObject({ digest: e.digest, source: "imported", bytesVerified: true, peer: { peer: "mate", worker: WORKER, orderId } });
    expect(passStep()).not.toMatchObject({ code: "ui_missing_screenshots" });
    expect(passStep().kind).not.toBe("escalate");
    expect([notes("lendUiShots"), notes("uiDelivery")]).toEqual([[], []]);
  });

  test("两个键各管各的：uiDelivery = off 时 lendUiShots on 照样登记、observe 只记 note、on 不合格照常入账并记 code", async () => {
    policy("off", "on");
    let orderId = await claimed();
    const e = manifest(pair(orderId));
    expect(await call("write", body(orderId, e))).toMatchObject({ ok: true });
    expect(getTask(db, "T9")).toMatchObject({ stage: "review", extra: { screenshotsDigest: e.digest } });
    expect(delivers()[0]!.data.uiEvidence).toMatchObject({ digest: e.digest });
    expect(notes("lendUiShots")).toEqual([]);

    fresh();
    policy("off", "observe");
    orderId = await claimed();
    expect(await call("write", body(orderId, manifest(pair(orderId))))).toMatchObject({ ok: true });
    expect([getTask(db, "T9")!.stage, getTask(db, "T9")!.extra.screenshots, notes("lendUiShots").map((n) => n.data.register), notes("uiDelivery")])
      .toEqual(["review", undefined, [2], []]);

    fresh();
    policy("off", "on");
    orderId = await claimed();
    const [b, a] = pair(orderId);
    expect(await call("write", body(orderId, manifest([{ ...b!, sha256: "0".repeat(64) }, a!])))).toMatchObject({ ok: true });
    expect([getTask(db, "T9")!.stage, getTask(db, "T9")!.extra.screenshots, notes("lendUiShots").map((n) => n.data.code), notes("uiDelivery")])
      .toEqual(["review", undefined, ["hash_mismatch"], []]);
  });

  test("note 与交付事件同一事务，note 在前；结构不合法的 uiEvidence 照旧在解析处拒收", async () => {
    policy("observe", "observe");
    const orderId = await claimed();
    const e = manifest(pair(orderId));
    const before = db.query("SELECT count(*) AS n FROM events").get();
    expect(await call("write", body(orderId, { ...e, digest: "0".repeat(64) }))).toMatchObject({ ok: false });
    expect(db.query("SELECT count(*) AS n FROM events").get()).toEqual(before);
    expect(await call("write", body(orderId, e))).toMatchObject({ ok: true });
    expect(notes("lendUiShots")[0]!.seq).toBeLessThan(delivers()[0]!.seq);
  });

  test("lendUiShots = observe → 不登记，记一条「本会登记」note；同一份正文重放不多记", async () => {
    policy("observe", "observe");
    const orderId = await claimed();
    const e = manifest(pair(orderId));
    const first = await call("write", body(orderId, e));
    expect(first).toMatchObject({ ok: true });
    const t = getTask(db, "T9")!;
    expect([t.stage, t.extra.screenshots, t.extra.screenshotsDigest]).toEqual(["review", undefined, undefined]);
    expect(delivers()[0]!.data.uiEvidence).toBeUndefined();
    expect(notes("lendUiShots")).toHaveLength(1);
    expect(notes("lendUiShots")[0]).toMatchObject({ text: "恢复观察（lendUiShots）：本会 登记 2 张出借截图",
      data: { actionKey: `lend-ui:${orderId}:r1:register:${H2.slice(0, 12)}`, register: 2, digest: e.digest } });
    expect(notes("uiDelivery")).toEqual([]); // 清单本身合格，uiDelivery 的观察没什么可记
    expect(await call("write", body(orderId, e))).toEqual(first);
    expect([notes("lendUiShots").length, delivers().length]).toEqual([1, 1]);
  });

  test("lendUiShots = on 且清单不合格 → 交付照常入账、卡进 review、不登记，记一条带 code 的 note", async () => {
    const cases: [string, (orderId: string) => UiEvidence][] = [
      ["hash_mismatch", (o) => { const [b, a] = pair(o); return manifest([{ ...b!, sha256: "0".repeat(64) }, a!]); }],
      ["artifact_missing", (o) => { const [b, a] = pair(o); return manifest([b!, { ...a!, ref: "s09.png" }]); }],
      ["not_imported", (o) => { // 文件在目录里、哈希也对，但不是经收图接口进来的（导入记录里没有它）
        const [b, a] = pair(o), at = join(root, "imported", "mate", o.replaceAll(":", "_"), "s09.png");
        writeFileSync(at, png("sneaked"));
        return manifest([b!, { ...a!, ref: "s09.png", sha256: new Bun.CryptoHasher("sha256").update(png("sneaked")).digest("hex") }]);
      }],
      ["slot_mismatch", (o) => { const [b, a] = pair(o); return manifest([{ ...b!, phase: "after" }, { ...a!, phase: "before" }]); }],
      ["slot_mismatch", (o) => { const [b, a] = pair(o); return manifest([{ ...b!, view: "settings" }, { ...a!, view: "settings" }]); }],
      ["wrong_head", (o) => manifest(pair(o), { head: OLD })],
      ["wrong_round", (o) => manifest(pair(o), { round: 2 })],
    ];
    for (const [code, ui] of cases) {
      fresh();
      policy("observe", "on");
      const orderId = await claimed();
      const r = await call("write", body(orderId, ui(orderId)));
      expect({ code, ok: r.ok }).toEqual({ code, ok: true });
      const t = getTask(db, "T9")!;
      expect([code, t.stage, t.headSHA, t.extra.screenshots, t.extra.screenshotsDigest]).toEqual([code, "review", H2, undefined, undefined]);
      expect(delivers()[0]!.data.uiEvidence).toBeUndefined();
      expect(notes("lendUiShots").map((n) => [n.data.code, n.data.actionKey])).toEqual([[code, `lend-ui:${orderId}:r1:${code}:${H2.slice(0, 12)}`]]);
      expect(notes("lendUiShots")[0]!.text).toContain(`不合格：${code}`);
      expect(passStep()).toMatchObject({ code: "ui_missing_screenshots" });
    }
  });

  test("收图时 head 与交付 head 不同（导入记录是另一个 head 的）→ 不登记，交付照常", async () => {
    policy("observe", "on");
    const orderId = await claimed();
    const shots = pair(orderId);
    const provPath = join(root, "imported", "mate", orderId.replaceAll(":", "_"), "provenance.json");
    writeFileSync(provPath, (await Bun.file(provPath).text()).replace(H2, OLD));
    expect(await call("write", body(orderId, manifest(shots)))).toMatchObject({ ok: true });
    expect(getTask(db, "T9")!.extra.screenshots).toBeUndefined();
    expect(notes("lendUiShots").map((n) => n.data.code)).toEqual(["provenance_mismatch"]);
  });
});

describe("[验收线 5] 没配 lendUiShots", () => {
  test("不注入、本机策略文件不存在 → 按 observe：只记「本会登记」，不登记", async () => {
    policy("observe", "on"); // 注入的 uiPort 读这份；缺省的 lendUi 读的是本机策略文件，不是它
    injectLendUi = false;
    const orderId = await claimed();
    expect(await call("write", body(orderId, manifest(pair(orderId))))).toMatchObject({ ok: true });
    expect(getTask(db, "T9")!.extra.screenshots).toBeUndefined();
    expect(notes("lendUiShots").map((n) => n.data.register)).toEqual([2]);
  });
});

describe("[验收线 3 / 4] 新键不插手的地方逐字不变", () => {
  /** 同一场景在 lendUiShots 三态下各跑一遍（每次全新台账与工件根），返回三份事实 */
  async function threeWays(uiDelivery: RecoveryMode, withUi: boolean): Promise<{ facts: string[]; calls: number[] }> {
    const out = { facts: [] as string[], calls: [] as number[] };
    for (const lendUiShots of MODES) {
      fresh();
      policy(uiDelivery, lendUiShots);
      const orderId = await claimed();
      const receipt = await call("write", body(orderId, withUi ? manifest(pair(orderId)) : undefined));
      out.facts.push(facts(receipt));
      out.calls.push(lendUiCalls);
    }
    return out;
  }

  test("不带 uiEvidence 的交付：uiDelivery 三态 × lendUiShots 三态，回执 / 事件 / 卡 / note 只随 uiDelivery 变，从不读 lendUiShots", async () => {
    for (const uiDelivery of MODES) {
      const r = await threeWays(uiDelivery, false);
      expect([uiDelivery, new Set(r.facts).size, r.calls]).toEqual([uiDelivery, 1, [0, 0, 0]]);
      const ok = (JSON.parse(r.facts[0]!) as { receipt: { ok: boolean } }).receipt.ok;
      expect([uiDelivery, ok]).toEqual([uiDelivery, uiDelivery !== "on"]); // on：ui 卡缺清单照旧拒收（UISDEL1 的口径）
      expect(notes("lendUiShots")).toEqual([]);
      expect(notes("uiDelivery")).toHaveLength(uiDelivery === "observe" ? 1 : 0); // observe：仍只有那一条 uiDelivery missing
    }
  });

  test("uiDelivery = on 带清单：照 UISDEL1 登记，lendUiShots 三态逐字相同、没被读过", async () => {
    const r = await threeWays("on", true);
    expect([new Set(r.facts).size, r.calls]).toEqual([1, [0, 0, 0]]);
    expect(getTask(db, "T9")!.extra.screenshotsDigest).toMatch(/^[0-9a-f]{64}$/);
    expect(notes("lendUiShots")).toEqual([]);
  });

  test("lendUiShots = off 带清单：与没有这把键时一样——不登记、不记 lendUiShots note", async () => {
    for (const uiDelivery of ["observe", "off"] as const) {
      fresh();
      policy(uiDelivery, "off");
      const orderId = await claimed();
      expect(await call("write", body(orderId, manifest(pair(orderId))))).toMatchObject({ ok: true });
      expect([getTask(db, "T9")!.extra.screenshots, delivers()[0]!.data.uiEvidence, notes("lendUiShots"), notes("uiDelivery")]).toEqual([undefined, undefined, [], []]);
      expect(lendUiCalls).toBe(1); // 只问了一次模式，没有别的动作
    }
  });
});
