/**
 * 「还欠不欠对抗式」按轮次 + head 绑定（src/lib/ledger-handler.ts owesAdversarial / nextAfterReview）与 `review --to merge` 闸门、
 * PM 的 --waive adversarial（src/manager/ledger-field-checks.ts、ledger-write-cmds.ts）：
 * 上一轮的派审顶不了这一轮、派审之后换了 head 不算审过、对抗式 pass 只对它审的那个 head 有效。
 */
import type { Database } from "bun:sqlite";
import { mkdirSync, mkdtempSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, test } from "bun:test";
import { currentHandler, lastReviewOf, owesAdversarial } from "../src/lib/ledger-handler.js";
import { getTask, listEvents, openLedger } from "../src/lib/ledger-store.js";
import { createTask, deliver, moveStage, setMeta } from "../src/lib/ledger-write.js";
import { specPolicyOf } from "../src/lib/task-spec.js";
import type { Registry } from "../src/manager/core.js";
import { runLedger } from "../src/manager/ledger.js";
import { tempLedgerPath } from "./ledger-test-helpers.js";

const P = "proj";
let db: Database;
let docs: string;
let head: string | null;
const reg: Registry = {
  socket: "s",
  agents: {
    "agent-exec": { status: "active", projectId: P, cwd: "/w/t1" } as unknown as Registry["agents"][string],
    "agent-disp": { status: "active", projectId: P } as Registry["agents"][string],
    "agent-pm": { status: "active", projectId: P } as Registry["agents"][string],
  },
};
const o = { actor: "owner", now: 1 };

function run(actor: string, ...args: string[]) {
  return runLedger(args, {
    db, actor, actorProject: P, projectIds: [P],
    loadRegistry: async () => structuredClone(reg), saveRegistry: async () => {}, now: () => 5_000, gitHead: () => head,
  }) as Promise<Record<string, any>>;
}

const spec = (text: string) => writeFileSync(join(docs, "tasks", "T1.md"), text);
const verdict = (v: string, to?: string, ...more: string[]) =>
  ["review", "T1", "--reviewer", "r", "--verdict", v, "--p0", "0", "--p1", v === "pass" ? "0" : "1", "--p2", "0", ...(to ? ["--to", to] : []), ...more];
/**
 * 执行者交付；from = build / fix 时同时推进 review（新一轮），不带 = 在 review 里重新交付。
 * sha = null：交付不带 --head（T28a 人工节点的 deliver 就是这样），worktree 的 HEAD 也不去核对
 */
const ship = (sha: string | null, from?: "build" | "fix") => {
  if (sha) head = sha;
  deliver(db, { actor: "agent-exec", now: 2 }, { taskId: "T1", ...(sha ? { headSHA: sha } : {}), moveFrom: from });
};
/**
 * review 里交付新 head 现在一律拒（ledger-steps-write.ts checkReviewHead）；修之前留下的数据里可能有（同一轮的 deliver 事件带新 head）。
 * 临时把阶段改掉再交付来造这种老数据，钉住合并门这层兜底
 */
const legacySwap = (sha: string) => {
  db.prepare("UPDATE tasks SET stage = 'fix' WHERE id = 'T1'").run();
  ship(sha);
  db.prepare("UPDATE tasks SET stage = 'review' WHERE id = 'T1'").run();
};
const events = () => listEvents(db, { target: "T1" });
const round = () => getTask(db, "T1")?.round ?? 0;
const policy = () => specPolicyOf(getTask(db, "T1") as never, docs);
const handler = () => currentHandler(getTask(db, "T1") as never, events(), { pms: ["agent-pm", "agent-disp"], dispatcher: "agent-disp" }, policy());

beforeEach(() => {
  db = openLedger(tempLedgerPath("ledger-gate-"));
  docs = mkdtempSync(join(tmpdir(), "ledger-gate-docs-"));
  mkdirSync(join(docs, "tasks"));
  spec("# T1\n- 审查：Claude 审查员一轮；最后一轮对抗式\n");
  setMeta(db, o, { project: P, key: "pms", value: ["agent-pm", "agent-disp"] });
  setMeta(db, o, { project: P, key: "docsDir", value: docs });
  setMeta(db, o, { project: P, key: "team", value: { dispatcher: "agent-disp", audit: true } });
  createTask(db, o, { project: P, id: "T1", title: "班子", kind: "code", agent: "agent-exec" });
  moveStage(db, o, { taskId: "T1", from: "spec", to: "restate" });
  moveStage(db, o, { taskId: "T1", from: "restate", to: "build" });
});

describe("派审记录按轮次 + head 绑定", () => {
  test("S1：上一轮的对抗式派审顶不了这一轮没派审的 pass（归调度助理，--to merge 被拒）", async () => {
    ship("aaaa1111", "build");
    await run("agent-disp", "dispatch", "T1");
    await run("agent-disp", ...verdict("pass"));
    expect((await run("agent-disp", "dispatch", "T1")).event.data.reviewer).toBe("adversarial");
    expect((await run("agent-disp", ...verdict("changes", "fix"))).task.stage).toBe("fix");
    ship("bbbb2222", "fix");
    expect((await run("agent-disp", ...verdict("pass"))).ok).toBe(true);
    expect(handler()?.role).toBe("dispatcher");
    const r = await run("agent-disp", ...verdict("pass", "merge"));
    expect(r).toMatchObject({ ok: false, code: "conflict" });
    expect(getTask(db, "T1")?.stage).toBe("review");
  });

  test("S2：同一轮派了对抗式之后 head 换了（review 里交付新 head 已拒，这里是老数据），没审过的 head 不能 --to merge", async () => {
    ship("aaaa1111", "build");
    await run("agent-disp", "dispatch", "T1", "--adversarial");
    expect(await run("agent-exec", "deliver", "T1", "--head", "cccc3333")).toMatchObject({ ok: false, code: "conflict" });
    legacySwap("cccc3333");
    expect((await run("agent-disp", ...verdict("pass", "merge"))).code).toBe("conflict");
    // 对新 head 重新派对抗式，判通过就放行
    expect((await run("agent-disp", "dispatch", "T1", "--adversarial")).event.data.head).toBe("cccc3333");
    expect((await run("agent-disp", ...verdict("pass", "merge"))).task.stage).toBe("merge");
  });

  test("S3：对抗式 pass 只对它审的 head 有效：合并后退回 fix、交付新 head，常规 pass 不能 --to merge", async () => {
    ship("aaaa1111", "build");
    await run("agent-disp", "dispatch", "T1", "--adversarial");
    expect((await run("agent-disp", ...verdict("pass", "merge"))).task.stage).toBe("merge");
    expect(owesAdversarial(policy(), events(), round())).toBe(false);
    moveStage(db, o, { taskId: "T1", from: "merge", to: "fix" });
    ship("dddd4444", "fix");
    expect(owesAdversarial(policy(), events(), round())).toBe(true);
    await run("agent-disp", "dispatch", "T1");
    expect((await run("agent-disp", ...verdict("pass", "merge"))).code).toBe("conflict");
    // 审过之后执行者想 task-set 换 head 继承旧的对抗式 pass：review 里直接拒，head 不动、pass 仍然只对审过的那个
    await run("agent-disp", "dispatch", "T1", "--adversarial");
    await run("agent-disp", ...verdict("pass"));
    expect(owesAdversarial(policy(), events(), round())).toBe(false);
    expect(await run("agent-exec", "task-set", "T1", "--rev", String(getTask(db, "T1")?.rev), "--head", "eeee5555")).toMatchObject({ ok: false, code: "conflict" });
    expect(getTask(db, "T1")?.headSHA).toBe("dddd4444");
  });
});

describe("PM 豁免：review --waive adversarial --text <理由>", () => {
  test("只有 PM（调度助理除外）能用，要 pass、要理由；记进事件，只对当前 head 有效", async () => {
    ship("aaaa1111", "build");
    await run("agent-disp", "dispatch", "T1", "--adversarial");
    await run("agent-disp", ...verdict("pass"));
    legacySwap("ffff6666");
    const waive = (who: string, ...extra: string[]) => run(who, ...verdict("pass", "merge", "--waive", "adversarial", ...extra));
    expect((await waive("agent-disp", "--text", "增量只改了注释")).code).toBe("forbidden");
    expect((await waive("agent-pm")).code).toBe("invalid");
    expect((await run("agent-pm", ...verdict("changes", undefined, "--waive", "adversarial", "--text", "x"))).code).toBe("invalid");
    expect((await run("agent-pm", ...verdict("pass", undefined, "--waive", "regular", "--text", "x"))).code).toBe("invalid");
    const ok = await waive("agent-pm", "--text", "增量只改了注释，PM 已看");
    expect(ok.task.stage).toBe("merge");
    expect(ok.event).toMatchObject({ actor: "agent-pm", text: "增量只改了注释，PM 已看", data: { waive: "adversarial", verdict: "pass" } });
    moveStage(db, o, { taskId: "T1", from: "merge", to: "fix" });
    ship("abab7777", "fix");
    expect(owesAdversarial(policy(), events(), round())).toBe(true);
  });

  test("豁免之后路由判审查走完（归 PM）", async () => {
    ship("aaaa1111", "build");
    await run("agent-disp", "dispatch", "T1");
    await run("agent-pm", ...verdict("pass", undefined, "--waive", "adversarial", "--text", "PM 决定不跑对抗式"));
    expect(handler()?.role).toBe("pm");
  });
});

describe("规格卡读不出审查策略", () => {
  test("S4：审查写在行中间、写成粗体都读得出，要对抗式", async () => {
    ship("aaaa1111", "build");
    for (const card of ["- runtime：Claude Code，Opus 5.5，effort high。审查：Claude 审查员一轮；最后一轮对抗式。", "- **审查**：常规一轮；最后一轮对抗式"]) {
      spec(`# T1\n${card}\n`);
      expect(policy()).toContain("对抗");
    }
    await run("agent-disp", "dispatch", "T1");
    expect((await run("agent-disp", ...verdict("pass", "merge"))).code).toBe("conflict");
  });

  test("提到对抗式却读不出「审查：」= 不知道：归调度助理，--to merge 被拒；找不到规格卡不拦", async () => {
    ship("aaaa1111", "build");
    spec("# T1\n最后一轮对抗式审查，重点：lab 模式\n");
    expect(policy()).toBeUndefined();
    await run("agent-disp", "dispatch", "T1");
    await run("agent-disp", ...verdict("pass"));
    expect(handler()?.role).toBe("dispatcher");
    expect((await run("agent-disp", ...verdict("pass", "merge"))).error).toContain("读不出「审查：」");
    spec("# T1\n只做常规审查\n");
    expect(policy()).toBeNull();
    expect((await run("agent-disp", ...verdict("pass", "merge"))).task.stage).toBe("merge");
  });
});

describe("交付不带 head：旧轮次的对抗式 pass 不能顶（r4）", () => {
  test("S3b：对抗式 pass → merge → 退回 fix，交付新代码但没带 --head，常规 pass 不能 --to merge", async () => {
    ship("abc1234", "build");
    await run("agent-disp", "dispatch", "T1", "--adversarial");
    expect((await run("agent-disp", ...verdict("pass", "merge"))).task.stage).toBe("merge");
    moveStage(db, o, { taskId: "T1", from: "merge", to: "fix" });
    ship(null, "fix");
    expect(round()).toBe(2);
    expect(owesAdversarial(policy(), events(), round())).toBe(true);
    expect((await run("agent-disp", "dispatch", "T1")).event.data.reviewer).toBe("regular");
    expect((await run("agent-disp", ...verdict("pass", "merge"))).code).toBe("conflict");
  });

  test("S3c：全程不记 head，第 1 轮对抗式 pass、merge → fix → 第 2 轮常规 pass 不能 --to merge", async () => {
    ship(null, "build");
    await run("agent-disp", "dispatch", "T1", "--adversarial");
    expect((await run("agent-disp", ...verdict("pass", "merge"))).task.stage).toBe("merge");
    moveStage(db, o, { taskId: "T1", from: "merge", to: "fix" });
    ship(null, "fix");
    expect(owesAdversarial(policy(), events(), round())).toBe(true);
    expect((await run("agent-disp", ...verdict("pass", "merge"))).code).toBe("conflict");
  });

  test("人工节点：deliver 不带 headSHA；同一轮派了对抗式之后又交付（不带 head），pass 不能 --to merge，重新派对抗式才行", async () => {
    ship(null, "build");
    await run("agent-disp", "dispatch", "T1", "--adversarial");
    ship(null);
    expect((await run("agent-disp", ...verdict("pass", "merge"))).code).toBe("conflict");
    expect((await run("agent-disp", "dispatch", "T1", "--adversarial")).duplicate).toBe(false);
    expect((await run("agent-disp", ...verdict("pass", "merge"))).task.stage).toBe("merge");
  });

  test("对抗式 pass 之后再交付：带同一个 head 不算重新欠，不带 head 或换了 head 就欠", async () => {
    ship("abc1234", "build");
    await run("agent-disp", "dispatch", "T1", "--adversarial");
    await run("agent-disp", ...verdict("pass"));
    ship("abc1234");
    expect(owesAdversarial(policy(), events(), round())).toBe(false);
    ship(null);
    expect(owesAdversarial(policy(), events(), round())).toBe(true);
  });

  test("豁免也只对它那一轮有效", async () => {
    ship(null, "build");
    await run("agent-pm", ...verdict("pass", "merge", "--waive", "adversarial", "--text", "PM 看过"));
    moveStage(db, o, { taskId: "T1", from: "merge", to: "fix" });
    ship(null, "fix");
    expect(owesAdversarial(policy(), events(), round())).toBe(true);
  });
});

describe("续派不被幂等键吞掉（判定只认最近一条 dispatch）", () => {
  const dispatches = () => events().filter((e) => e.kind === "dispatch").map((e) => e.data.reviewer);

  test("常规 pass → 对抗式 changes 不推 fix → 再派常规：新写一条，常规 pass 不能算对抗式", async () => {
    ship("aaaa1111", "build");
    await run("agent-disp", "dispatch", "T1");
    await run("agent-disp", ...verdict("pass"));
    expect((await run("agent-disp", "dispatch", "T1")).event.data.reviewer).toBe("adversarial");
    await run("agent-disp", ...verdict("changes"));
    const d = await run("agent-disp", "dispatch", "T1");
    expect(d.duplicate).toBe(false);
    expect(dispatches()).toEqual(["regular", "adversarial", d.event.data.reviewer]);
    expect((await run("agent-disp", ...verdict("pass", "merge"))).code).toBe("conflict");
  });

  test("中间派过别的种类：命中的旧派审已不是最近一条，新写一条；什么都没变时重跑仍是同一条", async () => {
    ship("aaaa1111", "build");
    await run("agent-disp", "dispatch", "T1");
    await run("agent-disp", "dispatch", "T1", "--adversarial");
    const again = await run("agent-disp", "dispatch", "T1");
    expect(again.duplicate).toBe(false);
    expect(dispatches()).toEqual(["regular", "adversarial", "regular"]);
    const rerun = await run("agent-disp", "dispatch", "T1");
    expect(rerun).toMatchObject({ duplicate: true, event: { seq: again.event.seq } });
    expect((await run("agent-disp", ...verdict("pass", "merge"))).code).toBe("conflict");
  });
});

describe("一次派审只算一次（dispatchKindFor）", () => {
  test("同一次派审被两条 review 用到：第二条不算（说不清哪种审查员审的），--to merge 被拦", async () => {
    ship("aaaa1111", "build");
    await run("agent-disp", "dispatch", "T1", "--adversarial");
    await run("agent-disp", ...verdict("changes"));
    expect(owesAdversarial(policy(), events(), round())).toBe(true);
    expect(owesAdversarial(policy(), events(), round(), { verdict: "pass" })).toBe(true);
    expect((await run("agent-disp", ...verdict("pass", "merge"))).code).toBe("conflict");
    // 记下这条套用旧派审的 pass：说不清是哪种审查员审的，归调度助理核对，不算还清
    await run("agent-disp", ...verdict("pass"));
    expect(owesAdversarial(policy(), events(), round())).toBe(true);
    expect(handler()?.role).toBe("dispatcher");
    expect(getTask(db, "T1")?.stage).toBe("review");
    // 重新派对抗式、判通过才放行
    await run("agent-disp", "dispatch", "T1", "--adversarial");
    expect((await run("agent-disp", ...verdict("pass", "merge"))).task.stage).toBe("merge");
  });

  test("常规派审 → pass → 再一条 pass（没有新派审）：第二条种类为 null，不能 --to merge、不算还清；PM 豁免不受影响", async () => {
    ship("aaaa1111", "build");
    await run("agent-disp", "dispatch", "T1");
    await run("agent-disp", ...verdict("pass"));
    await run("agent-disp", ...verdict("pass"));
    const [first, second] = events().filter((e) => e.kind === "review");
    expect(lastReviewOf(first, events()).kind).toBe("regular");
    expect(lastReviewOf(second, events()).kind).toBeNull();
    expect(owesAdversarial(policy(), events(), round())).toBe(true);
    expect((await run("agent-disp", ...verdict("pass", "merge"))).code).toBe("conflict");
    const waived = await run("agent-pm", ...verdict("pass", "merge", "--waive", "adversarial", "--text", "增量只改了文档"));
    expect(waived.task.stage).toBe("merge");
    expect(owesAdversarial(policy(), events(), round())).toBe(false);
  });
});

describe("PM 手动 stage review → merge 也过合并闸门", () => {
  const stageMerge = () => run("agent-pm", "stage", "T1", "--from", "review", "--to", "merge");
  const regularPass = async () => {
    ship("aaaa1111", "build");
    await run("agent-disp", "dispatch", "T1");
    await run("agent-disp", ...verdict("pass"));
  };

  test("还欠对抗式：被拦，报错里写明怎么补对抗式、怎么 --waive", async () => {
    await regularPass();
    const r = await stageMerge();
    expect(r).toMatchObject({ ok: false, code: "conflict" });
    expect(r.error).toContain("ledger dispatch T1");
    expect(r.error).toContain("ledger review T1 … --verdict pass --to merge --waive adversarial --text <理由>");
    expect(getTask(db, "T1")?.stage).toBe("review");
  });

  test("判不清（规格卡提到对抗式但读不出「审查：」）：被拦", async () => {
    spec("# T1\n最后要对抗式过一遍\n");
    await regularPass();
    expect(await stageMerge()).toMatchObject({ ok: false, code: "conflict" });
  });

  test("PM 豁免之后（review --waive 不推阶段）：stage 放行", async () => {
    await regularPass();
    await run("agent-pm", ...verdict("pass", undefined, "--waive", "adversarial", "--text", "增量只改了注释"));
    expect((await stageMerge()).task.stage).toBe("merge");
  });

  test("对抗式通过还清之后：stage 照常放行", async () => {
    await regularPass();
    await run("agent-disp", "dispatch", "T1", "--adversarial");
    await run("agent-disp", ...verdict("pass"));
    expect((await stageMerge()).task.stage).toBe("merge");
  });
});

describe("`dispatch:` 幂等键前缀只给派审用", () => {
  test("执行者拿算得出的派审键写 note 被拒，调度助理照常派审", async () => {
    ship("aaaa1111", "build");
    const key = `dispatch:T1:r${round()}:regular:aaaa1111:d${events().findLast((e) => e.kind === "deliver")?.seq}:v0`;
    for (const k of [key, `${key}:s0`]) {
      expect(await run("agent-exec", "note", "T1", "占位", "--dedup", k)).toMatchObject({ ok: false, code: "invalid" });
    }
    const d = await run("agent-disp", "dispatch", "T1");
    expect(d).toMatchObject({ ok: true, duplicate: false, event: { dedupKey: key } });
  });
});

describe("进了 merge 之后不能换成没审过的 head（adv1 P1-3）", () => {
  const toMerge = async () => {
    ship("aaaa1111", "build");
    await run("agent-disp", "dispatch", "T1", "--adversarial");
    expect((await run("agent-disp", ...verdict("pass", "merge"))).task.stage).toBe("merge");
  };

  test("执行者 deliver --head <新> 被拒（task-set --head 本来就拒），台账 head 不变；报错指向 PM 退回 review", async () => {
    await toMerge();
    head = "bbbb2222";
    const r = await run("agent-exec", "deliver", "T1", "--head", "bbbb2222", "--text", "小修");
    expect(r).toMatchObject({ ok: false, code: "conflict" });
    expect(r.error).toContain("先由 PM 退回 fix");
    expect(getTask(db, "T1")).toMatchObject({ stage: "merge", headSHA: "aaaa1111" });
    expect(owesAdversarial(policy(), events(), round())).toBe(false);
  });

  test("PM 也一样拒；同一个 head、不带 head 的交付照收；PM 退回 fix 之后新 head 照常交付、重新欠对抗式", async () => {
    await toMerge();
    expect(await run("agent-pm", "deliver", "T1", "--head", "bbbb2222")).toMatchObject({ ok: false, code: "conflict" });
    expect((await run("agent-exec", "deliver", "T1", "--head", "aaaa1111", "--text", "补证据")).ok).toBe(true);
    expect((await run("agent-exec", "deliver", "T1", "--text", "人工节点")).ok).toBe(true);
    expect((await run("agent-pm", "stage", "T1", "--from", "merge", "--to", "fix")).task.stage).toBe("fix");
    head = "bbbb2222";
    expect((await run("agent-exec", "deliver", "T1", "--from", "fix", "--head", "bbbb2222")).task.headSHA).toBe("bbbb2222");
    expect(owesAdversarial(policy(), events(), round())).toBe(true);
  });

  const rev = () => String(getTask(db, "T1")?.rev);

  test("PM 在 merge 阶段 task-set 换成不同的 head 也拒；只补 --pr / --branch、写入相同的 head 照常放行（adv2 P2-1）", async () => {
    await toMerge();
    expect(await run("agent-pm", "task-set", "T1", "--rev", rev(), "--head", "ffff6666")).toMatchObject({ ok: false, code: "conflict" });
    expect((await run("agent-pm", "task-set", "T1", "--rev", rev(), "--pr", "169", "--branch", "task/t1")).ok).toBe(true);
    expect((await run("agent-pm", "task-set", "T1", "--rev", rev(), "--head", "aaaa1111", "--pr", "170")).ok).toBe(true);
    expect(getTask(db, "T1")).toMatchObject({ stage: "merge", headSHA: "aaaa1111", pr: "170", branch: "task/t1" });
  });

  test("merge → blocked 期间换 head：deliver / task-set 都按 merge 拒；绕过去换了的（修之前留下的数据）回 merge 时被合并门拦下（adv2 P1）", async () => {
    await toMerge();
    expect((await run("agent-pm", "stage", "T1", "--from", "merge", "--to", "blocked")).ok).toBe(true);
    head = "dddd4444";
    expect(await run("agent-exec", "deliver", "T1", "--head", "dddd4444")).toMatchObject({ ok: false, code: "conflict" });
    expect(await run("agent-exec", "task-set", "T1", "--rev", rev(), "--head", "dddd4444")).toMatchObject({ ok: false, code: "forbidden" });
    expect(await run("agent-exec", "task-set", "T1", "--rev", rev(), "--branch", "task/x")).toMatchObject({ ok: false, code: "forbidden" });
    expect(await run("agent-pm", "task-set", "T1", "--rev", rev(), "--head", "dddd4444")).toMatchObject({ ok: false, code: "conflict" });
    expect(getTask(db, "T1")?.headSHA).toBe("aaaa1111");
    ship("dddd4444");
    const back = await run("agent-pm", "stage", "T1", "--from", "blocked", "--to", "merge");
    expect(back).toMatchObject({ ok: false, code: "conflict" });
    expect(back.error).toContain("--from blocked --to review");
    expect(getTask(db, "T1")?.stage).toBe("blocked");
  });

  /** 出口（PM 定 ①）：之前在 merge 的 blocked 退回 review（round+1），再派审或 PM 豁免 */
  const unblockToReview = async () => {
    await toMerge();
    await run("agent-pm", "stage", "T1", "--from", "merge", "--to", "blocked");
    ship("dddd4444");
    expect(await run("agent-exec", "stage", "T1", "--from", "blocked", "--to", "review")).toMatchObject({ ok: false, code: "forbidden" });
    expect((await run("agent-pm", "stage", "T1", "--from", "blocked", "--to", "review")).task).toMatchObject({ stage: "review", round: 2 });
    expect(owesAdversarial(policy(), events(), round())).toBe(true);
  };

  test("出口：merge → blocked → review（round+1）→ 派对抗式 → pass → merge", async () => {
    await unblockToReview();
    expect((await run("agent-disp", ...verdict("pass", "merge"))).code).toBe("conflict");
    expect((await run("agent-disp", "dispatch", "T1", "--adversarial")).event.data.reviewer).toBe("adversarial");
    expect((await run("agent-disp", ...verdict("pass", "merge"))).task).toMatchObject({ stage: "merge", headSHA: "dddd4444", round: 2 });
  });

  test("出口：merge → blocked → review → PM --waive → merge", async () => {
    await unblockToReview();
    const w = await run("agent-pm", ...verdict("pass", "merge", "--waive", "adversarial", "--text", "只改了 CI 配置"));
    expect(w.task).toMatchObject({ stage: "merge", headSHA: "dddd4444" });
  });

  test("merge → blocked → merge，head 没动：照常放行", async () => {
    await toMerge();
    await run("agent-pm", "stage", "T1", "--from", "merge", "--to", "blocked");
    expect((await run("agent-exec", "deliver", "T1", "--head", "aaaa1111", "--text", "等 CI")).ok).toBe(true);
    expect((await run("agent-pm", "stage", "T1", "--from", "blocked", "--to", "merge")).task.stage).toBe("merge");
  });
});

describe("策略取规格卡和派审记录里更严的（adv1 P2-3）", () => {
  const regularPassAfterAdvDispatchPolicy = async () => {
    ship("aaaa1111", "build");
    expect((await run("agent-disp", "dispatch", "T1")).event.data.policy).toContain("对抗");
    await run("agent-disp", ...verdict("pass"));
  };

  test("派审时卡上要对抗式，之后把卡改成一轮：常规 pass 仍不能 --to merge，再派审仍选对抗式", async () => {
    await regularPassAfterAdvDispatchPolicy();
    spec("# T1\n- 审查：Claude 审查员一轮\n");
    expect(owesAdversarial(policy(), events(), round())).toBe(true);
    expect((await run("agent-disp", ...verdict("pass", "merge"))).code).toBe("conflict");
    const d = await run("agent-disp", "dispatch", "T1");
    expect(d.event.data).toMatchObject({ reviewer: "adversarial" });
    expect(d.event.data.policy).toContain("对抗");
    expect((await run("agent-disp", ...verdict("pass", "merge"))).task.stage).toBe("merge");
  });

  test("规格卡被删掉：派审记录里记过要对抗式，闸门照样拦", async () => {
    await regularPassAfterAdvDispatchPolicy();
    unlinkSync(join(docs, "tasks", "T1.md"));
    expect((await run("agent-disp", ...verdict("pass", "merge"))).code).toBe("conflict");
    expect(handler()?.role).toBe("dispatcher");
  });
});
