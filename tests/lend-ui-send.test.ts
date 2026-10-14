/**
 * LENDUI2 出借方 B 交付时上传截图（src/lib/lend-ui-send.ts，经 lend-drive.ts publishWork）：B 走真 lendTick（假 peer A 的 poll / claim / lease、
 * 假 worker），worker 交的截图由真 prepareUiShots + storeUiCopies 核过拷进临时副本。端到端那组把 shot 端口转给 A 真的收图路由
 * （bridge/local-api/lend-shot.ts → parseLendShot + receiveLendShot，临时台账、临时工件根，搭法同 tests/lend-ui-shot.test.ts），
 * 再把 B 落下的交付正文喂给真 runLedger lend-write（搭法同 tests/ledger-lend-write-ui.test.ts）。journal 在内存，不碰 ~/.claude-orchestrator。
 */
import type { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { lendShotApi } from "../src/bridge/local-api/lend-shot.js";
import { instanceKeySync, signPurpose } from "../src/lib/instance-key.js";
import { uiDeliverPort } from "../src/lib/ledger-deliver-ui-port.js";
import { RECEIPT_PURPOSE } from "../src/lib/ledger-lend-result.js";
import { closeLedger, getTask, openLedger } from "../src/lib/ledger-store.js";
import { createTask, setMeta } from "../src/lib/ledger-write.js";
import type { BorrowEntry, LendEntry } from "../src/lib/lend-config.js";
import { lendBranch } from "../src/lib/lend-git.js";
import { advance, getMeta, getOrder, openLendJournal, patchOrder, type WorkUi } from "../src/lib/lend-journal.js";
import { lendTick, type LoopDeps } from "../src/lib/lend-loop.js";
import type { LendCall } from "../src/lib/lend-remote.js";
import { lendUiPort } from "../src/lib/lend-ui-deliver.js";
import { PUBLISH_GIVE_UP_MS } from "../src/lib/lend-pr-takeover-retry.js";
import { sendUiShots, uiCopyPath, uiObservedKey, uiShotBudget, useUiUploadMode } from "../src/lib/lend-ui-send.js";
import { prepareUiShots, storeUiCopies } from "../src/lib/lend-ui-submit.js";
import { lendShotBody } from "../src/lib/lend-ui-wire.js";
import type { RemoteHead } from "../src/lib/order-deliver.js";
import { uiEvidenceDigest, type UiEvidence } from "../src/lib/order-deliver-ui.js";
import type { HttpPeer } from "../src/lib/peers.js";
import type { Principal } from "../src/lib/principals.js";
import type { RecoveryMode } from "../src/lib/recovery-policy.js";
import { observeSnapshot } from "../src/lib/scheduler-snapshot.js";
import { uiPassStep } from "../src/lib/scheduler-ui-gate.js";
import { runLedger } from "../src/manager/ledger.js";

const P = "claude-orchestrator";
const BASE = "b".repeat(40);
const H2 = "c".repeat(40);
const REPO = "shawnlu96/claudestra";
const FP = "abcd-ef01-2345-6789";
const BR = lendBranch("T9", FP)!;
const T0 = 1_000_000;
const sha = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");
const PRIVACY = { home: "/nonexistent-home", lendRoot: "/nonexistent-lend", copy: "/nonexistent-copy", user: "zz", host: "zz" };

// ── PNG 夹具（收图不验 CRC，填 0） ──
function chunk(type: string, data: Uint8Array): Buffer {
  const b = Buffer.alloc(12 + data.length);
  b.writeUInt32BE(data.length, 0);
  b.write(type, 4, "latin1");
  b.set(data, 8);
  return b;
}
function png(seed: string, w = 390, h = 844): Buffer {
  const d = Buffer.alloc(13);
  d.writeUInt32BE(w, 0);
  d.writeUInt32BE(h, 4);
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", d), chunk("IDAT", Buffer.from(seed)), chunk("IEND", Buffer.alloc(0))]);
}

// ── A 侧：真台账 + 真收图路由 ──
let adb: Database;
let anow: number;
let remote: Record<string, RemoteHead>;
const adir = mkdtempSync(join(tmpdir(), "lend-ui-send-a-"));
const root = join(adir, "ui-artifacts");
const policyPath = join(adir, "recovery-policy.json");
const key = instanceKeySync(adir);
const borrow: BorrowEntry[] = [{ peer: "mate", projects: [P], roles: ["review", "write"], maxOpen: 2 }];
const aDeps = (actor: string) => ({
  db: adb, actor, projectIds: [P], loadRegistry: async () => ({ socket: "", agents: {} }), saveRegistry: async () => {}, now: () => anow,
  lend: {
    borrow: async () => borrow, notifyPm: async () => {},
    result: {
      reportDir: () => adir, writeReport: (p: string, b: string) => writeFileSync(p, b), sign: (f: string[]) => signPurpose(RECEIPT_PURPOSE, f, key),
      remoteHead: async (_repo: string, branch: string): Promise<RemoteHead> => remote[branch] ?? { ok: false, error: "没有这个分支" },
      peerFp: async (peer: string) => (peer === "mate" ? FP : null),
      uiPort: (p: { peer: string; worker: string; orderId: string }) => uiDeliverPort({ peer: p, root, policyPath, now: anow }),
      lendUi: lendUiPort({ policyPath, now: anow }),
    },
  },
});
const aRun = (args: string[], actor = "agent-pm") => runLedger(args, aDeps(actor)) as Promise<Record<string, any>>;
const aCall = (ep: string, body: unknown) => aRun([`lend-${ep}`, "--", "mate", JSON.stringify(body)], "owner");
const mate = { id: "token:t", role: "external", agents: [], createdAt: "", peer: "mate" } as unknown as Principal;
const aShots: { status: number; body: Record<string, any> }[] = [];
/** A 的收图路由（lendUiShots 收图按 observe 存盘） */
const aShotPort: LendCall<"shot"> = async (_peer, _op, body) => {
  const meta = body.meta as Parameters<typeof lendShotBody>[0];
  const api = lendShotApi({ refusal: () => null, db: () => adb, log: () => {}, now: () => anow, importedRoot: uiDeliverPort({ root }).roots.imported, mode: () => "observe" });
  const res = await api(new Request("http://x/api/v1/lend/shot", { method: "POST", body: lendShotBody(meta, readFileSync(String(body.file))) }), "/lend/shot", mate);
  const out = { status: res!.status, body: await res!.json() as Record<string, any> };
  aShots.push(out);
  return out;
};
function freshA(lendUiShots: RecoveryMode): void {
  closeLedger(":memory:");
  adb = openLedger(":memory:");
  anow = T0;
  remote = { main: { ok: true, head: BASE }, [BR]: { ok: true, head: H2 } };
  aShots.length = 0;
  writeFileSync(policyPath, JSON.stringify({ projects: { [P]: { keys: { uiDelivery: "off", lendUiShots } } } }));
  setMeta(adb, { actor: "owner", now: anow }, { project: P, key: "pms", value: ["agent-pm"] });
  const spec = join(adir, "T9.md");
  writeFileSync(spec, "规格：只改 src/lib/x.ts\n验收：单测全绿");
  createTask(adb, { actor: "owner", now: anow }, { project: P, id: "T9", title: "T9", kind: "code", spec, agent: "agent-dev" } as never);
  adb.run("UPDATE tasks SET stage = 'build', round = 0 WHERE id = 'T9'");
  adb.run(`INSERT INTO task_workflows (taskId, project, template, templateVersion, mode, authorFamily, fallback, specRev, createdAt, updatedAt)
    VALUES ('T9', ?, 'ui', 3, 'manual', 'codex', '', 1, 1, 1)`, [P]);
}
async function offered(): Promise<string> {
  const { orderId } = await aRun(["lend-offer", "T9", "--peer", "mate", "--repo", REPO]);
  return orderId as string;
}

// ── B 侧：真 lendTick，假 peer A 的 poll / claim / lease，假 worker ──
const ENTRY: LendEntry = { peer: "mate", fp: FP, families: { codex: 2 }, roles: ["review", "write"], repos: [REPO], ordersPerDay: 5,
  grantedAt: new Date(T0).toISOString(), until: new Date(T0 + 6 * 86_400_000).toISOString() };
const PEER = { name: "mate", addedAt: "x", fp: FP, baseUrl: "relay://abcd", outToken: "t", publicKey: "k", e2e: { idk: "i", ek: {} } } as unknown as HttpPeer;
const TEXT = "【出借派单】T9 · write";

interface BOpts { orderId?: string; shot?: LendCall<"shot">; onResult?: (body: Record<string, unknown>) => Promise<void> }
function harness(o: BOpts = {}) {
  const orderId = o.orderId ?? "lend:T9:1";
  const db = openLendJournal(":memory:");
  const dir = mkdtempSync(join(tmpdir(), "lend-ui-send-b-"));
  mkdirSync(join(dir, ".git"));
  const clock = { t: T0 };
  const logs: string[] = [];
  const renew = { fail: false };
  const shotCalls: Record<string, unknown>[] = [];
  const registry = new Map<string, { sessionId?: string; cwd?: string }>();
  const wire = { v: 1, orderId, taskId: "T9", specRev: 1, dagVersion: null, node: "build", step: "write", round: 0, head: BASE, repo: REPO, pr: null,
    inputs: ["规格原文"], outputs: ["提交"], acceptance: ["只推订单分支"], writeBack: "lend submit", findings: [], fallback: null };
  const polled = { orderId, taskId: "T9", step: "write", family: "codex", repo: REPO, pr: null, head: BASE, round: 0, specRev: 1, offeredAt: 1 };
  const d: LoopDeps = {
    db, now: () => clock.t, env: {}, footer: () => "（本机尾注）", log: (m) => logs.push(m),
    failure: () => undefined, closeAsks: async () => ({ ok: true }), codexQuota: async () => null,
    call: async (_p, op, body) => {
      if (op === "poll") return { status: 200, body: { ok: true, v: 1, orders: [polled], pollAfterMs: 30_000 } };
      if (op === "claim") return { status: 200, body: { ok: true, v: 1, order: wire, text: TEXT, sha256: createHash("sha256").update(TEXT).digest("hex"),
        lease: { gen: 1, expiresAt: 0, ms: 6 * 3600_000 }, write: { branch: BR, base: "main" } } };
      if (op === "lease" && renew.fail) throw new Error("断网");
      if (op === "lease") return { status: 200, body: { ok: true, v: 1, lease: body.action === "renew" ? { gen: 1, expiresAt: 0, ms: 6 * 3600_000 } : null } };
      await o.onResult?.(body);
      return { status: 503, body: { ok: false, code: "unavailable", error: "稍后" } }; // 回执不是本卡的事：留在 result_pending
    },
    ...(o.shot ? { shot: async (peer: string, op: "shot", body: Record<string, unknown>) => { shotCalls.push(body); return o.shot!(peer, op, body); } } : {}),
    readLend: async () => ({ status: "ok", file: { version: 2, enabled: true, lend: [ENTRY], borrow: [] } }),
    context: async () => ({ contacts: [{ name: "mate", fp: FP }], projects: [] }),
    peers: async () => [PEER],
    notify: async () => ({ ok: true }), retireAsk: async () => ({ ok: true }),
    clone: async () => ({ ok: true, dir }), removeDir: () => {},
    selfFp: () => FP, identity: () => ({ name: "lender", email: "l@x" }),
    push: { probe: async () => ({ ok: true }), work: async () => ({ ok: true }), pr: async () => ({ ok: true, pr: 7 }) },
    verifyReceipt: async () => true, writeReceipt: async () => {},
    worker: {
      find: (n) => registry.get(n),
      create: async (n, cwd, _p, gate) => { if (await gate()) return { ok: false, error: "gate" }; registry.set(n, { sessionId: "thr-1", cwd }); return { ok: true }; },
      send: async () => ({ ok: true, messageId: "m1" }),
      kill: async (n) => { registry.delete(n); return { ok: true }; },
      alive: async (n) => (registry.has(n) ? "running" : "no_window"),
    },
  };
  const tick = () => lendTick(d);
  /** 写好截图（真核、真拷贝）→ 走到 worker 已收首条派单 → 按 lend submit 落 work */
  const start = async (opts: { ui?: boolean; pairs?: number; selfCheck?: string } = {}) => {
    let ui: WorkUi | undefined;
    if (opts.ui !== false) {
      const shotsDir = join(dir, "ui-shots");
      mkdirSync(shotsDir, { recursive: true });
      const shots = [];
      for (let i = 0; i < (opts.pairs ?? 1); i++) for (const phase of ["before", "after"] as const) {
        writeFileSync(join(shotsDir, `${phase}-v${i}.png`), png(`${phase}-v${i}`));
        shots.push({ view: `v${i}`, size: "390x844", phase, file: `${phase}-v${i}.png` });
      }
      writeFileSync(join(shotsDir, "manifest.json"), JSON.stringify({ v: 1, summary: "首页前后", shots }));
      const prep = prepareUiShots(dir, join(shotsDir, "manifest.json"), { taskId: "T9", head: BASE, specRev: 1, round: 0 }, { ...PRIVACY, copy: dir });
      if (!prep.ok) throw new Error(prep.error);
      expect(storeUiCopies(dir, prep.copies)).toBeNull();
      ui = prep.ui;
    }
    for (let i = 0; i < 8 && !(getOrder(db, orderId)?.state === "started" && getOrder(db, orderId)?.submit === "sent"); i++) await tick();
    expect(getOrder(db, orderId)).toMatchObject({ state: "started", submit: "sent" });
    advance(db, orderId, "started", "result_pending", { work: { head: H2, summary: "改了首页", selfCheck: opts.selfCheck ?? "逐条对了", ...(ui ? { ui } : {}) } });
    return ui;
  };
  const row = () => getOrder(db, orderId)!;
  const deliver = () => (row().payload as { deliver?: Record<string, unknown> } | null)?.deliver;
  return { db, d, dir, clock, logs, renew, shotCalls, tick, start, row, deliver, orderId };
}

let mode: RecoveryMode = "on";
beforeEach(() => { mode = "on"; useUiUploadMode(() => mode); });
afterEach(() => { useUiUploadMode(null); closeLedger(":memory:"); });

const passStep = () => uiPassStep(observeSnapshot(adb, getTask(adb, "T9")!, { maxWorkers: 2, now: anow } as never), "pm_ui", 0);

describe("[验收线 2] 端到端摘要核对", () => {
  test("A 的 lendUiShots = on：B 逐张传、清单进交付，A 入账后卡上 extra.screenshots 指向导入文件、摘要相等，不再报缺截图", async () => {
    freshA("on");
    const orderId = await offered();
    let delivered: Record<string, any> | null = null;
    const h = harness({ orderId, shot: aShotPort, onResult: async (body) => { delivered = await aCall("write", { v: 1, ...body }); } });
    expect(await aCall("claim", { v: 1, orderId, worker: (await import("../src/lib/lend-drive.js")).workerName(orderId) })).toMatchObject({ ok: true });
    const ui = (await h.start({ pairs: 2 }))!;
    await h.tick();
    const e = h.deliver()!.uiEvidence as UiEvidence;
    expect(e).toBeDefined();
    const { digest, ...rest } = e;
    expect(digest).toBe(uiEvidenceDigest(rest));
    expect(rest).toMatchObject({ v: 1, taskId: "T9", head: H2, specRev: 1, round: 1, source: "imported", summary: "首页前后" });
    expect(aShots.map((s) => s.status)).toEqual([200, 200, 200, 200]);
    for (const [i, s] of ui.shots.entries()) {
      expect(aShots[i]!.body.sha256).toBe(sha(readFileSync(uiCopyPath(h.dir, s.sha256)))); // A 回的摘要 = B 的拷贝
      expect(e.shots[i]).toEqual({ view: s.view, size: s.size, phase: s.phase, ref: aShots[i]!.body.ref, sha256: s.sha256 });
    }
    expect(delivered).toMatchObject({ ok: true });
    const t = getTask(adb, "T9")!;
    expect(t.extra.screenshotsDigest).toBe(e.digest);
    expect(t.extra.screenshots).toEqual(e.shots.map((s) => join(root, "imported", "mate", orderId.replaceAll(":", "_"), s.ref)));
    expect(passStep()).not.toMatchObject({ code: "ui_missing_screenshots" });
  });

  test("先红的依据：开关 off（= main 不上传）同一流程交付不带清单，卡退 ui_missing_screenshots", async () => {
    mode = "off";
    freshA("on");
    const orderId = await offered();
    const h = harness({ orderId, shot: aShotPort, onResult: async (body) => { await aCall("write", { v: 1, ...body }); } });
    await aCall("claim", { v: 1, orderId, worker: (await import("../src/lib/lend-drive.js")).workerName(orderId) });
    await h.start();
    await h.tick();
    expect([h.deliver()!.uiEvidence, h.shotCalls.length]).toEqual([undefined, 0]);
    expect(passStep()).toMatchObject({ kind: "escalate", code: "ui_missing_screenshots" });
  });

  test("提交后拷贝改了一个字节 → local_changed，不带清单；A 回错的 sha256 → answer_mismatch，不带清单", async () => {
    const h = harness({ shot: async () => ({ status: 200, body: {} }) });
    const ui = (await h.start())!;
    const path = uiCopyPath(h.dir, ui.shots[0]!.sha256);
    const b = readFileSync(path);
    b[b.length - 13] ^= 1;
    writeFileSync(path, b);
    await h.tick();
    expect([h.deliver()?.uiEvidence, h.shotCalls.length, h.deliver()?.summary]).toEqual([undefined, 0, "改了首页"]);
    expect(h.logs.some((l) => l.includes("local_changed"))).toBe(true);

    const w = harness({ shot: async (_p, _o, body) => {
      const s = ui.shots.find((x) => x.phase === (body.meta as { phase: string }).phase)!;
      return { status: 200, body: { ok: true, v: 1, ref: "s01.png", sha256: "0".repeat(64), bytes: s.bytes, width: s.width, height: s.height } };
    } });
    await w.start();
    await w.tick();
    expect([w.deliver()?.uiEvidence, w.shotCalls.length]).toEqual([undefined, 1]);
    expect(w.logs.some((l) => l.includes("answer_mismatch"))).toBe(true);
    expect(w.logs.join("\n")).not.toContain(w.dir); // 日志只写 code，不写本机路径
  });
});

/** 假 A：按 ui 里的值回 200（ref 按次序编号），或按 script 依次回别的 */
function fakeA(ui: () => WorkUi | undefined, script: (n: number) => { status: number; body: unknown } | "ok" | "throw" = () => "ok") {
  let n = 0;
  return async (_p: string, _o: "shot", body: Record<string, unknown>) => {
    const step = script(n++);
    if (step === "throw") throw new Error("断网");
    if (step !== "ok") return step;
    const m = body.meta as { view: string; phase: string };
    const s = ui()!.shots.find((x) => x.view === m.view && x.phase === m.phase)!;
    const i = ui()!.shots.indexOf(s) + 1;
    return { status: 200, body: { ok: true, v: 1, ref: `s${String(i).padStart(2, "0")}.png`, sha256: s.sha256, bytes: s.bytes, width: s.width, height: s.height } };
  };
}

describe("[验收线 3] 传输分类与续传", () => {
  test("404 / 403 / 400 / 401 / 409 / 413（及 0 = shot 子进程本地拒、没发出去）→ 当轮不带清单交付", async () => {
    for (const status of [404, 403, 400, 401, 409, 413, 0]) {
      const h = harness({ shot: async () => ({ status, body: { ok: false, code: status === 403 ? "shots_off" : "x", error: "no" } }) });
      await h.start();
      await h.tick();
      expect({ status, ui: h.deliver()?.uiEvidence, summary: h.deliver()?.summary, calls: h.shotCalls.length }).toEqual({ status, ui: undefined, summary: "改了首页", calls: 1 });
    }
  });

  test("抛错 / 503 / 正文坏了 → 本轮不落正文；下一轮已成的槽位不重传；满 30 分钟不带清单交付", async () => {
    for (const bad of ["throw", { status: 503, body: { ok: false, code: "unavailable" } }, { status: 200, body: "不是对象" }] as const) {
      let ui: WorkUi | undefined;
      const h = harness({ shot: fakeA(() => ui, (n) => (n === 1 ? bad : "ok")) });
      ui = await h.start();
      await h.tick();
      expect([h.row().payload, h.shotCalls.length]).toEqual([null, 2]);
      await h.tick();
      expect(h.shotCalls.length).toBe(3); // 第一张已成：只重传第二张
      expect((h.deliver()!.uiEvidence as UiEvidence).shots).toHaveLength(2);
    }
    const h = harness({ shot: async () => ({ status: 503, body: { ok: false, code: "unavailable" } }) });
    await h.start();
    await h.tick();
    expect(h.row().payload).toBeNull();
    h.clock.t += PUBLISH_GIVE_UP_MS;
    await h.tick();
    expect([h.deliver()?.uiEvidence, h.deliver()?.summary]).toEqual([undefined, "改了首页"]);
  });

  test("超过 20 秒预算停止新上传，下一轮接着传", async () => {
    let ui: WorkUi | undefined;
    const slow = fakeA(() => ui);
    const h = harness({ shot: async (p, o, b) => { h.clock.t += 11_000; return slow(p, o, b); } });
    ui = await h.start({ pairs: 3 });
    await h.tick();
    expect([h.row().payload, h.shotCalls.length]).toEqual([null, 2]);
    await h.tick();
    expect([h.row().payload, h.shotCalls.length]).toEqual([null, 4]);
    await h.tick();
    expect(h.shotCalls.length).toBe(6);
    expect((h.deliver()!.uiEvidence as UiEvidence).shots).toHaveLength(6);
  });

  test("预算按 peer 按轮共用：同一 peer 同轮第二张单在 peer 已用满 20 秒后不再起新的上传（审查 upload-budget-per-order）", async () => {
    let ui: WorkUi | undefined;
    const slow = fakeA(() => ui);
    const h = harness();
    ui = await h.start();
    const calls: string[] = [];
    const shot: LendCall<"shot"> = async (p, o, b) => { calls.push((b.meta as { orderId: string }).orderId); h.clock.t += 11_000; return slow(p, o, b); };
    const one = h.row(), two = { ...one, orderId: "lend:T9:2" };
    const budget = uiShotBudget();
    const d = { db: h.db, now: () => h.clock.t, log: () => {}, shot, shotBudget: budget };
    const g = { check: async () => null };
    expect((await sendUiShots(one, d, g)).kind).toBe("ok"); // 0s、11s 各起一张
    expect((await sendUiShots(two, d, g)).kind).toBe("wait"); // 22s：本轮这个 peer 的预算用完，一张都不起
    expect(calls).toEqual([one.orderId, one.orderId]);
    expect(budget.take("other", h.clock.t)).toBe(true); // 别的 peer 各算各的
    const next = { ...d, shotBudget: uiShotBudget() }; // 下一轮：新的一份
    expect((await sendUiShots(two, next, g)).kind).toBe("ok");
    expect(calls).toHaveLength(4);
  });

  test("本轮对这个 peer 出站失败过 → 不再调 shot", async () => {
    let ui: WorkUi | undefined;
    const h = harness({ shot: fakeA(() => ui) });
    ui = await h.start();
    h.renew.fail = true;
    h.clock.t += 61_000; // 到点续租：续租那一下就失败
    await h.tick();
    expect([h.row().payload, h.shotCalls.length]).toEqual([null, 0]);
    h.renew.fail = false;
    h.clock.t += 61_000;
    await h.tick();
    expect(h.shotCalls.length).toBe(2);
  });

  test("守卫在两张之间拦下（换代）→ haltPublish，不落正文", async () => {
    let ui: WorkUi | undefined;
    const pass = fakeA(() => ui);
    const h = harness({ shot: async (p, o, b) => { patchOrder(h.db, h.orderId, ["result_pending"], { leaseGen: 2 }, h.clock.t); return pass(p, o, b); } });
    ui = await h.start();
    await h.tick();
    expect([h.row().payload, h.shotCalls.length]).toEqual([null, 1]);
    expect(h.logs.some((l) => l.includes("journal 变了"))).toBe(true);
  });

  test("amend 重走（正文被清空）→ 不重传，清单逐字相同", async () => {
    let ui: WorkUi | undefined;
    const h = harness({ shot: fakeA(() => ui) });
    ui = await h.start();
    await h.tick();
    const first = JSON.stringify(h.deliver()!.uiEvidence);
    expect(h.shotCalls.length).toBe(2);
    patchOrder(h.db, h.orderId, ["result_pending"], { payload: null, payloadSha: null, work: { ...h.row().work!, summary: "补写过的摘要" } }, h.clock.t);
    await h.tick();
    expect([h.shotCalls.length, JSON.stringify(h.deliver()!.uiEvidence), h.deliver()!.summary]).toEqual([2, first, "补写过的摘要"]);
  });
});

describe("[验收线 5] 开关", () => {
  test("observe → shot 一次都不调，uiShotsObserved 有且只有一条，交付正文和 off 时逐字相同；on → 上传", async () => {
    const payloads: Record<RecoveryMode, string> = { on: "", observe: "", off: "" };
    for (const m of ["off", "observe", "on"] as const) {
      mode = m;
      let ui: WorkUi | undefined;
      const h = harness({ shot: fakeA(() => ui) });
      ui = await h.start();
      await h.tick();
      h.clock.t += 61_000;
      await h.tick();
      payloads[m] = JSON.stringify(h.row().payload);
      const observed = (h.db.query("SELECT key FROM lend_meta WHERE key LIKE 'uiShotsObserved:%'").all() as { key: string }[]).map((r) => r.key);
      if (m === "observe") {
        expect(observed).toEqual([uiObservedKey(h.orderId)]);
        expect(JSON.parse(getMeta(h.db, uiObservedKey(h.orderId))!)).toMatchObject({ head: H2, shots: 2, bytes: ui!.shots[0]!.bytes + ui!.shots[1]!.bytes });
      } else expect(observed).toEqual([]);
      expect(h.shotCalls.length).toBe(m === "on" ? 2 : 0);
    }
    expect(payloads.observe).toBe(payloads.off);
    expect(payloads.on).not.toBe(payloads.off);
  });

  test("没有 shot 端口（老接线 / 测试假依赖）= off", async () => {
    const h = harness();
    await h.start();
    await h.tick();
    expect(h.deliver()?.uiEvidence).toBeUndefined();
  });
});

describe("[验收线 6] 兼容", () => {
  test("work 里没有 ui：三种开关下交付正文都和没有 shot 端口（main 的接线）逐字相同", async () => {
    const base = harness();
    await base.start({ ui: false });
    await base.tick();
    const want = JSON.stringify(base.row().payload);
    for (const m of ["off", "observe", "on"] as const) {
      mode = m;
      const h = harness({ shot: async () => { throw new Error("不该调"); } });
      await h.start({ ui: false });
      await h.tick();
      expect({ m, payload: JSON.stringify(h.row().payload) }).toEqual({ m, payload: want });
      expect(h.shotCalls.length).toBe(0);
    }
  });

  test("清单不合法（A 给两张图回了同一个 ref）→ manifest_invalid，丢掉清单照常交付", async () => {
    let ui: WorkUi | undefined;
    const same = fakeA(() => ui);
    const h = harness({ shot: async (p, o, b) => {
      const r = await same(p, o, b);
      return { ...r, body: { ...(r.body as Record<string, unknown>), ref: "s01.png" } };
    } });
    ui = await h.start();
    await h.tick();
    expect([h.deliver()?.uiEvidence, h.deliver()?.summary]).toEqual([undefined, "改了首页"]);
    expect(h.logs.some((l) => l.includes("manifest_invalid"))).toBe(true);
  });

  test("带上清单正文超过 96 KiB → manifest_too_large，丢掉清单照常交付", async () => {
    const probe = harness();
    await probe.start({ ui: false, selfCheck: "x" });
    await probe.tick();
    const size = Buffer.byteLength(JSON.stringify(probe.row().payload));
    let ui: WorkUi | undefined;
    const h = harness({ shot: fakeA(() => ui) });
    ui = await h.start({ selfCheck: "x".repeat(96 * 1024 - size - 50) });
    await h.tick();
    expect(h.deliver()?.uiEvidence).toBeUndefined();
    expect(Buffer.byteLength(JSON.stringify(h.row().payload))).toBeLessThanOrEqual(96 * 1024);
    expect(h.logs.some((l) => l.includes("manifest_too_large"))).toBe(true);
  });
});
