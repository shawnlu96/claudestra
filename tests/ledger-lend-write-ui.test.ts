/**
 * UISDEL1 peer 入口：`ledger lend-write` 写单交付（writeLendDeliver）带 uiEvidence 时，只认这一单 peer / worker / 单号 / head
 * 已导入本机的工件（provenance.json + 实际字节 sha256）；对方的路径不在本机读。临时 fake peer、临时工件根与策略文件，不碰真实凭据。
 */
import type { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { instanceKeySync, signPurpose } from "../src/lib/instance-key.js";
import type { BorrowEntry } from "../src/lib/lend-config.js";
import { uiDeliverPort } from "../src/lib/ledger-deliver-ui-port.js";
import { listLendOrders } from "../src/lib/ledger-lend.js";
import { RECEIPT_PURPOSE } from "../src/lib/ledger-lend-result.js";
import { listSteps } from "../src/lib/ledger-steps.js";
import { closeLedger, getTask, listEvents, openLedger } from "../src/lib/ledger-store.js";
import { createTask, setMeta } from "../src/lib/ledger-write.js";
import type { RemoteHead } from "../src/lib/order-deliver.js";
import { uiEvidenceDigest, type UiEvidence } from "../src/lib/order-deliver-ui.js";
import { uiMergeRefusal } from "../src/lib/scheduler-ui-gate.js";
import { runLedger } from "../src/manager/ledger.js";

const P = "claude-orchestrator";
const H2 = "c".repeat(40);
const OLD = "e".repeat(40);
const REPO = "shawnlu96/claudestra";
const FP = "abcd-ef01-2345-6789";
const BR = "lend/T9-abcd";
const WORKER = "agent-lend-0123456789";
let db: Database;
let now: number;
let remote: Record<string, RemoteHead>;
let root: string;
let policyPath: string;
const dir = mkdtempSync(join(tmpdir(), "lend-write-ui-test-"));
const key = instanceKeySync(dir);
const borrow: BorrowEntry[] = [{ peer: "mate", projects: [P], roles: ["review", "write"], maxOpen: 2 }];

const deps = (actor: string) => ({
  db, actor, projectIds: [P], loadRegistry: async () => ({ socket: "", agents: {} }), saveRegistry: async () => {}, now: () => now,
  lend: {
    borrow: async () => borrow, notifyPm: async () => {},
    result: {
      reportDir: () => dir, writeReport: (p: string, b: string) => writeFileSync(p, b), sign: (f: string[]) => signPurpose(RECEIPT_PURPOSE, f, key),
      remoteHead: async (_repo: string, branch: string): Promise<RemoteHead> => remote[branch] ?? { ok: false, error: "没有这个分支" },
      peerFp: async (peer: string) => (peer === "mate" ? FP : null),
      uiPort: (p: { peer: string; worker: string; orderId: string }) => uiDeliverPort({ peer: p, root, policyPath, now }),
    },
  },
});
const run = (args: string[], actor = "agent-pm") => runLedger(args, deps(actor)) as Promise<Record<string, any>>;
const call = (ep: string, body: unknown) => run([`lend-${ep}`, "--", "mate", JSON.stringify(body)], "owner");
const body = (orderId: string, ui?: unknown) => ({
  v: 1, orderId, gen: 1, branch: BR, pr: 7, session: { id: "sess-1", family: "codex" },
  deliver: { v: 1, orderId, head: H2, evidence: BR, summary: "改了首页", selfCheck: "逐条对了", ...(ui === undefined ? {} : { uiEvidence: ui }) },
});
const policy = (mode: string) => writeFileSync(policyPath, JSON.stringify({ projects: { [P]: { keys: { uiDelivery: mode } } } }));
const png = (s: string) => Buffer.from(`\x89PNG\r\n\x1a\n${s}`);
const sha = (b: Buffer) => createHash("sha256").update(b).digest("hex");
const snapshot = () => JSON.stringify({ tasks: db.query("SELECT * FROM tasks").all(), events: db.query("SELECT seq FROM events").all(),
  steps: listSteps(db, "T9"), orders: db.query("SELECT orderId, status, resultSha FROM lend_orders").all() });

/** 已导入本机的一组工件：<root>/imported/<peer>/<order>/ 下的文件与 provenance.json；prov 可改来源事实 */
function imported(orderId: string, prov: Record<string, unknown> | null = {}, over: Partial<UiEvidence> = {}): UiEvidence {
  const base = join(root, "imported", "mate", orderId.replaceAll(":", "_"));
  mkdirSync(base, { recursive: true });
  const files: Record<string, { sha256: string }> = {};
  const shots = (["before", "after"] as const).map((phase) => {
    const b = png(`${orderId}-${phase}`), ref = `home-${phase}.png`;
    writeFileSync(join(base, ref), b);
    files[ref] = { sha256: sha(b) };
    return { view: "home", size: "390x844", phase, ref, sha256: sha(b) };
  });
  if (!prov) rmSync(join(base, "provenance.json"), { force: true });
  else writeFileSync(join(base, "provenance.json"), JSON.stringify({ v: 1, peer: "mate", worker: WORKER, orderId, head: H2, files, ...prov }));
  const e = { v: 1 as const, taskId: "T9", head: H2, specRev: 1, round: 1, source: "imported" as const, summary: "手机首页前后", shots, ...over };
  return { ...e, digest: uiEvidenceDigest(e) };
}

async function claimed(): Promise<string> {
  const { orderId } = await run(["lend-offer", "T9", "--peer", "mate", "--repo", REPO]);
  await call("claim", { v: 1, orderId, worker: WORKER });
  remote[BR] = { ok: true, head: H2 };
  return orderId;
}

function newCard(template: "ui" | "code") {
  const spec = join(dir, "T9.md");
  writeFileSync(spec, "规格：只改 src/lib/x.ts\n验收：单测全绿");
  createTask(db, { actor: "owner", now }, { project: P, id: "T9", title: "T9", kind: "code", spec, agent: "agent-dev" } as never);
  db.run("UPDATE tasks SET stage = 'build', round = 0 WHERE id = 'T9'");
  db.run(`INSERT INTO task_workflows (taskId, project, template, templateVersion, mode, authorFamily, fallback, specRev, createdAt, updatedAt)
    VALUES ('T9', ?, ?, 3, 'manual', 'codex', '', 1, 1, 1)`, [P, template]);
}

beforeEach(() => {
  db = openLedger(":memory:");
  now = 1_000_000;
  remote = { main: { ok: true, head: "b".repeat(40) } };
  root = mkdtempSync(join(tmpdir(), "ui-artifacts-"));
  policyPath = join(mkdtempSync(join(tmpdir(), "ui-policy-")), "recovery-policy.json");
  setMeta(db, { actor: "owner", now }, { project: P, key: "pms", value: ["agent-pm"] });
  newCard("ui");
});
afterEach(() => closeLedger(":memory:"));

describe("peer 写单交付的截图证据（on）", () => {
  test("有效导入来源 → 入账：extra 截图指向本机导入文件，事件带清单与来源，没有任何批准", async () => {
    policy("on");
    const orderId = await claimed();
    const e = imported(orderId);
    expect(await call("write", body(orderId, e))).toMatchObject({ ok: true });
    const t = getTask(db, "T9")!;
    expect(t).toMatchObject({ stage: "review", headSHA: H2, round: 1 });
    expect(t.extra.screenshotsDigest).toBe(e.digest);
    expect(t.extra.screenshots).toEqual(e.shots.map((s) => join(root, "imported", "mate", orderId.replaceAll(":", "_"), s.ref)));
    const d = listEvents(db, { target: "T9" }).find((x) => x.kind === "deliver")!;
    expect(d.data.uiEvidence).toMatchObject({ digest: e.digest, source: "imported", peer: { peer: "mate", worker: WORKER, orderId } });
    expect(uiMergeRefusal(db, t, now)).not.toBeNull(); // PM 截图验收仍要人做
    expect(await call("write", body(orderId, e))).toMatchObject({ ok: true }); // 同一份正文重放 = 原回执
    expect(listEvents(db, { target: "T9" }).filter((x) => x.kind === "deliver")).toHaveLength(1);
  });

  test("无来源 / 来源对不上 / 本机路径冒充 / 缺清单 / 旧 head → 拒，逐表零写，租约单仍是 claimed", async () => {
    policy("on");
    const orderId = await claimed();
    const before = snapshot();
    const cases: [string, () => unknown][] = [
      ["无 provenance", () => imported(orderId, null)],
      ["别的 worker", () => imported(orderId, { worker: "agent-lend-other" })], ["别的单", () => imported(orderId, { orderId: `${orderId}x` })],
      ["别的 head", () => imported(orderId, { head: OLD })], ["导入记录 hash 不同", () => imported(orderId, { files: {} })],
      ["对方路径当本机", () => imported(orderId, {}, { source: "local" })], ["清单旧 head", () => imported(orderId, {}, { head: OLD })],
      ["缺清单", () => undefined],
    ];
    for (const [why, ui] of cases) {
      const r = await call("write", body(orderId, ui()));
      expect({ why, ok: r.ok }).toEqual({ why, ok: false });
      expect(snapshot()).toBe(before);
    }
    expect(listLendOrders(db, "T9")[0]).toMatchObject({ status: "claimed" });
    expect(await call("write", body(orderId, imported(orderId)))).toMatchObject({ ok: true }); // 补齐来源后同一单照常入账
  });

  test("原租约 / 撤单核对不变：PM 收回后带有效证据的交付仍拒收", async () => {
    policy("on");
    const orderId = await claimed();
    const e = imported(orderId);
    expect(await run(["lend-reclaim", "T9", "--reason", "收回"])).toMatchObject({ ok: true });
    expect(await call("write", body(orderId, e))).toMatchObject({ ok: false, current: { lend: "cancelled" } });
    expect(getTask(db, "T9")!.extra.screenshots).toBeUndefined();
  });

  test("非 ui 卡旧 payload 在 on 下照常入账；off 下 ui 卡不读证据", async () => {
    db.run("UPDATE task_workflows SET template = 'code' WHERE taskId = 'T9'");
    policy("on");
    const orderId = await claimed();
    expect(await call("write", body(orderId))).toMatchObject({ ok: true });
    expect(getTask(db, "T9")!.extra.screenshots).toBeUndefined();
  });

  test("off：ui 卡不带清单照旧入账，不写截图", async () => {
    policy("off");
    const orderId = await claimed();
    expect(await call("write", body(orderId))).toMatchObject({ ok: true });
    expect(getTask(db, "T9")!.extra.screenshots).toBeUndefined();
  });
});
