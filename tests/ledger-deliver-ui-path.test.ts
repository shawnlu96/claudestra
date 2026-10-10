/**
 * UISPATH1：ui 交付截图证据的工件路径锚点。imported / peer / order（本机：卡目录）及 ref 自带子目录都必须是工件根下的真目录，
 * realpath 恰为「上一层 realpath / 名字」；被软链改写的中间层不能拿它自己的 realpath 当可信根。经真实 ledger CLI（peer lend-write、
 * 本机 deliver）进 ledger-write 事务，on 拒收时按 sqlite_master 列出的每张表逐表比对零写。临时工件根 / 策略文件，不碰真实凭据。
 */
import type { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { chmodSync, cpSync, mkdirSync, mkdtempSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { instanceKeySync, signPurpose } from "../src/lib/instance-key.js";
import type { BorrowEntry } from "../src/lib/lend-config.js";
import type { UiDeliverPort } from "../src/lib/ledger-deliver-ui.js";
import { UI_ARTIFACT_ROOT, uiDeliverPort } from "../src/lib/ledger-deliver-ui-port.js";
import { listLendOrders } from "../src/lib/ledger-lend.js";
import { RECEIPT_PURPOSE } from "../src/lib/ledger-lend-result.js";
import { closeLedger, getTask, listEvents, openLedger } from "../src/lib/ledger-store.js";
import { createTask, setMeta } from "../src/lib/ledger-write.js";
import type { RemoteHead } from "../src/lib/order-deliver.js";
import { uiEvidenceDigest, type UiEvidence } from "../src/lib/order-deliver-ui.js";
import { RECOVERY_POLICY_PATH } from "../src/lib/recovery-policy.js";
import type { Registry } from "../src/manager/core.js";
import { runLedger } from "../src/manager/ledger.js";

const P = "claude-orchestrator";
const H2 = "c".repeat(40);
const REPO = "shawnlu96/claudestra";
const FP = "abcd-ef01-2345-6789";
const BR = "lend/T9-abcd";
const WORKER = "agent-lend-0123456789";
let db: Database;
let now: number;
let remote: Record<string, RemoteHead>;
let root: string;
let policyPath: string;
let rootReads: number;
const dir = mkdtempSync(join(tmpdir(), "uispath-test-"));
const key = instanceKeySync(dir);
const borrow: BorrowEntry[] = [{ peer: "mate", projects: [P], roles: ["review", "write"], maxOpen: 2 }];

/** 真实端口，只把 roots 的读取计数：off 下应一次都不碰工件根 */
function countedPort(p: { peer: string; worker: string; orderId: string }): UiDeliverPort {
  const port = uiDeliverPort({ peer: p, root, policyPath, now });
  return Object.defineProperty({ ...port }, "roots", { get: () => (rootReads++, port.roots) });
}
const deps = (actor: string) => ({
  db, actor, projectIds: [P], loadRegistry: async () => ({ socket: "", agents: {} }), saveRegistry: async () => {}, now: () => now,
  lend: {
    borrow: async () => borrow, notifyPm: async () => {},
    result: {
      reportDir: () => dir, writeReport: (p: string, b: string) => writeFileSync(p, b), sign: (f: string[]) => signPurpose(RECEIPT_PURPOSE, f, key),
      remoteHead: async (_repo: string, branch: string): Promise<RemoteHead> => remote[branch] ?? { ok: false, error: "没有这个分支" },
      peerFp: async (peer: string) => (peer === "mate" ? FP : null),
      uiPort: countedPort,
    },
  },
});
const run = (args: string[], actor = "agent-pm") => runLedger(args, deps(actor)) as Promise<Record<string, any>>;
const call = (ep: string, b: unknown) => run([`lend-${ep}`, "--", "mate", JSON.stringify(b)], "owner");
const body = (orderId: string, ui?: unknown) => ({
  v: 1, orderId, gen: 1, branch: BR, pr: 7, session: { id: "sess-1", family: "codex" },
  deliver: { v: 1, orderId, head: H2, evidence: BR, summary: "改了首页", selfCheck: "逐条对了", ...(ui === undefined ? {} : { uiEvidence: ui }) },
});
const png = (s: string) => Buffer.from(`\x89PNG\r\n\x1a\n${s}`);
const sha = (b: Buffer) => createHash("sha256").update(b).digest("hex");

/** sqlite_master 里的每一张表全量内容：逐表零业务写 */
const snapshot = () => JSON.stringify((db.query("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all() as { name: string }[])
  .map(({ name }) => [name, db.query(`SELECT * FROM "${name.replaceAll('"', '""')}"`).all()]));

/** <root>/imported/mate/<order>/ 下一组合法导入（含 ref 子目录 shots/），返回清单 */
function imported(orderId: string): UiEvidence {
  const base = join(root, "imported", "mate", orderId.replaceAll(":", "_"));
  mkdirSync(join(base, "shots"), { recursive: true });
  const files: Record<string, { sha256: string }> = {};
  const shots = (["before", "after"] as const).map((phase) => {
    const b = png(`${orderId}-${phase}`), ref = `shots/home-${phase}.png`;
    writeFileSync(join(base, ref), b);
    files[ref] = { sha256: sha(b) };
    return { view: "home", size: "390x844", phase, ref, sha256: sha(b) };
  });
  writeFileSync(join(base, "provenance.json"), JSON.stringify({ v: 1, peer: "mate", worker: WORKER, orderId, head: H2, files }));
  const e = { v: 1 as const, taskId: "T9", head: H2, specRev: 1, round: 1, source: "imported" as const, summary: "手机首页前后", shots };
  return { ...e, digest: uiEvidenceDigest(e) };
}

/** 把 path 挪到 to，原位置换成指向它的软链（内容与合法导入逐字节相同：只有路径锚点不对） */
const relink = (path: string, to: string) => { renameSync(path, to); symlinkSync(to, path); };

async function claimed(): Promise<string> {
  const { orderId } = await run(["lend-offer", "T9", "--peer", "mate", "--repo", REPO]);
  await call("claim", { v: 1, orderId, worker: WORKER });
  remote[BR] = { ok: true, head: H2 };
  return orderId;
}

/** 合法导入之后再篡改目录：每种都只动路径、不动字节 / 来源 */
const ATTACKS: [string, (order: string, outside: string) => void][] = [
  ["imported 层软链到同前缀邻居 imported-x", () => relink(join(root, "imported"), join(root, "imported-x"))],
  ["imported 层软链到根外", (_o, out) => relink(join(root, "imported"), join(out, "imported"))],
  ["peer 层软链到根外", (_o, out) => relink(join(root, "imported", "mate"), join(out, "mate"))],
  ["peer 层软链到根内别的 peer", () => relink(join(root, "imported", "mate"), join(root, "imported", "other"))],
  ["order 层软链到同前缀邻居", (o) => relink(join(root, "imported", "mate", o), join(root, "imported", "mate", `${o}-x`))],
  ["ref 子目录软链到 order 内别处", (o) => relink(join(root, "imported", "mate", o, "shots"), join(root, "imported", "mate", o, "real"))],
  ["叶文件软链（同内容）", (o, out) => relink(join(root, "imported", "mate", o, "shots", "home-before.png"), join(out, "home-before.png"))],
  ["provenance.json 软链", (o, out) => relink(join(root, "imported", "mate", o, "provenance.json"), join(out, "provenance.json"))],
  ["peer 层换成普通文件", () => { rmSync(join(root, "imported", "mate"), { recursive: true }); writeFileSync(join(root, "imported", "mate"), "x"); }],
  ["peer 层读不了（0 权限）", () => chmodSync(join(root, "imported", "mate"), 0)],
  ["imported 层换成同内容的根外副本软链", (_o, out) => {
    cpSync(join(root, "imported"), join(out, "copy"), { recursive: true });
    rmSync(join(root, "imported"), { recursive: true });
    symlinkSync(join(out, "copy"), join(root, "imported"));
  }],
];

beforeEach(() => {
  db = openLedger(":memory:");
  now = 1_000_000;
  rootReads = 0;
  remote = { main: { ok: true, head: "b".repeat(40) } };
  root = mkdtempSync(join(tmpdir(), "uispath-artifacts-"));
  policyPath = join(mkdtempSync(join(tmpdir(), "uispath-policy-")), "recovery-policy.json");
  setMeta(db, { actor: "owner", now }, { project: P, key: "pms", value: ["agent-pm"] });
  const spec = join(dir, "T9.md");
  writeFileSync(spec, "规格：只改 src/lib/x.ts\n验收：单测全绿");
  createTask(db, { actor: "owner", now }, { project: P, id: "T9", title: "T9", kind: "code", spec, agent: "agent-dev" } as never);
  db.run("UPDATE tasks SET stage = 'build', round = 0 WHERE id = 'T9'");
  db.run(`INSERT INTO task_workflows (taskId, project, template, templateVersion, mode, authorFamily, fallback, specRev, createdAt, updatedAt)
    VALUES ('T9', ?, 'ui', 3, 'manual', 'codex', '', 1, 1, 1)`, [P]);
});
afterEach(() => {
  closeLedger(":memory:");
  try { chmodSync(join(root, "imported", "mate"), 0o700); } catch { /* 这一例没改权限 */ }
  rmSync(root, { recursive: true, force: true });
});
const policy = (mode: string) => writeFileSync(policyPath, JSON.stringify({ projects: { [P]: { keys: { uiDelivery: mode } } } }));

describe("peer 写单交付：已导入工件的中间路径锚点", () => {
  test("合法导入（含 ref 子目录）照常入账，截图指向根下原路径；同一份重放 = 原回执", async () => {
    policy("on");
    const orderId = await claimed();
    const e = imported(orderId);
    expect(await call("write", body(orderId, e))).toMatchObject({ ok: true });
    const t = getTask(db, "T9")!;
    expect(t.extra.screenshotsDigest).toBe(e.digest);
    expect(t.extra.screenshots).toEqual(e.shots.map((s) => join(root, "imported", "mate", orderId.replaceAll(":", "_"), s.ref)));
    expect(await call("write", body(orderId, e))).toMatchObject({ ok: true });
    expect(listEvents(db, { target: "T9" }).filter((x) => x.kind === "deliver")).toHaveLength(1);
  });

  for (const [why, attack] of ATTACKS) {
    test(`on：${why} → 写入前拒，sqlite_master 逐表零写，租约单仍 claimed；修好后同一单照常入账`, async () => {
      policy("on");
      const orderId = await claimed(), order = orderId.replaceAll(":", "_");
      const e = imported(orderId);
      const outside = mkdtempSync(join(tmpdir(), "uispath-outside-"));
      attack(order, outside);
      const before = snapshot();
      const r = await call("write", body(orderId, e));
      expect({ why, ok: r.ok }).toEqual({ why, ok: false });
      expect(String(r.error)).toMatch(/path_untrusted|artifact_missing/);
      expect(snapshot()).toBe(before);
      expect(listLendOrders(db, "T9")[0]).toMatchObject({ status: "claimed" });
      // 修复：撤掉篡改、在根下重新放一份真导入（不靠自动创建 / 清扫）
      try { chmodSync(join(root, "imported", "mate"), 0o700); } catch { /* 这一例没改权限 */ }
      rmSync(join(root, "imported"), { recursive: true, force: true });
      expect(await call("write", body(orderId, imported(orderId)))).toMatchObject({ ok: true });
      rmSync(outside, { recursive: true, force: true });
    });
  }

  test("observe：中间层软链 → 照原路径入账，只记一条 path_untrusted 诊断，不登记截图（不伪批准）", async () => {
    policy("observe");
    const orderId = await claimed();
    const e = imported(orderId);
    relink(join(root, "imported"), join(root, "imported-x"));
    expect(await call("write", body(orderId, e))).toMatchObject({ ok: true });
    const t = getTask(db, "T9")!;
    expect(t.extra.screenshots).toBeUndefined();
    expect(t.extra.screenshotsDigest).toBeUndefined();
    const notes = listEvents(db, { project: P, target: "T9" }).filter((x) => x.data.op === "recovery_observe" && x.data.mechanism === "uiDelivery");
    expect(notes).toHaveLength(1);
    expect(JSON.stringify(notes[0].data)).toContain("path_untrusted");
  });

  test("off：原路径，零附加读（端口的工件根一次都没取），不登记截图", async () => {
    policy("off");
    const orderId = await claimed();
    const e = imported(orderId);
    relink(join(root, "imported"), join(root, "imported-x"));
    expect(await call("write", body(orderId, e))).toMatchObject({ ok: true });
    expect(rootReads).toBe(0);
    expect(getTask(db, "T9")!.extra.screenshots).toBeUndefined();
  });

  test("撤单保护保留：收回后合法导入的交付仍拒", async () => {
    policy("on");
    const orderId = await claimed();
    const e = imported(orderId);
    expect(await run(["lend-reclaim", "T9", "--reason", "收回"])).toMatchObject({ ok: true });
    expect(await call("write", body(orderId, e))).toMatchObject({ ok: false, current: { lend: "cancelled" } });
    expect(getTask(db, "T9")!.extra.screenshots).toBeUndefined();
  });
});

describe("本机 deliver CLI：卡目录与 ref 子目录锚点", () => {
  const PROJ = "uispath", LEAD = "agent-lead", DEV = "agent-task-ui", TASK = "U1";
  const ledger = (actor: string, ...args: string[]) => {
    const reg = { socket: "", agents: { [LEAD]: { status: "active", projectId: PROJ }, [DEV]: { status: "active", projectId: PROJ } } } as unknown as Registry;
    return runLedger(args, { db, actor, actorProject: PROJ, projectIds: [PROJ], loadRegistry: async () => structuredClone(reg), saveRegistry: async () => {}, now: () => Date.now() }) as Promise<
      Record<string, any>
    >;
  };
  const localPolicy = (mode: string) => {
    mkdirSync(join(RECOVERY_POLICY_PATH, ".."), { recursive: true });
    writeFileSync(RECOVERY_POLICY_PATH, JSON.stringify({ projects: { [PROJ]: { keys: { uiDelivery: mode } } } }));
  };
  function local(task = TASK): UiEvidence {
    const d = join(UI_ARTIFACT_ROOT, task, "shots");
    mkdirSync(d, { recursive: true });
    const shots = (["before", "after"] as const).map((phase) => {
      const b = png(`${task}-${phase}`), ref = `shots/home-${phase}.png`;
      writeFileSync(join(UI_ARTIFACT_ROOT, task, ref), b);
      return { view: "home", size: "1280x800", phase, ref, sha256: sha(b) };
    });
    const e = { v: 1 as const, taskId: TASK, head: H2, specRev: 1, round: 1, source: "local" as const, summary: "首页前后", shots };
    return { ...e, digest: uiEvidenceDigest(e) };
  }
  const deliverCli = (e: UiEvidence) => ledger(DEV, "deliver", TASK, "--from", "build", "--head", H2, "--ui-evidence", JSON.stringify(e));

  beforeEach(async () => {
    rmSync(UI_ARTIFACT_ROOT, { recursive: true, force: true });
    setMeta(db, { actor: "owner", now: 1 }, { project: PROJ, key: "pms", value: [LEAD] });
    await ledger(LEAD, "item-new", "i9", "--title", "底座");
    expect(await ledger(LEAD, "task-new", TASK, "--title", "界面", "--kind", "code", "--item", "i9", "--agent", "task-ui", "--branch", "feat/u1")).toMatchObject({ ok: true });
    db.run(`INSERT INTO task_workflows (taskId, project, template, templateVersion, mode, authorFamily, fallback, specRev, createdAt, updatedAt)
      VALUES (?, ?, 'ui', 3, 'manual', 'claude', '', 1, 1, 1)`, [TASK, PROJ]);
    await ledger(DEV, "stage", TASK, "--from", "spec", "--to", "restate");
    await ledger(LEAD, "stage", TASK, "--from", "restate", "--to", "build");
  });
  afterEach(() => { rmSync(RECOVERY_POLICY_PATH, { force: true }); rmSync(UI_ARTIFACT_ROOT, { recursive: true, force: true }); });

  const LOCAL: [string, () => void][] = [
    ["卡目录软链到同前缀邻居 U1-x", () => relink(join(UI_ARTIFACT_ROOT, TASK), join(UI_ARTIFACT_ROOT, `${TASK}-x`))],
    ["ref 子目录软链到卡目录内别处", () => relink(join(UI_ARTIFACT_ROOT, TASK, "shots"), join(UI_ARTIFACT_ROOT, TASK, "real"))],
    ["ref 子目录软链到跨卡目录", () => { mkdirSync(join(UI_ARTIFACT_ROOT, "U2")); relink(join(UI_ARTIFACT_ROOT, TASK, "shots"), join(UI_ARTIFACT_ROOT, "U2", "shots")); }],
  ];
  for (const [why, attack] of LOCAL) {
    test(`on：${why} → 写入前拒、逐表零写；合法放回后照常入账`, async () => {
      localPolicy("on");
      const e = local();
      attack();
      const before = snapshot();
      const r = await deliverCli(e);
      expect({ why, ok: r.ok }).toEqual({ why, ok: false });
      expect(String(r.error)).toContain("path_untrusted");
      expect(snapshot()).toBe(before);
      rmSync(UI_ARTIFACT_ROOT, { recursive: true, force: true });
      expect(await deliverCli(local())).toMatchObject({ ok: true });
      expect(getTask(db, TASK)).toMatchObject({ stage: "review", headSHA: H2 });
      expect(getTask(db, TASK)!.extra.screenshotsDigest).toBe(e.digest);
    });
  }
});
