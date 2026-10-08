/**
 * team-project-PMWAKE 验收线 1「开关后定为准」：项目 off@T0 之后单独打开的 feature（off:false@T1>T0）照常过开关门；
 * 早于项目 off 的 off:false 仍被项目开关压住；feature off:true 总是关；项目开着时与 main 一致。
 * 三个调用方（自动开卡 featureGate、自动交回 serviceBlock、manual-resume cardBlock）口径一致。
 */
import type { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { addDep } from "../src/lib/ledger-deps-write.js";
import { setAutostartSwitch } from "../src/lib/ledger-autostart.js";
import { getFeature } from "../src/lib/ledger-feature.js";
import { createFeature, initDag } from "../src/lib/ledger-feature-write.js";
import { getWorkflow } from "../src/lib/ledger-scheduler.js";
import { closeLedger, getTask, openLedger } from "../src/lib/ledger-store.js";
import { createTask, moveStage, recordVerify, setMeta } from "../src/lib/ledger-write.js";
import { manualResumeVerdict } from "../src/lib/manual-resume.js";
import { featureGate, type AutostartSwitch, type ServiceFacts } from "../src/lib/scheduler-autostart.js";
import { serviceBlock } from "../src/lib/scheduler-autostart-resume.js";
import { switchOff } from "../src/lib/shared-ledger-gate-switch.js";
import { autoFixture } from "./scheduler-auto-helpers.js";

const stamp = (at: number, reason = "r") => ({ reason, by: "agent-pm", at });

describe("switchOff：后定为准", () => {
  const sw: AutostartSwitch = {
    off: stamp(100, "其他事先暂停"),
    features: { A: { off: false, ...stamp(101) }, B: { off: false, ...stamp(99) }, C: { off: true, ...stamp(102, "C 关") } },
  };

  test("项目 off@T0、A off:false@T1>T0 → A 开着（main 上 A 停在项目开关）", () => {
    expect(switchOff(sw, "A")).toBeNull();
  });

  test("B off:false 早于项目 off → 仍是项目开关拦", () => {
    expect(switchOff(sw, "B")).toContain("项目的自动开卡关着");
  });

  test("C off:true → 关（项目 off 时仍报项目原因，与 main 一致）；项目开着时报 feature 原因", () => {
    expect(switchOff(sw, "C")).toContain("项目的自动开卡关着");
    expect(switchOff({ features: sw.features }, "C")).toContain("feature C 的自动开卡关着");
  });

  test("没记录的 feature、featureId 为 null → 项目开关说了算", () => {
    expect(switchOff(sw, "D")).toContain("项目的自动开卡关着");
    expect(switchOff(sw, null)).toContain("项目的自动开卡关着");
  });

  test("项目开着：与 main 一致（off:false 开、off:true 关、没记录开）", () => {
    const on: AutostartSwitch = { features: sw.features };
    expect(switchOff(on, "A")).toBeNull();
    expect(switchOff(on, "B")).toBeNull();
    expect(switchOff(on, "D")).toBeNull();
    expect(switchOff({}, null)).toBeNull();
  });

  test("项目之后再关（off@T2>T1）→ A 又被项目开关压住", () => {
    expect(switchOff({ ...sw, off: stamp(200) }, "A")).toContain("项目的自动开卡关着");
  });
});

describe("台账上的三个调用方", () => {
  const P = "claude-orchestrator", PM = "agent-pm", A = "ab12-a", B = "ab12-b";
  let dir: string, db: Database, now: number;
  const svc: ServiceFacts = { autoDispatch: true, projects: [P], maxWorkers: () => 3 };
  const set = (on: boolean, featureId?: string) => setAutostartSwitch(db, { actor: PM, now: now++ }, { project: P, on, featureId, reason: "测试" });

  beforeEach(() => {
    now = 1_000;
    dir = mkdtempSync(join(tmpdir(), "pmwake-switch-"));
    db = openLedger(join(dir, "ledger.sqlite"));
    db.prepare("INSERT INTO ledger_instance (key, value) VALUES ('origin', 'ab12')").run();
    setMeta(db, { actor: "owner", now: 500 }, { project: P, key: "pms", value: [PM] });
    for (const slug of ["a", "b"]) {
      createFeature(db, { actor: PM, now: now++ }, { project: P, slug, title: `F${slug}` });
      initDag(db, { actor: PM, now: now++ }, { id: `ab12-${slug}`, rev: 1, nodes: [{ key: "n", oneLine: "n", fileGlobs: [`src/${slug}.ts`] }] });
    }
  });
  afterEach(() => {
    closeLedger(join(dir, "ledger.sqlite"));
    rmSync(dir, { recursive: true, force: true });
  });

  test("featureGate / serviceBlock：B 开在项目关之前 → switch；A 开在项目关之后 → 放行", () => {
    set(true, B);
    set(false);
    set(true, A);
    expect(featureGate(db, getFeature(db, A)!, svc)).toBeNull();
    expect(featureGate(db, getFeature(db, B)!, svc)?.gate).toBe("switch");
    const task = (featureId: string) => ({ ...getTask(db, "x") ?? {}, project: P, featureId }) as never;
    expect(serviceBlock(db, task(A), svc)).toBeNull();
    expect(serviceBlock(db, task(B), svc)).toContain("项目的自动开卡关着");
    set(false, A);
    expect(featureGate(db, getFeature(db, A)!, svc)?.gate).toBe("switch");
  });

  test("set 只改开关，记录里的 pm 不丢（后定为准按 at 比）", () => {
    set(false);
    set(true, A);
    const sw = db.query("SELECT value FROM meta WHERE project = ? AND key = 'autostart'").get(P) as { value: string };
    const v = JSON.parse(sw.value) as AutostartSwitch;
    expect(v.features![A].at).toBeGreaterThan(v.off!.at);
  });
});

describe("manual-resume 对 A 同样放行", () => {
  const TO_LIVE = [["spec", "restate"], ["restate", "build"], ["build", "review"], ["review", "merge"], ["merge", "live"]] as const;

  test("项目关、T1 所在 feature 之后单独打开 → 放行；feature 开在项目关之前 → 拒", async () => {
    const f = autoFixture();
    try {
      const wf = () => getWorkflow(f.db, "T1")!;
      expect(await f.cli("pm", "scheduler-recovery", "p", "on", "--key", "manualStall", "--reason", "PMWAKE 测试")).toMatchObject({ ok: true });
      createTask(f.db, f.at("owner"), { project: "p", id: "T0", title: "前置", kind: "code" });
      addDep(f.db, f.at("owner"), { from: "T0", to: "T1", kind: "blocks", when: "T0 上线后" });
      expect(await f.cli("pm", "workflow-set", "T1", "--rev", String(f.task().rev), "--workflow-rev", String(wf().rev), "--template", wf().template,
        "--version", "2", "--mode", "manual", "--author-family", "claude", "--fallback", "只报错不修", "--reason-code", "deps_not_live", "--reason", "等 T0")).toMatchObject({ ok: true });
      for (const [from, to] of TO_LIVE) moveStage(f.db, f.at("owner"), { taskId: "T0", from: from as never, to: to as never });
      recordVerify(f.db, f.at("owner"), { taskId: "T0", result: "pass", data: { checks: [{ id: "pr-merged", status: "pass" }] } });
      f.db.prepare("INSERT OR IGNORE INTO ledger_instance (key, value) VALUES ('origin', 'ab12')").run();
      const fx = createFeature(f.db, f.at("pm"), { project: "p", slug: "fx", title: "FX" }).row.id;
      f.db.query("UPDATE tasks SET featureId = ? WHERE id = 'T1'").run(fx);
      expect(manualResumeVerdict(f.db, f.task(), wf())).toMatchObject({ ok: true });
      const meta = (v: AutostartSwitch) => f.db.query("INSERT INTO meta (project, key, value) VALUES ('p', 'autostart', ?) ON CONFLICT (project, key) DO UPDATE SET value = excluded.value").run(JSON.stringify(v));
      meta({ off: stamp(100, "暂停"), features: { [fx]: { off: false, ...stamp(99) } } });
      expect(manualResumeVerdict(f.db, f.task(), wf())).toMatchObject({ ok: false, why: expect.stringContaining("项目的自动开卡关着") });
      meta({ off: stamp(100, "暂停"), features: { [fx]: { off: false, ...stamp(101) } } });
      expect(manualResumeVerdict(f.db, f.task(), wf())).toMatchObject({ ok: true });
    } finally {
      f.close();
    }
  });
});
