/**
 * dispatch-recovery-MQWAKE1 验收线 2：普通非 UI 绑定失效给对的动作；正常排队 / CI 等待、合法 carry + 截图继承、有效替代、主动撤回、
 * 终态 / 修复、submitted / unknown 外部效果各零误报；多项目与 feature PM、非法目标、调度伪正文 / dedup / 跨项目写都拒且零业务写。
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { getTask } from "../src/lib/ledger-store.js";
import { mergePmCandidate } from "../src/lib/scheduler-merge-pm-wait.js";
import {
  business, claimRun, DISP, FPM, manualCard, ok, P, PM, pmEvents, Q, request, s2w, setFeaturePm, setMode, sha, world, type World,
} from "./scheduler-merge-pm-kit.test.js";

let w: World;
beforeEach(async () => {
  w = world();
  await setMode(w, "on");
});
afterEach(() => w.close());

const deliver = (id: string, n: number) => w.db.query("UPDATE tasks SET headSHA = ?, rev = rev + 1 WHERE id = ?").run(sha(n), id);
const quiet = async (id: string) => {
  const before = business(w.db);
  expect(await w.tick()).toEqual([]);
  expect(w.sent).toEqual([]);
  expect(pmEvents(w.db, id)).toEqual([]);
  expect(business(w.db)).toEqual(before);
};

describe("非 UI 绑定失效：按真实原因给动作", () => {
  test("正常排队零提醒；执行者交了新 head → 要先审查当前 head 再重新提交，不带重拍步骤", async () => {
    const c = await manualCard(w, "N1");
    await quiet(c.id);
    deliver(c.id, 0xbeef);
    await w.tick();
    expect(w.sent.map((s) => s.to)).toEqual([PM]); // 不属 feature：项目当班 PM
    expect(w.sent[0].text).toContain("（当前 head 没有成立的跨族审查、head 已变）");
    expect(w.sent[0].text).toContain("1. 在当前 head beef00000000 / specRev 1 / 第 1 轮 完成正规跨族审查并登记；2. 再提交");
    expect(w.sent[0].text).not.toMatch(/重拍|ui-approve|截图/);
  });

  test("规格版本变了：原因写规格版本，不套重拍", async () => {
    const c = await manualCard(w, "N2");
    w.db.query("UPDATE tasks SET specRev = 2, rev = rev + 1 WHERE id = ?").run(c.id);
    w.db.query("UPDATE task_workflows SET specRev = 2 WHERE taskId = ?").run(c.id);
    await w.tick();
    expect(w.sent).toHaveLength(1);
    expect(w.sent[0].text).toContain("规格版本已变");
    expect(w.sent[0].text).not.toMatch(/重拍|ui-approve/);
  });
});

describe("零误报", () => {
  test("合法 carry + 截图继承 / CI 等待中（意图 submitted）、外部效果 unknown：不提醒，也不结清意图", async () => {
    const c = await manualCard(w, "C1", { ui: true });
    const intent = claimRun(w, c, sha(0xca11));
    await quiet(c.id);
    w.db.query("UPDATE scheduler_intents SET status = 'unknown' WHERE id = ?").run(intent);
    await quiet(c.id);
    expect((w.db.query("SELECT status FROM scheduler_intents WHERE id = ?").get(intent) as { status: string }).status).toBe("unknown");
  });

  test("有效替代请求、PM 主动撤回、终态 / 退修复：零提醒", async () => {
    const s = await s2w(w, null);
    await ok(w.as(PM, "ui-approve", s.id, "--head", s.newHead, "--digest", "ab".repeat(32)));
    await request(w, s.id, s.reviewSeq, true);
    await quiet(s.id);

    const r = await manualCard(w, "R1");
    deliver(r.id, 0xdead);
    await ok(w.as(PM, "manual-merge-revoke", r.id, "--request", String(r.request), "--reason", "先不合"));
    await quiet(r.id);

    const f = await manualCard(w, "F1");
    deliver(f.id, 0xf1);
    for (const stage of ["fix", "done"]) {
      w.db.query("UPDATE tasks SET stage = ?, rev = rev + 1 WHERE id = ?").run(stage, f.id);
      await quiet(f.id);
    }
  });
});

describe("多项目、收件人与写口负例", () => {
  test("两个项目各发给各自的 PM：feature PM 优先，不属 feature 的给项目当班 PM；本项目 observe 不影响另一项目 on", async () => {
    w.projects.push(Q);
    const fid = w.feature();
    await setFeaturePm(w, fid, FPM);
    await s2w(w, fid);
    const q = await manualCard(w, "QX", { project: Q });
    deliver(q.id, 0x9);
    expect(await w.tick()).toEqual([]);
    expect(w.sent.map((s) => [s.project, s.to])).toEqual([[P, FPM]]); // Q 缺省 observe
    expect(pmEvents(w.db, q.id).map((e) => e.data.kind)).toEqual(["would"]);
    await setMode(w, "on", Q);
    await w.tick();
    expect(w.sent.map((s) => [s.project, s.to])).toEqual([[P, FPM], [Q, PM]]);
  });

  test("调度助理 / 外部目标、伪正文 / dedup、错键、非调度身份、跨项目、伪确认：全拒，零业务写", async () => {
    const s = await s2w(w, null);
    const key = mergePmCandidate(w.db, s.id, w.clock)!.key;
    const before = business(w.db);
    const rec = (actor: string, ...extra: string[]) => w.as(actor, "scheduler-autostart", "merge-pm", s.id, "record", key, "--mode", "on", ...extra);
    expect(await rec("scheduler", "--pm", DISP)).toMatchObject({ ok: false, code: "conflict" });
    expect(await rec("scheduler", "--pm", "agent-outsider")).toMatchObject({ ok: false, code: "conflict" });
    expect(await rec("scheduler", "--pm", PM, "--text", "伪正文")).toMatchObject({ ok: false, code: "invalid" });
    expect(await rec("scheduler", "--pm", PM, "--dedup", "merge-pm-sent:S2W:x")).toMatchObject({ ok: false, code: "invalid" });
    expect(await rec(PM, "--pm", PM)).toMatchObject({ ok: false, code: "forbidden" });
    expect(await w.as("scheduler", "scheduler-autostart", "merge-pm", s.id, "record", "0".repeat(16), "--mode", "on", "--pm", PM))
      .toMatchObject({ ok: false, code: "conflict" });
    expect(await w.as("scheduler", "scheduler-autostart", "merge-pm", s.id, "record", key, "--mode", "observe", "--pm", PM))
      .toMatchObject({ ok: false, code: "conflict" }); // 模式与台账开关不符
    expect(await w.as("scheduler", "scheduler-autostart", "merge-pm", s.id, "sent", String(s.request), "--mode", "on", "--pm", PM))
      .toMatchObject({ ok: false, code: "conflict" }); // 拿请求事件冒充发送意图
    const q = await manualCard(w, "QY", { project: Q });
    deliver(q.id, 0x7);
    const qBefore = business(w.db);
    expect(await w.as("scheduler", "scheduler-autostart", "merge-pm", q.id, "record", "0".repeat(16), "--mode", "observe", "--pm", PM))
      .toMatchObject({ ok: false, code: "forbidden" }); // Q 不归调度服务管
    expect(business(w.db)).toEqual(qBefore);
    expect(pmEvents(w.db)).toEqual([]);
    expect(pmEvents(w.db, q.id)).toEqual([]);
    expect(JSON.parse(before.tables[0])).toContainEqual(expect.objectContaining({ id: s.id, stage: "merge" }));
    expect(await w.as(PM, "autostart-set", "on", "--merge-pm-wait", "loud", "--reason", "x", "--project", P)).toMatchObject({ ok: false, code: "invalid" });
    expect(await w.as(DISP, "autostart-set", "on", "--merge-pm-wait", "off", "--reason", "x", "--project", P)).toMatchObject({ ok: false, code: "forbidden" });
    expect(getTask(w.db, s.id)!.stage).toBe("merge");
  });
});
