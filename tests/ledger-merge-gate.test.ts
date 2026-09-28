/**
 * 「还欠不欠对抗式」按轮次 + head 绑定（src/lib/ledger-handler.ts owesAdversarial / nextAfterReview）与 `review --to merge` 闸门、
 * PM 的 --waive adversarial（src/manager/ledger-field-checks.ts、ledger-write-cmds.ts）：
 * 上一轮的派审顶不了这一轮、派审之后换了 head 不算审过、对抗式 pass 只对它审的那个 head 有效。
 */
import type { Database } from "bun:sqlite";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, test } from "bun:test";
import { currentHandler, owesAdversarial } from "../src/lib/ledger-handler.js";
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
/** 执行者交付 sha；from = build / fix 时同时推进 review（新一轮），不带 = 在 review 里重新交付 */
const ship = (sha: string, from?: "build" | "fix") => {
  head = sha;
  deliver(db, { actor: "agent-exec", now: 2 }, { taskId: "T1", headSHA: sha, moveFrom: from });
};
const events = () => listEvents(db, { target: "T1" });
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
  ship("aaaa1111", "build");
});

describe("派审记录按轮次 + head 绑定", () => {
  test("S1：上一轮的对抗式派审顶不了这一轮没派审的 pass（归调度助理，--to merge 被拒）", async () => {
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

  test("S2：同一轮派了对抗式之后在 review 里重新交付了新 head，没审过的 head 不能 --to merge", async () => {
    await run("agent-disp", "dispatch", "T1", "--adversarial");
    ship("cccc3333");
    expect((await run("agent-disp", ...verdict("pass", "merge"))).code).toBe("conflict");
    // 对新 head 重新派对抗式，判通过就放行
    expect((await run("agent-disp", "dispatch", "T1", "--adversarial")).event.data.head).toBe("cccc3333");
    expect((await run("agent-disp", ...verdict("pass", "merge"))).task.stage).toBe("merge");
  });

  test("S3：对抗式 pass 只对它审的 head 有效：合并后退回 fix、交付新 head，常规 pass 不能 --to merge", async () => {
    await run("agent-disp", "dispatch", "T1", "--adversarial");
    expect((await run("agent-disp", ...verdict("pass", "merge"))).task.stage).toBe("merge");
    expect(owesAdversarial(policy(), events())).toBe(false);
    moveStage(db, o, { taskId: "T1", from: "merge", to: "fix" });
    ship("dddd4444", "fix");
    expect(owesAdversarial(policy(), events())).toBe(true);
    await run("agent-disp", "dispatch", "T1");
    expect((await run("agent-disp", ...verdict("pass", "merge"))).code).toBe("conflict");
    // task-set 换 head 也算换了：执行者改 --head 不能继承旧的对抗式 pass
    await run("agent-disp", "dispatch", "T1", "--adversarial");
    await run("agent-disp", ...verdict("pass"));
    expect(owesAdversarial(policy(), events())).toBe(false);
    await run("agent-exec", "task-set", "T1", "--rev", String(getTask(db, "T1")?.rev), "--head", "eeee5555");
    expect(owesAdversarial(policy(), events())).toBe(true);
  });
});

describe("PM 豁免：review --waive adversarial --text <理由>", () => {
  test("只有 PM（调度助理除外）能用，要 pass、要理由；记进事件，只对当前 head 有效", async () => {
    await run("agent-disp", "dispatch", "T1", "--adversarial");
    await run("agent-disp", ...verdict("pass"));
    ship("ffff6666");
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
    expect(owesAdversarial(policy(), events())).toBe(true);
  });

  test("豁免之后路由判审查走完（归 PM）", async () => {
    await run("agent-disp", "dispatch", "T1");
    await run("agent-pm", ...verdict("pass", undefined, "--waive", "adversarial", "--text", "PM 决定不跑对抗式"));
    expect(handler()?.role).toBe("pm");
  });
});

describe("规格卡读不出审查策略", () => {
  test("S4：审查写在行中间、写成粗体都读得出，要对抗式", async () => {
    for (const card of ["- runtime：Claude Code，Opus 5.5，effort high。审查：Claude 审查员一轮；最后一轮对抗式。", "- **审查**：常规一轮；最后一轮对抗式"]) {
      spec(`# T1\n${card}\n`);
      expect(policy()).toContain("对抗");
    }
    await run("agent-disp", "dispatch", "T1");
    expect((await run("agent-disp", ...verdict("pass", "merge"))).code).toBe("conflict");
  });

  test("提到对抗式却读不出「审查：」= 不知道：归调度助理，--to merge 被拒；找不到规格卡不拦", async () => {
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
