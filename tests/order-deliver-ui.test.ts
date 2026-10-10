/**
 * UISDEL1 本机入口：MCP deliver（parseDeliverWire → deliverOrder）→ 进程内真实 ledger CLI → ledger-write.deliver 事务，临时台账。
 * uiDelivery 策略文件与工件根都在测试的临时状态目录（tests/preload.ts）；项目号独占，用完删掉。
 */
import type { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { UI_ARTIFACT_ROOT } from "../src/lib/ledger-deliver-ui-port.ts";
import { projectPmUiGate } from "../src/lib/ledger-ui-approve-verdict.ts";
import { listSteps } from "../src/lib/ledger-steps.ts";
import { closeLedger, getTask, listEvents, openLedger } from "../src/lib/ledger-store.ts";
import { deliver, setMeta } from "../src/lib/ledger-write.ts";
import { deliverOrder, type RemoteHead } from "../src/lib/order-deliver.ts";
import type { PrRows } from "../src/lib/order-deliver-pr.ts";
import { parseUiEvidence, uiEvidenceDigest, type UiEvidence, type UiShot } from "../src/lib/order-deliver-ui.ts";
import type { LedgerRun } from "../src/lib/order-ledger-exit.ts";
import { ORDER_TOOLS } from "../src/lib/order-tools.ts";
import type { VerifiedCall } from "../src/lib/order-tool-route.ts";
import { parseDeliverWire } from "../src/lib/order-wire.ts";
import { RECOVERY_POLICY_PATH } from "../src/lib/recovery-policy.ts";
import { uiMergeRefusal } from "../src/lib/scheduler-ui-gate.ts";
import type { Registry } from "../src/manager/core.ts";
import { runLedger } from "../src/manager/ledger.ts";

const PROJ = "uisdel";
const LEAD = "agent-lead";
const DEV = "agent-task-ui";
const SHA = "c".repeat(40);
const OLD = "e".repeat(40);
const URL1 = "https://github.com/o/r/pull/7";
const TASK = "U1";

let db: Database;
const writes: string[][] = [];
const channels: Record<string, string> = { "c-lead": LEAD, "c-dev": DEV };
const ledger = (actor: string, ...args: string[]) => {
  const reg = { socket: "", agents: { [LEAD]: { status: "active", projectId: PROJ }, [DEV]: { status: "active", projectId: PROJ } } } as unknown as Registry;
  return runLedger(args, { db, actor, actorProject: PROJ, projectIds: [PROJ], loadRegistry: async () => structuredClone(reg), saveRegistry: async () => {}, now: () => Date.now() }) as Promise<
    Record<string, any>
  >;
};
const viaCli: LedgerRun = (args, ch) => (writes.push(args), ledger(channels[ch] ?? "unknown", ...args.slice(1)));
const me: VerifiedCall = { agent: DEV, sessionId: "s1", family: "claude-code", channelId: "c-dev" };
const at = async (): Promise<RemoteHead> => ({ ok: true, head: SHA });
const prs = async (): Promise<PrRows> => ({ ok: true, rows: [{ url: URL1, headRefOid: SHA, baseRefName: "main", isCrossRepository: false }] });
const card = (id = TASK) => getTask(db, id)!;
const policy = (mode: string | null) => {
  if (mode === null) rmSync(RECOVERY_POLICY_PATH, { force: true });
  else {
    mkdirSync(join(RECOVERY_POLICY_PATH, ".."), { recursive: true });
    writeFileSync(RECOVERY_POLICY_PATH, mode === "corrupt" ? "{" : JSON.stringify({ projects: { [PROJ]: { keys: { uiDelivery: mode } } } }));
  }
};
const png = (s: string) => Buffer.from(`\x89PNG\r\n\x1a\n${s}`);
const sha = (b: Buffer) => createHash("sha256").update(b).digest("hex");

/** 在本卡工件根下放前后一对（或给定的一组）截图，返回带规范摘要的清单 */
function shots(task = TASK, over: Partial<Omit<UiEvidence, "digest" | "shots">> = {}, list?: Omit<UiShot, "sha256">[]): UiEvidence {
  const dir = join(UI_ARTIFACT_ROOT, task);
  mkdirSync(dir, { recursive: true });
  const rows = (list ?? [{ view: "home", size: "1280x800", phase: "before", ref: "home-before.png" }, { view: "home", size: "1280x800", phase: "after", ref: "home-after.png" }])
    .map((s) => { const b = png(`${task}-${s.ref}`); writeFileSync(join(dir, s.ref), b); return { ...s, sha256: sha(b) }; });
  const e = { v: 1 as const, taskId: task, head: SHA, specRev: 1, round: 1, source: "local" as const, summary: "首页前后对比", shots: rows, ...over };
  return { ...e, digest: uiEvidenceDigest(e) };
}
const wire = (ui?: unknown, orderId = `${TASK}:write:r0`) =>
  ({ v: 1, orderId, head: SHA, evidence: "docs/tasks/U1.report.md", summary: "交付", selfCheck: "过", ...(ui === undefined ? {} : { uiEvidence: ui }) });

/** 业务表全量快照：任务 / 事件 / 步骤 / 提问 / 来源确认都算 */
const snapshot = () => JSON.stringify({ tasks: db.query("SELECT * FROM tasks ORDER BY id").all(), events: db.query("SELECT seq FROM events").all(),
  steps: listSteps(db, TASK), asks: db.query("SELECT id FROM asks").all() });

async function newCard(id: string, template: "ui" | "code" | null) {
  expect(await ledger(LEAD, "task-new", id, "--title", "界面", "--kind", "code", "--item", "i9", "--agent", "task-ui", "--branch", `feat/${id.toLowerCase()}`)).toMatchObject({ ok: true });
  if (template) db.run(`INSERT INTO task_workflows (taskId, project, template, templateVersion, mode, authorFamily, fallback, specRev, createdAt, updatedAt)
    VALUES (?, ?, ?, 3, 'manual', 'claude', '', 1, 1, 1)`, [id, PROJ, template]);
  await ledger(DEV, "stage", id, "--from", "spec", "--to", "restate");
  await ledger(LEAD, "stage", id, "--from", "restate", "--to", "build");
}

let sourceConfirms = 0;
const mcp = (args: unknown, findPr = prs) => deliverOrder(me, args, { db, run: viaCli, remoteHead: at, findPr, confirmSource: () => (sourceConfirms++, true) });

beforeEach(async () => {
  writes.length = 0;
  sourceConfirms = 0;
  rmSync(UI_ARTIFACT_ROOT, { recursive: true, force: true });
  db = openLedger(":memory:");
  setMeta(db, { actor: "owner", now: 1 }, { project: PROJ, key: "pms", value: [LEAD] });
  await ledger(LEAD, "item-new", "i9", "--title", "底座");
  await newCard(TASK, "ui");
});
afterEach(() => { closeLedger(":memory:"); policy(null); rmSync(UI_ARTIFACT_ROOT, { recursive: true, force: true }); });

describe("清单解析（MCP / CLI / peer 同一个）", () => {
  test("有效清单过 parseDeliverWire；乱序 shots 摘要相同；MCP schema 声明了 uiEvidence", () => {
    const e = shots();
    const w = parseDeliverWire(wire(e));
    expect(w.ok && w.value.uiEvidence?.digest).toBe(e.digest);
    expect(parseUiEvidence({ ...e, shots: [...e.shots].reverse() }).digest).toBe(e.digest);
    expect((ORDER_TOOLS.find((t) => t.name === "deliver")!.inputSchema.properties as Record<string, unknown>).uiEvidence).toBeDefined();
    expect(parseDeliverWire(wire()).ok).toBe(true); // 旧 wire 不带也照收
  });

  test("缺 before/after、空 / 过长清单、坏摘要、重复、路径穿越 / 绝对路径 / 控制字符、未知字段 → 拒", () => {
    const e = shots();
    const one = { ...e, shots: [e.shots[0], { ...e.shots[0], view: "other" }] };
    const many = { ...e, shots: Array.from({ length: 18 }, (_, i) => ({ ...e.shots[i % 2], view: `v${i >> 1}`, ref: `s${i}.png` })) };
    const bad: unknown[] = [
      { ...one, digest: uiEvidenceDigest(one) }, { ...e, shots: [] }, { ...many, digest: uiEvidenceDigest(many) }, { ...e, digest: "0".repeat(64) },
      { ...e, shots: [e.shots[0], e.shots[0]] }, ...["../x.png", "/etc/passwd.png", "a/../../b.png", "a\nb.png", "x.svg", "./a.png"].map((ref) => {
        const s = { ...e, shots: [{ ...e.shots[0], ref }, e.shots[1]] };
        return { ...s, digest: uiEvidenceDigest(s) };
      }),
      { ...e, extra: 1 }, { ...e, source: "remote" }, { ...e, summary: "a\nb" }, "not an object",
    ];
    for (const b of bad) expect(parseDeliverWire(wire(b)).ok).toBe(false);
  });
});

describe("mode=on：写入前拒，逐表零写", () => {
  test("旧红：observe（缺省）下无截图的 ui 交付照样进 review；on 下同一份在写入前被拒，任务 / 事件 / 步骤 / 来源全不动", async () => {
    const before = snapshot();
    policy("on");
    const r = await mcp(wire());
    expect(r).toMatchObject({ ok: false, code: "invalid" });
    expect(String((r as { error: string }).error)).toContain("missing");
    expect(snapshot()).toBe(before);
    expect(sourceConfirms).toBe(0);
    policy(null);
    expect(await mcp(wire())).toMatchObject({ ok: true, stage: "review" }); // 缺省 observe：原行为（这就是要堵的旧红）
    expect(card().extra.screenshots).toBeUndefined();
    expect(listEvents(db, { project: PROJ, target: TASK }).filter((e) => e.data.op === "recovery_observe" && e.data.mechanism === "uiDelivery")).toHaveLength(1);
  });

  test("每种坏证据（MCP 与 CLI 同一规则）→ 拒、零写", async () => {
    policy("on");
    mkdirSync(join(UI_ARTIFACT_ROOT, TASK), { recursive: true });
    const outside = mkdtempSync(join(tmpdir(), "uisdel-outside-"));
    writeFileSync(join(outside, "x.png"), png("secret"));
    symlinkSync(join(outside, "x.png"), join(UI_ARTIFACT_ROOT, TASK, "link.png"));
    symlinkSync(outside, join(UI_ARTIFACT_ROOT, TASK, "dir"));
    const swap = (e: UiEvidence, i: number, s: Partial<UiShot>) => { const x = { ...e, shots: e.shots.map((y, j) => (j === i ? { ...y, ...s } : y)) }; return { ...x, digest: uiEvidenceDigest(x) }; };
    const okShots = shots();
    await newCard("U2", "ui");
    const cases: [string, unknown][] = [
      ["旧 head", shots(TASK, { head: OLD })], ["旧规格", shots(TASK, { specRev: 2 })], ["旧轮次", shots(TASK, { round: 0 })],
      ["跨卡", shots("U2")], ["imported 冒充本机", shots(TASK, { source: "imported" })],
      ["软链逃根", swap(okShots, 0, { ref: "link.png", sha256: sha(png("secret")) })], ["目录软链逃根", swap(okShots, 0, { ref: "dir/x.png", sha256: sha(png("secret")) })],
      ["不存在", swap(okShots, 0, { ref: "nope.png" })], ["声明 hash 与实际字节不符", swap(okShots, 0, { sha256: "a".repeat(64) })],
    ];
    const before = snapshot();
    for (const [why, ui] of cases) {
      const viaMcp = await mcp(wire(ui));
      expect({ why, ok: viaMcp.ok }).toEqual({ why, ok: false });
      const viaCliDirect = await ledger(DEV, "deliver", TASK, "--from", "build", "--head", SHA, "--ui-evidence", JSON.stringify(ui));
      expect({ why, ok: viaCliDirect.ok }).toEqual({ why, ok: false });
      expect(snapshot()).toBe(before);
    }
    expect(sourceConfirms).toBe(0);
    // 非 ui 卡在 on 下带截图 → 拒（不借交付扩大登记范围）；不带 → 原样通过
    await newCard("C1", "code");
    expect(await ledger(DEV, "deliver", "C1", "--from", "build", "--head", SHA, "--ui-evidence", JSON.stringify(shots("C1")))).toMatchObject({ ok: false });
    expect(await ledger(DEV, "deliver", "C1", "--from", "build", "--head", SHA)).toMatchObject({ ok: true });
    expect(card("C1").extra.screenshots).toBeUndefined();
    rmSync(outside, { recursive: true, force: true });
  });
});

describe("mode=on：有效证据", () => {
  test("同一笔登记截图元数据、摘要与 deliver 事件，进 review；不写任何批准，PM 截图门仍在等", async () => {
    policy("on");
    const e = shots();
    const r = await mcp(wire(e));
    expect(r).toMatchObject({ ok: true, stage: "review", duplicate: false });
    expect(sourceConfirms).toBe(1);
    const t = card();
    expect(t).toMatchObject({ stage: "review", headSHA: SHA, round: 1, specRev: 1 });
    expect(t.extra.screenshotsDigest).toBe(e.digest);
    expect(t.extra.screenshots).toEqual(e.shots.map((s) => join(UI_ARTIFACT_ROOT, TASK, s.ref)));
    const ev = listEvents(db, { project: PROJ, target: TASK }).filter((x) => x.kind === "deliver");
    expect(ev).toHaveLength(1);
    expect(ev[0].data.uiEvidence).toMatchObject({ digest: e.digest, head: SHA, specRev: 1, round: 1, source: "local", bytesVerified: true });
    expect(writes[0].some((a) => a.startsWith("--ui-evidence="))).toBe(true);
    const all = listEvents(db, { project: PROJ, target: TASK });
    expect(all.some((x) => JSON.stringify(x.data).includes("UI_APPROVED") || x.data.op === "ui_approve" || x.kind === "decision")).toBe(false);
    expect(projectPmUiGate(db, t, all).state).toBe("none");
    expect(uiMergeRefusal(db, t, Date.now())).not.toBeNull();
  });

  test("重放：同单 / head / 清单 → 原回执、零重复；不同清单 → 拒、不覆盖", async () => {
    policy("on");
    const e = shots();
    const first = await mcp(wire(e));
    const again = await mcp(wire(e));
    expect(again as object).toEqual({ ...(first as object), duplicate: true });
    const other = shots(TASK, { summary: "换了一份" });
    const before = snapshot();
    expect(await mcp(wire(other))).toMatchObject({ ok: false, code: "dedup_conflict" });
    expect(await mcp(wire())).toMatchObject({ ok: false, code: "dedup_conflict" });
    expect(snapshot()).toBe(before);
    expect(card().extra.screenshotsDigest).toBe(e.digest);
    expect(listEvents(db, { project: PROJ, target: TASK }).filter((x) => x.kind === "deliver")).toHaveLength(1);
    // CLI 同一 dedup 键换清单同样拒
    const key = writes[0].find((a) => a.startsWith("--dedup="))!.slice(8);
    expect(await ledger(DEV, "deliver", TASK, "--from", "build", "--head", SHA, "--ui-evidence", JSON.stringify(other), "--dedup", key)).toMatchObject({ ok: false, code: "dedup_mismatch" });
  });

  test("核对期间卡被改（CAS 漂移）/ 事务后段失败 → 全回滚，截图不落", async () => {
    policy("on");
    const e = shots();
    const racing = async (): Promise<PrRows> => { await ledger(LEAD, "task-set", TASK, "--rev", String(card().rev), "--title", "改了"); return prs(); };
    const before = () => ({ extra: card().extra, deliver: listEvents(db, { project: PROJ, target: TASK }).filter((x) => x.kind === "deliver").length });
    const b0 = before();
    expect(await mcp(wire(e), racing)).toMatchObject({ ok: false, code: "conflict" });
    expect(before()).toEqual(b0);
    const snap = snapshot();
    // 证据过了，推阶段那一步失败（from 不对）：extra 与事件都不留
    const { uiDeliverPort } = await import("../src/lib/ledger-deliver-ui-port.ts");
    expect(() => deliver(db, { actor: DEV, now: 5 }, { taskId: TASK, headSHA: SHA, moveFrom: "fix", uiEvidence: e, ui: uiDeliverPort() })).toThrow();
    expect(snapshot()).toBe(snap);
  });
});

describe("off / observe / 坏配置", () => {
  test("off：带坏清单也不读不写证据，原交付照常；坏配置按 off", async () => {
    for (const mode of ["off", "corrupt"]) {
      policy(mode);
      const id = mode === "off" ? TASK : "U3";
      if (id !== TASK) await newCard(id, "ui");
      expect(await ledger(DEV, "deliver", id, "--from", "build", "--head", SHA, "--ui-evidence", JSON.stringify(shots(id, { head: OLD })))).toMatchObject({ ok: true });
      expect(card(id).extra.screenshots).toBeUndefined();
      const ev = listEvents(db, { project: PROJ, target: id });
      expect(ev.some((x) => x.data.op === "recovery_observe")).toBe(false);
      expect(ev.find((x) => x.kind === "deliver")!.data.uiEvidence).toBeUndefined();
    }
  });

  test("observe：记一次可诊断缺项（去重），不阻断、不写截图 / 批准", async () => {
    policy("observe");
    expect(await ledger(DEV, "deliver", TASK, "--head", SHA)).toMatchObject({ ok: true });
    expect(await ledger(DEV, "deliver", TASK, "--head", SHA)).toMatchObject({ ok: true });
    expect(await ledger(DEV, "deliver", TASK, "--from", "build", "--head", SHA, "--ui-evidence", JSON.stringify(shots()))).toMatchObject({ ok: true });
    const ev = listEvents(db, { project: PROJ, target: TASK });
    expect(ev.filter((x) => x.data.op === "recovery_observe")).toHaveLength(1);
    expect(card().extra.screenshots).toBeUndefined();
    expect(card().stage).toBe("review");
  });

  test("非 ui 旧 payload：on 下 code 卡交付与以前一样", async () => {
    policy("on");
    await newCard("C2", "code");
    expect(await ledger(DEV, "deliver", "C2", "--from", "build", "--head", SHA, "--evidence", "docs/x.md")).toMatchObject({ ok: true });
    expect(card("C2")).toMatchObject({ stage: "review", headSHA: SHA });
    expect(listEvents(db, { project: PROJ, target: "C2" }).some((x) => x.data.op === "recovery_observe")).toBe(false);
  });
});
