/**
 * team-project-PMWAKE 验收线 2「feature PM」：autostart-set --feature --pm 记进 features[id]；自动开卡 claim（建卡的 pm）与缺规格提醒取 featurePm；
 * 不设 = 项目 PM（与 main 一致）；不在名单 / 是调度助理 → 拒；--pm - 清掉回到项目 PM。命令经进程内 runLedger（与 CLI 同一路径）。
 */
import type { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFeature, initDag } from "../src/lib/ledger-feature-write.js";
import { closeLedger, openLedger } from "../src/lib/ledger-store.js";
import { setMeta } from "../src/lib/ledger-write.js";
import { featurePm, readSwitch } from "../src/lib/scheduler-autostart.js";
import { runLedger } from "../src/manager/ledger.js";

const P = "claude-orchestrator", PM = "agent-pm-codex", X = "agent-claudestra", D = "agent-dispatch", FID = "ab12-i28", ARM = "0123456789abcdef";
let dir: string, db: Database, now: number;

const run = (actor: string, ...args: string[]) => runLedger(args, {
  db, actor, projectIds: [P], loadRegistry: async () => ({}) as never, saveRegistry: async () => {}, now: () => now++,
  autoDispatch: () => true, autoProjects: () => [P],
}) as Promise<Record<string, any>>;
const set = (...extra: string[]) => run(PM, "autostart-set", "on", "--project", P, "--reason", "测试", ...extra);
const claim = () => run("scheduler", "scheduler-autostart", "claim", FID, "a", "--arm", ARM, "--template", "code", "--max-workers", "3");

beforeEach(() => {
  now = 1_000;
  dir = mkdtempSync(join(tmpdir(), "pmwake-feature-pm-"));
  db = openLedger(join(dir, "ledger.sqlite"));
  db.prepare("INSERT INTO ledger_instance (key, value) VALUES ('origin', 'ab12')").run();
  setMeta(db, { actor: "owner", now: 500 }, { project: P, key: "pms", value: [PM, X, D] });
  db.query("INSERT INTO meta (project, key, value) VALUES (?, 'team', ?)").run(P, JSON.stringify({ dispatcher: D, sinceSeq: 0 }));
  createFeature(db, { actor: PM, now: now++ }, { project: P, slug: "i28", title: "协作底座" });
  initDag(db, { actor: PM, now: now++ }, { id: FID, rev: 1, nodes: [{ key: "a", oneLine: "节点 a", fileGlobs: ["src/lib/a*.ts"] }] });
});
afterEach(() => {
  closeLedger(join(dir, "ledger.sqlite"));
  rmSync(dir, { recursive: true, force: true });
});

describe("autostart-set --pm", () => {
  test("设 --pm X：记进 features[id]，自动开卡 claim 的 pm=X（建卡的 pm 取它）", async () => {
    expect(await set("--feature", FID, "--pm", X)).toMatchObject({ ok: true, autostart: { features: { [FID]: { off: false, pm: X } } } });
    expect(featurePm(db, FID)).toBe(X);
    expect(await claim()).toMatchObject({ ok: true, claim: { pm: X } });
  });

  test("不设：项目 PM（与 main 一致）", async () => {
    expect(featurePm(db, FID)).toBe(PM);
    expect(await claim()).toMatchObject({ ok: true, claim: { pm: PM } });
  });

  test("--pm 不在名单 / 是调度助理 / 没带 --feature → 拒，开关不变", async () => {
    expect(await set("--feature", FID, "--pm", "agent-nobody")).toMatchObject({ ok: false, code: "invalid" });
    expect(await set("--feature", FID, "--pm", D)).toMatchObject({ ok: false, code: "invalid" });
    expect(await set("--pm", X)).toMatchObject({ ok: false, code: "invalid" });
    expect(readSwitch(db, P)).toEqual({});
  });

  test("--pm - 清掉 → 回到项目 PM；不带 --pm 再设开关时保留原 pm", async () => {
    await set("--feature", FID, "--pm", X);
    expect((await run(PM, "autostart-set", "off", "--project", P, "--feature", FID, "--reason", "关一下")).ok).toBe(true);
    expect(readSwitch(db, P).features?.[FID]).toMatchObject({ off: true, pm: X });
    await set("--feature", FID, "--pm", "-");
    expect(readSwitch(db, P).features?.[FID]?.pm).toBeUndefined();
    expect(featurePm(db, FID)).toBe(PM);
  });

  test("记录的 pm 后来被移出名单 → 回退项目 PM，不发给已离任的人", async () => {
    await set("--feature", FID, "--pm", X);
    setMeta(db, { actor: "owner", now: now++ }, { project: P, key: "pms", value: [PM, D] });
    expect(featurePm(db, FID)).toBe(PM);
  });
});

describe("autostart-set --spec-wait", () => {
  test("on / observe / off 存进 autostart meta；别的值拒", async () => {
    for (const m of ["on", "observe", "off"]) expect(await set("--spec-wait", m)).toMatchObject({ ok: true, autostart: { specWait: m } });
    expect(await set("--spec-wait", "loud")).toMatchObject({ ok: false, code: "invalid" });
  });
});
