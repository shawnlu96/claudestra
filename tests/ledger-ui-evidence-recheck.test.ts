/**
 * UIHASH1：PM ui-approve 写入前，对正式交付登记过的截图按登记清单重核可信路径 / 实际字节 hash / 当前 head、规格版本、轮次。
 * 真实 ledger CLI（本机 deliver → ui-approve；peer lend-write → ui-approve），拒时按 sqlite_master 每张表逐表比对零写。
 * 没有正式登记的旧卡（人工截图摘要）照原门走。临时工件根 / 策略文件，不读真实工件或凭据。
 */
import type { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import { mkdirSync, mkdtempSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { instanceKeySync, signPurpose } from "../src/lib/instance-key.js";
import type { BorrowEntry } from "../src/lib/lend-config.js";
import { UI_ARTIFACT_ROOT, uiDeliverPort } from "../src/lib/ledger-deliver-ui-port.js";
import { RECEIPT_PURPOSE } from "../src/lib/ledger-lend-result.js";
import { closeLedger, getTask, listEvents, openLedger } from "../src/lib/ledger-store.js";
import { recheckUiEvidence } from "../src/lib/ledger-ui-evidence-recheck.js";
import { createTask, setMeta } from "../src/lib/ledger-write.js";
import type { RemoteHead } from "../src/lib/order-deliver.js";
import { uiEvidenceDigest, type UiEvidence } from "../src/lib/order-deliver-ui.js";
import { RECOVERY_POLICY_PATH } from "../src/lib/recovery-policy.js";
import type { Registry } from "../src/manager/core.js";
import { runLedger } from "../src/manager/ledger.js";

const H2 = "c".repeat(40), H3 = "d".repeat(40);
let db: Database;
const png = (s: string) => Buffer.from(`\x89PNG\r\n\x1a\n${s}`);
const sha = (b: Buffer) => createHash("sha256").update(b).digest("hex");
/** sqlite_master 里的每一张表全量内容：逐表零写 */
const snapshot = () => JSON.stringify((db.query("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all() as { name: string }[])
  .map(({ name }) => [name, db.query(`SELECT * FROM "${name.replaceAll('"', '""')}"`).all()]));
const approvals = (task: string) => listEvents(db, { target: task }).filter((e) => e.kind === "decision" && e.data.op === "ui_approved");

describe("本机 deliver → ui-approve：批准前重核已登记截图", () => {
  const PROJ = "uihash", LEAD = "agent-lead", DEV = "agent-task-ui", TASK = "U1";
  const card = () => getTask(db, TASK)!;
  const ledger = (actor: string, ...args: string[]) => {
    const reg = { socket: "", agents: { [LEAD]: { status: "active", projectId: PROJ }, [DEV]: { status: "active", projectId: PROJ } } } as unknown as Registry;
    return runLedger(args, { db, actor, actorProject: PROJ, projectIds: [PROJ], loadRegistry: async () => structuredClone(reg), saveRegistry: async () => {}, now: () => Date.now() }) as Promise<
      Record<string, any>
    >;
  };
  const policy = (mode: string) => {
    mkdirSync(join(RECOVERY_POLICY_PATH, ".."), { recursive: true });
    writeFileSync(RECOVERY_POLICY_PATH, JSON.stringify({ projects: { [PROJ]: { keys: { uiDelivery: mode } } } }));
  };
  const shot = (phase: string) => join(UI_ARTIFACT_ROOT, TASK, "shots", `home-${phase}.png`);
  function local(): UiEvidence {
    mkdirSync(join(UI_ARTIFACT_ROOT, TASK, "shots"), { recursive: true });
    const shots = (["before", "after"] as const).map((phase) => {
      const b = png(`${TASK}-${phase}`);
      writeFileSync(shot(phase), b);
      return { view: "home", size: "1280x800", phase, ref: `shots/home-${phase}.png`, sha256: sha(b) };
    });
    const e = { v: 1 as const, taskId: TASK, head: H2, specRev: 1, round: 1, source: "local" as const, summary: "首页前后", shots };
    return { ...e, digest: uiEvidenceDigest(e) };
  }
  /** on 策略下正式交付登记截图，卡进 review */
  async function delivered(): Promise<UiEvidence> {
    policy("on");
    const e = local();
    expect(await ledger(DEV, "deliver", TASK, "--from", "build", "--head", H2, "--ui-evidence", JSON.stringify(e))).toMatchObject({ ok: true });
    expect(card()).toMatchObject({ stage: "review", headSHA: H2, round: 1 });
    expect(card().extra.screenshotsDigest).toBe(e.digest);
    return e;
  }
  const approve = (head = H2, digest = card().extra.screenshotsDigest as string) => ledger(LEAD, "ui-approve", TASK, "--head", head, "--digest", digest);
  const taskSet = (...a: string[]) => ledger(LEAD, "task-set", TASK, "--rev", String(card().rev), ...a);
  /** 拒：错误码带上 code，sqlite_master 逐表零写，没有批准事件 */
  async function refused(code: RegExp) {
    const before = snapshot();
    const r = await approve(card().headSHA ?? H2);
    expect({ ok: r.ok, error: String(r.error) }).toMatchObject({ ok: false, error: expect.stringMatching(code) });
    expect(snapshot()).toBe(before);
    expect(approvals(TASK)).toHaveLength(0);
  }

  beforeEach(async () => {
    db = openLedger(":memory:");
    rmSync(UI_ARTIFACT_ROOT, { recursive: true, force: true });
    setMeta(db, { actor: "owner", now: 1 }, { project: PROJ, key: "pms", value: [LEAD] });
    await ledger(LEAD, "item-new", "i9", "--title", "底座");
    expect(await ledger(LEAD, "task-new", TASK, "--title", "界面", "--kind", "code", "--item", "i9", "--agent", "task-ui", "--branch", "feat/u1")).toMatchObject({ ok: true });
    db.run(`INSERT INTO task_workflows (taskId, project, template, templateVersion, mode, authorFamily, fallback, specRev, createdAt, updatedAt)
      VALUES (?, ?, 'ui', 3, 'manual', 'claude', '', 1, 1, 1)`, [TASK, PROJ]);
    await ledger(DEV, "stage", TASK, "--from", "spec", "--to", "restate");
    await ledger(LEAD, "stage", TASK, "--from", "restate", "--to", "build");
  });
  afterEach(() => {
    closeLedger(":memory:");
    rmSync(RECOVERY_POLICY_PATH, { force: true });
    rmSync(UI_ARTIFACT_ROOT, { recursive: true, force: true });
  });

  test("未改工件：PM 照常批准，批准事件绑定原 head / 规格 / 轮次 / 摘要；原门（head / 摘要不符、非 PM）仍拒", async () => {
    const e = await delivered();
    expect(await approve(H3)).toMatchObject({ ok: false, code: "conflict" });
    expect(await approve(H2, "e".repeat(64))).toMatchObject({ ok: false, code: "conflict" });
    expect(await ledger(DEV, "ui-approve", TASK, "--head", H2, "--digest", e.digest)).toMatchObject({ ok: false, code: "forbidden" });
    expect(approvals(TASK)).toHaveLength(0);
    expect(await approve()).toMatchObject({ ok: true });
    expect(approvals(TASK)[0].data).toMatchObject({ head: H2, specRev: 1, round: 1, screenshotsDigest: e.digest });
  });

  test("交付后改字节 → hash_mismatch，逐表零写；改回原字节后批准合法", async () => {
    await delivered();
    const original = fs.readFileSync(shot("after"));
    writeFileSync(shot("after"), png("偷换后的截图"));
    await refused(/hash_mismatch/);
    writeFileSync(shot("after"), original);
    expect(await approve()).toMatchObject({ ok: true });
  });

  test("重命名替换（原文件挪走、同名放别的字节） → hash_mismatch；文件删掉 → artifact_missing", async () => {
    await delivered();
    renameSync(shot("before"), shot("before") + ".bak");
    writeFileSync(shot("before"), png("替换"));
    await refused(/hash_mismatch/);
    rmSync(shot("before"));
    await refused(/artifact_missing/);
  });

  test("中间软链（卡目录 / ref 子目录，内容逐字节相同） → path_untrusted", async () => {
    await delivered();
    renameSync(join(UI_ARTIFACT_ROOT, TASK, "shots"), join(UI_ARTIFACT_ROOT, TASK, "real"));
    symlinkSync(join(UI_ARTIFACT_ROOT, TASK, "real"), join(UI_ARTIFACT_ROOT, TASK, "shots"));
    await refused(/path_untrusted/);
    rmSync(join(UI_ARTIFACT_ROOT, TASK, "shots"));
    renameSync(join(UI_ARTIFACT_ROOT, TASK, "real"), join(UI_ARTIFACT_ROOT, TASK, "shots"));
    renameSync(join(UI_ARTIFACT_ROOT, TASK), join(UI_ARTIFACT_ROOT, `${TASK}-x`));
    symlinkSync(join(UI_ARTIFACT_ROOT, `${TASK}-x`), join(UI_ARTIFACT_ROOT, TASK));
    await refused(/path_untrusted/);
  });

  test("批准前 head / 规格 / 轮次漂移（review 中 CLI 不让换 head，这里绕过 CLI 直接改库，摘要没换）→ 拒，即便 --head 写新 head 也零写", async () => {
    await delivered();
    expect(await taskSet("--head", H3)).toMatchObject({ ok: false, code: "conflict" }); // 原门：review 中换 head 要先退回 fix
    db.run("UPDATE tasks SET headSHA = ? WHERE id = ?", [H3, TASK]);
    await refused(/head_drift/);
    db.run("UPDATE tasks SET headSHA = ?, round = 2 WHERE id = ?", [H2, TASK]);
    await refused(/evidence_drift/);
    db.run("UPDATE tasks SET round = 1, specRev = 2 WHERE id = ?", [TASK]);
    await refused(/evidence_drift/);
  });

  test("证据漂移：extra 里的截图路径被改（摘要不变）/ 登记后又交付了一次（off 不登记）→ evidence_drift", async () => {
    await delivered();
    const extra = card().extra;
    expect(await taskSet("--extra", JSON.stringify({ ...extra, screenshots: ["/tmp/别处/a.png", "/tmp/别处/b.png"] }))).toMatchObject({ ok: true });
    await refused(/evidence_drift/);
    // 正式登记之上改成人工摘要 + 别的路径：不能借旧人工路径绕开重核
    expect(await taskSet("--extra", JSON.stringify({ ...extra, screenshots: ["a.png", "b.png"], screenshotsDigest: "a".repeat(64) }))).toMatchObject({ ok: true });
    await refused(/evidence_drift/);
    expect(await taskSet("--extra", JSON.stringify(extra))).toMatchObject({ ok: true });
    policy("off");
    expect(await ledger(DEV, "deliver", TASK, "--head", H2, "--text", "补交")).toMatchObject({ ok: true });
    await refused(/evidence_drift/);
    // 同一轮有过正式登记：之后再换成任意人工摘要也不落到旧路径
    expect(await taskSet("--extra", JSON.stringify({ ...card().extra, screenshotsDigest: "b".repeat(64) }))).toMatchObject({ ok: true });
    await refused(/evidence_drift/);
  });

  test("旧合法人工路径：没有正式登记（off 交付 + 人工摘要），批准照原门通过，不新造摘要", async () => {
    policy("off");
    expect(await ledger(DEV, "deliver", TASK, "--from", "build", "--head", H2)).toMatchObject({ ok: true });
    const manual = "a".repeat(64);
    expect(await taskSet("--extra", JSON.stringify({ ...card().extra, screenshots: ["before.png", "after.png"], screenshotsDigest: manual }))).toMatchObject({ ok: true });
    expect(await approve(H2, manual)).toMatchObject({ ok: true });
    expect(approvals(TASK)[0].data).toMatchObject({ screenshotsDigest: manual });
    expect(card().extra.screenshotsDigest).toBe(manual);
  });

  test("ui-reject 不重核：工件被改时 PM 仍能退回", async () => {
    await delivered();
    writeFileSync(shot("after"), png("改过"));
    expect(await ledger(LEAD, "ui-reject", TASK, "--text", "截图不对")).toMatchObject({ ok: true });
  });

  test("TOCTOU：哈希之后、写批准之前文件被改写 → changed_during_check（身份复核），零写", async () => {
    await delivered();
    const real = fs.lstatSync;
    const spy = spyOn(fs, "lstatSync").mockImplementation(((p: fs.PathLike, o?: never) => {
      // 重核最后一步按路径复核叶文件身份：在它之前偷偷改写同一文件
      if (String(p) === shot("after") && new Error().stack?.includes("recheckUiEvidence")) writeFileSync(shot("after"), png("竞态改写"));
      return real(p, o);
    }) as typeof fs.lstatSync);
    try {
      expect(() => recheckUiEvidence(card(), listEvents(db, { target: TASK }))).toThrow(/changed_during_check/);
    } finally { spy.mockRestore(); }
  });

  test("TOCTOU：哈希之后 ref 子目录被换成指向同一目录的软链（叶 inode 不变）→ 按 realpath 复核拒", async () => {
    await delivered();
    const real = fs.lstatSync, dir = join(UI_ARTIFACT_ROOT, TASK, "shots");
    let swapped = false;
    const spy = spyOn(fs, "lstatSync").mockImplementation(((p: fs.PathLike, o?: never) => {
      if (!swapped && String(p) === shot("before") && new Error().stack?.includes("recheckUiEvidence")) {
        swapped = true;
        renameSync(dir, `${dir}-real`);
        symlinkSync(`${dir}-real`, dir);
      }
      return real(p, o);
    }) as typeof fs.lstatSync);
    try {
      expect(() => recheckUiEvidence(card(), listEvents(db, { target: TASK }))).toThrow(/changed_during_check/);
    } finally { spy.mockRestore(); }
    expect(swapped).toBe(true);
  });
});

describe("peer 写单交付（已导入工件）→ ui-approve", () => {
  const P = "claude-orchestrator", REPO = "shawnlu96/claudestra", FP = "abcd-ef01-2345-6789", BR = "lend/T9-abcd", WORKER = "agent-lend-0123456789";
  let root: string, policyPath: string, remote: Record<string, RemoteHead>;
  const dir = mkdtempSync(join(tmpdir(), "uihash-test-"));
  const key = instanceKeySync(dir);
  const borrow: BorrowEntry[] = [{ peer: "mate", projects: [P], roles: ["review", "write"], maxOpen: 2 }];
  const deps = (actor: string) => ({
    db, actor, projectIds: [P], loadRegistry: async () => ({ socket: "", agents: {} }), saveRegistry: async () => {}, now: () => 1_000_000,
    lend: {
      borrow: async () => borrow, notifyPm: async () => {},
      result: {
        reportDir: () => dir, writeReport: (p: string, b: string) => writeFileSync(p, b), sign: (f: string[]) => signPurpose(RECEIPT_PURPOSE, f, key),
        remoteHead: async (_r: string, branch: string): Promise<RemoteHead> => remote[branch] ?? { ok: false, error: "没有这个分支" },
        peerFp: async (peer: string) => (peer === "mate" ? FP : null),
        uiPort: (p: { peer: string; worker: string; orderId: string }) => uiDeliverPort({ peer: p, root, policyPath }),
      },
    },
  });
  const run = (args: string[], actor = "agent-pm") => runLedger(args, deps(actor)) as Promise<Record<string, any>>;
  const call = (ep: string, b: unknown) => run([`lend-${ep}`, "--", "mate", JSON.stringify(b)], "owner");

  beforeEach(() => {
    db = openLedger(":memory:");
    remote = { main: { ok: true, head: "b".repeat(40) } };
    root = UI_ARTIFACT_ROOT; // 批准重核读本机工件根（与生产端口同一个），测试进程里它在临时状态目录下
    rmSync(root, { recursive: true, force: true });
    policyPath = join(mkdtempSync(join(tmpdir(), "uihash-policy-")), "recovery-policy.json");
    writeFileSync(policyPath, JSON.stringify({ projects: { [P]: { keys: { uiDelivery: "on" } } } }));
    setMeta(db, { actor: "owner", now: 1 }, { project: P, key: "pms", value: ["agent-pm"] });
    const spec = join(dir, "T9.md");
    writeFileSync(spec, "规格：只改 src/lib/x.ts\n验收：单测全绿");
    createTask(db, { actor: "owner", now: 1 }, { project: P, id: "T9", title: "T9", kind: "code", spec, agent: "agent-dev" } as never);
    db.run("UPDATE tasks SET stage = 'build', round = 0 WHERE id = 'T9'");
    db.run(`INSERT INTO task_workflows (taskId, project, template, templateVersion, mode, authorFamily, fallback, specRev, createdAt, updatedAt)
      VALUES ('T9', ?, 'ui', 3, 'manual', 'codex', '', 1, 1, 1)`, [P]);
  });
  afterEach(() => { closeLedger(":memory:"); rmSync(root, { recursive: true, force: true }); });

  /** 合法导入 + peer 写单交付入账，返回导入目录 */
  async function deliveredImported(): Promise<string> {
    const { orderId } = await run(["lend-offer", "T9", "--peer", "mate", "--repo", REPO]);
    await call("claim", { v: 1, orderId, worker: WORKER });
    remote[BR] = { ok: true, head: H2 };
    const base = join(root, "imported", "mate", orderId.replaceAll(":", "_"));
    mkdirSync(base, { recursive: true });
    const files: Record<string, { sha256: string }> = {};
    const shots = (["before", "after"] as const).map((phase) => {
      const b = png(`${orderId}-${phase}`), ref = `home-${phase}.png`;
      writeFileSync(join(base, ref), b);
      files[ref] = { sha256: sha(b) };
      return { view: "home", size: "390x844", phase, ref, sha256: sha(b) };
    });
    writeFileSync(join(base, "provenance.json"), JSON.stringify({ v: 1, peer: "mate", worker: WORKER, orderId, head: H2, files }));
    const m = { v: 1 as const, taskId: "T9", head: H2, specRev: 1, round: 1, source: "imported" as const, summary: "手机首页前后", shots };
    const deliver = { v: 1, orderId, head: H2, evidence: BR, summary: "改了首页", selfCheck: "逐条对了", uiEvidence: { ...m, digest: uiEvidenceDigest(m) } };
    expect(await call("write", { v: 1, orderId, gen: 1, branch: BR, pr: 7, session: { id: "sess-1", family: "codex" }, deliver })).toMatchObject({ ok: true });
    expect(getTask(db, "T9")).toMatchObject({ stage: "review", headSHA: H2 });
    return base;
  }
  const approve = () => run(["ui-approve", "T9", "--head", H2, "--digest", getTask(db, "T9")!.extra.screenshotsDigest as string]);

  test("未改导入工件：批准合法", async () => {
    await deliveredImported();
    expect(await approve()).toMatchObject({ ok: true });
  });

  test("导入后改字节 / 改 provenance / order 层软链 → 拒，逐表零写", async () => {
    const base = await deliveredImported();
    const keep = fs.readFileSync(join(base, "home-after.png"));
    for (const [why, tamper, undo] of [
      ["改字节", () => writeFileSync(join(base, "home-after.png"), png("改过")), () => writeFileSync(join(base, "home-after.png"), keep)],
      ["provenance 改成别的 worker", () => {
        const p = JSON.parse(fs.readFileSync(join(base, "provenance.json"), "utf8"));
        writeFileSync(join(base, "provenance.json.keep"), JSON.stringify(p));
        writeFileSync(join(base, "provenance.json"), JSON.stringify({ ...p, worker: "agent-lend-other" }));
      }, () => renameSync(join(base, "provenance.json.keep"), join(base, "provenance.json"))],
      ["order 层软链", () => { renameSync(base, `${base}-x`); symlinkSync(`${base}-x`, base); }, () => { rmSync(base); renameSync(`${base}-x`, base); }],
    ] as [string, () => void, () => void][]) {
      tamper();
      const before = snapshot();
      const r = await approve();
      expect({ why, ok: r.ok, error: String(r.error) }).toMatchObject({ why, ok: false, error: expect.stringMatching(/hash_mismatch|provenance_mismatch|path_untrusted/) });
      expect(snapshot()).toBe(before);
      undo();
    }
    expect(approvals("T9")).toHaveLength(0);
    expect(await approve()).toMatchObject({ ok: true });
  });

  test("TOCTOU：读过之后 provenance.json 被改写（截图不动）→ changed_during_check，零写", async () => {
    const base = await deliveredImported(), prov = join(base, "provenance.json");
    const real = fs.lstatSync;
    const spy = spyOn(fs, "lstatSync").mockImplementation(((p: fs.PathLike, o?: never) => {
      if (String(p) === prov && new Error().stack?.includes("recheckUiEvidence")) {
        writeFileSync(prov, JSON.stringify({ ...JSON.parse(fs.readFileSync(prov, "utf8")), worker: "agent-lend-other" }));
      }
      return real(p, o);
    }) as typeof fs.lstatSync);
    const before = snapshot();
    try {
      const r = await approve();
      expect({ ok: r.ok, error: String(r.error) }).toMatchObject({ ok: false, error: expect.stringMatching(/changed_during_check/) });
    } finally { spy.mockRestore(); }
    expect(snapshot()).toBe(before);
  });
});
