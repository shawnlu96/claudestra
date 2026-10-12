/**
 * dispatch-recovery-WIPGATE1 的队列口径与配置（合成台账，tests/scheduler-merge-reclaim-world.ts 的 auto merge 卡 + 人工合并请求）：
 * [验收线 1] 真 `ledger merge-queue` 的 rows.length 与闸深度严格相等；manual.rows、review 卡、别的项目的 merge 卡不计；命令文字原样。
 * [验收线 7] 真 `ledger autostart-set` 写档位 / 阈值：重启后读值一致，其他字段与总开关照所选；非授权与非法输入整笔拒，配置与审计不变。
 */
import { afterEach, describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { setWorkflow } from "../src/lib/ledger-scheduler-write.js";
import { listEvents } from "../src/lib/ledger-store.js";
import { createTask, setMeta } from "../src/lib/ledger-write.js";
import { insertEvent } from "../src/lib/ledger-tx.js";
import { RECOVERY_POLICY_PATH } from "../src/lib/recovery-policy.js";
import { readSwitch } from "../src/lib/scheduler-autostart.js";
import { wipGateConfig, wipGateDepth, wipGateHold } from "../src/lib/scheduler-wip-gate-config.js";
import { reclaimWorld, type ReclaimWorld } from "./scheduler-merge-reclaim-world.js";
import { ledgerAs, manualCard, requestArgs, writePolicy } from "./manual-merge-queue-world.test.js";

const PM = "agent-pm", DISP = "agent-disp";
let w: ReclaimWorld;
afterEach(() => { w?.close(); rmSync(RECOVERY_POLICY_PATH, { force: true }); });

function setup(): void {
  w = reclaimWorld({ store: "memory" });
  setMeta(w.db, { actor: "owner", now: 1 }, { project: "p", key: "pms", value: [PM, DISP] });
  setMeta(w.db, { actor: "owner", now: 1 }, { project: "p", key: "team", value: { dispatcher: DISP, audit: true } });
  writePolicy("on");
}

const intent = (id: string, taskId: string, action: string, status: string) => w.db.query(`INSERT INTO scheduler_intents (id, taskId, project, node, action,
  causalSeq, eventSeq, taskRev, specRev, head, templateVersion, status, reason, createdAt, updatedAt)
  VALUES (?, ?, 'p', 'merge_deploy', ?, 1, 0, 2, 1, NULL, 2, ?, 'fixture', 1, 1)`).run(id, taskId, action, status);

describe("[验收线 1] 队列口径", () => {
  test("15 张 auto merge 卡（占车、排队、unknown、被挡）= rows.length = 闸深度；manual 请求、review 卡、别项目 merge 卡不计", async () => {
    setup();
    for (let i = 0; i < 15; i++) w.card(`T${String(i).padStart(2, "0")}`);
    await w.begin("T00"); // 占车
    intent("u1", "T01", "merge", "unknown"); // 结果不明
    intent("s2", "T02", "stage", "pending"); // 被挡：已有未结意图
    const m = await manualCard(w, "M");
    expect(await ledgerAs(w, PM, ...requestArgs(m))).toMatchObject({ ok: true });
    w.card("R"); w.db.query("UPDATE tasks SET stage = 'review' WHERE id = 'R'").run();
    setMeta(w.db, { actor: "owner", now: 2 }, { project: "q", key: "pms", value: [PM] });
    createTask(w.db, { actor: "owner", now: 3 }, { project: "q", id: "Q1", title: "q", kind: "code", agent: "agent-q" });
    setWorkflow(w.db, { actor: "owner", now: 4 }, { taskId: "Q1", taskRev: 1, template: "code", templateVersion: 2, mode: "auto", authorFamily: "claude", fallback: "x" });
    w.db.query("UPDATE tasks SET stage = 'merge' WHERE id = 'Q1'").run();

    const view = await ledgerAs(w, PM, "merge-queue", "--project", "p") as Record<string, any>;
    expect(view.rows).toHaveLength(15);
    expect(view.manual.rows).toHaveLength(1);
    expect(wipGateDepth(w.db, "p")).toBe(view.rows.length);
    expect(wipGateDepth(w.db, "q")).toBe(1);
    const byTask = Object.fromEntries(view.rows.map((r: { task: string; phase: string; blocked: string | null }) => [r.task, [r.phase, r.blocked]]));
    expect(byTask.T01).toEqual(["unknown", "外部结果不明，等 PM 核对：fixture"]);
    expect(byTask.T02).toEqual(["排队", "任务已有未结调度意图 s2"]);
    expect(byTask.T00[1]).toBeNull();
    expect(view.rows.map((r: { task: string }) => r.task).sort()).toEqual(Array.from({ length: 15 }, (_, i) => `T${String(i).padStart(2, "0")}`));
    // 命令文字原样（迁移前后同一格式）：每行「序号. 卡｜进 merge 时间｜已等 N 分钟｜阶段[｜挡：原因]」，人工段在后
    expect(view.lines[0]).toBe("1. T00｜进 merge ?｜已等 ? 分钟｜ready");
    const t02 = view.rows.findIndex((r: { task: string }) => r.task === "T02");
    expect(view.lines[t02]).toBe(`${t02 + 1}. T02｜进 merge ?｜已等 ? 分钟｜排队｜挡：任务已有未结调度意图 s2`);
    expect(view.lines).toHaveLength(15 + 1 + 1);
    expect(view.lines[15]).toBe("人工合并排队策略：on");

    // 阈值 15：等于就拦（on），14 不拦
    w.db.query("INSERT INTO meta (project, key, value) VALUES ('p', 'autostart', ?)").run(JSON.stringify({ wipGate: "on" }));
    expect(wipGateHold(w.db, "p")).toContain("合并队列 15 张，已到 WIP 闸阈值 15");
    w.db.query("UPDATE tasks SET stage = 'done' WHERE id = 'T14'").run();
    expect(wipGateDepth(w.db, "p")).toBe(14);
    expect(wipGateHold(w.db, "p")).toBeNull();
  });
});

describe("[验收线 7] autostart-set 配置", () => {
  const set = (actor: string, onOff: string, ...extra: string[]) => ledgerAs(w, actor, "autostart-set", onOff, "--project", "p", "--reason", "WIP 闸", ...extra) as Promise<Record<string, any>>;
  const audits = () => listEvents(w.db, { project: "p" }).filter((e) => e.kind === "meta" && e.data.op === "autostart");
  const raw = () => (w.db.query("SELECT value FROM meta WHERE project = 'p' AND key = 'autostart'").get() as { value: string } | null)?.value ?? null;

  test("缺省 observe / 15；写 observe / on / off 与阈值，合并写入，其他字段与总开关照所选，重启后读值一致；有效修改留审计", async () => {
    setup();
    expect(wipGateConfig(w.db, "p")).toEqual({ mode: "observe", threshold: 15 });
    expect(await set(PM, "on", "--post-verify-defer", "on", "--line", "80")).toMatchObject({ ok: true, wipGate: { mode: "observe", threshold: 15 } });
    expect(await set(PM, "on", "--wip-gate", "observe", "--wip-gate-threshold", "15")).toMatchObject({ ok: true,
      autostart: { postVerifyDefer: "on", weeklyLinePct: 80, wipGate: "observe", wipGateThreshold: 15 }, wipGate: { mode: "observe", threshold: 15 } });
    expect(await set("owner", "off", "--wip-gate", "on")).toMatchObject({ ok: true, autostart: { off: { by: "owner" }, wipGate: "on", wipGateThreshold: 15 } });
    expect(await set("master", "off", "--wip-gate-threshold", "3")).toMatchObject({ ok: true, autostart: { wipGate: "on", wipGateThreshold: 3 }, wipGate: { mode: "on", threshold: 3 } });
    expect(audits().at(-1)!.data.value).toMatchObject({ wipGate: "on", wipGateThreshold: 3, postVerifyDefer: "on", weeklyLinePct: 80, off: { by: "master" } });
    w.restart();
    expect(readSwitch(w.db, "p")).toMatchObject({ wipGate: "on", wipGateThreshold: 3, postVerifyDefer: "on", weeklyLinePct: 80, off: { by: "master" } });
    expect(wipGateConfig(w.db, "p")).toEqual({ mode: "on", threshold: 3 });
    expect(await set(PM, "on", "--wip-gate", "off")).toMatchObject({ ok: true, autostart: { wipGate: "off", wipGateThreshold: 3 }, wipGate: { mode: "off", threshold: 3 } });
    expect(readSwitch(w.db, "p").off).toBeUndefined();
    expect(audits()).toHaveLength(5);
  });

  test("非授权 actor、阈值 0 / 负数 / 小数 / 非数字、非法档位：整笔拒，配置与审计不变", async () => {
    setup();
    await set(PM, "on", "--wip-gate", "on", "--wip-gate-threshold", "7");
    const before = raw(), n = audits().length;
    expect(await set("agent-x", "on", "--wip-gate", "off")).toMatchObject({ ok: false, code: "forbidden" });
    expect(await set("scheduler", "on", "--wip-gate", "off")).toMatchObject({ ok: false, code: "forbidden" });
    for (const bad of ["0", "-1", "1.5", "abc", "", " "]) {
      expect(await set(PM, "off", "--wip-gate", "observe", `--wip-gate-threshold=${bad}`)).toMatchObject({ ok: false, code: "invalid" });
    }
    for (const bad of ["maybe", "ON", ""]) expect(await set(PM, "off", `--wip-gate=${bad}`, "--wip-gate-threshold", "9")).toMatchObject({ ok: false, code: "invalid" });
    expect(raw()).toBe(before);
    expect(audits()).toHaveLength(n);
    expect(wipGateConfig(w.db, "p")).toEqual({ mode: "on", threshold: 7 });
    insertEvent(w.db, { actor: "owner", now: 5 }, { project: "p", target: "", kind: "note", text: "", data: {} }, false); // 台账照常可写
  });
});
