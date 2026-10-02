/**
 * pmem-M2：record_memory / mark_memory / show_memory 与 deliver.memoryRefs 走完整管道——bridge handler（lib/memory-tools.ts）→ 写台账出口
 * （order-ledger-exit.ts）→ `ledger memory-record / memory-mark / memory-refs`（manager 一侧按频道认 actor、认票据与会话，再重算角色）。
 * 出口用进程内的 runLedger 代替子进程（同 tests/review-tools.test.ts）。验收线 1（身份只取 verified 会话）、4（wrong 自动转争议）在这里。
 */
import type { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { listMarks, memoryState, recordMemory } from "../src/lib/ledger-memory.js";
import { closeLedger, listEvents, openLedger } from "../src/lib/ledger-store.js";
import { assignStep } from "../src/lib/ledger-steps-write.js";
import { createTask, deliver, setMeta, setTask } from "../src/lib/ledger-write.js";
import { LEND_MCP_TOOLS } from "../src/lib/lend-mcp-profile.js";
import { routeLendTool } from "../src/lib/lend-tools.js";
import { memoryToolHandlers, memoryRole } from "../src/lib/memory-tools.js";
import { withMemoryRefs } from "../src/lib/memory-tools-refs.js";
import type { LedgerRun } from "../src/lib/order-ledger-exit.js";
import type { VerifiedCall } from "../src/lib/order-tool-route.js";
import { isOrderTool, ORDER_TOOLS } from "../src/lib/order-tools.js";
import { resolveActor } from "../src/manager/ledger-identity.js";
import { runLedger } from "../src/manager/ledger.js";

const P = "demo";
const H1 = "c".repeat(40);
const OWNER = { actor: "owner", now: 1_000 };
const agents: Record<string, { channelId: string; sessionId: string; runtime: string }> = {
  "agent-x": { channelId: "ch-x", sessionId: "sx", runtime: "claude-code" },
  "agent-y": { channelId: "ch-y", sessionId: "sy", runtime: "codex" },
  "agent-pm": { channelId: "ch-pm", sessionId: "spm", runtime: "claude-code" },
};
let db: Database, dir: string, runs: string[][], now: number;

const run: LedgerRun = async (args, channelId) => {
  runs.push(args);
  const who = resolveActor({ channelId }, agents);
  if (!who.ok) return { ok: false, code: "forbidden", error: who.error };
  return cli(args.slice(1), who.actor);
};
const cli = (args: string[], actor: string) => runLedger(args, { db, actor, projectIds: [P], loadRegistry: async () => ({ socket: "", agents }) as never,
  saveRegistry: async () => {}, now: () => now });
const tools = () => memoryToolHandlers(run, () => db);
const X: VerifiedCall = { agent: "agent-x", sessionId: "sx", family: "claude-code", channelId: "ch-x" };
const Y: VerifiedCall = { agent: "agent-y", sessionId: "sy", family: "codex", channelId: "ch-y" };
const PM: VerifiedCall = { agent: "agent-pm", sessionId: "spm", family: "claude-code", channelId: "ch-pm" };
const PIT = { v: 1, kind: "pitfall", title: "事务回调里不能 await", symptom: "事务提前提交，后半段写丢", rule: "事务内只做同步写，异步放事务外",
  files: ["src/lib/widget-store.ts"], family: "widget-tx", fixable: true };
const WRITE_ORDER = "T60:write:r0";
const REVIEW_ORDER = "T61:review:r1";

beforeEach(() => {
  runs = [];
  now = 5_000;
  dir = mkdtempSync(join(tmpdir(), "pmem-m2-"));
  db = openLedger(join(dir, "ledger.sqlite"));
  db.prepare("INSERT INTO ledger_instance (key, value) VALUES ('origin', 'ab12')").run();
  setMeta(db, OWNER, { project: P, key: "pms", value: ["agent-pm"] });
  // T60：agent-x 在写（build）；T61：agent-x 交了，agent-y 在审
  for (const id of ["T60", "T61"]) {
    createTask(db, OWNER, { project: P, id, title: id, kind: "code" });
    setTask(db, OWNER, { id, rev: 1, patch: { agent: "agent-x" } });
    assignStep(db, { actor: "agent-pm", now: 1_100 }, { taskId: id, step: "write", executor: "agent-x", executorKind: "agent" });
    db.run(`UPDATE tasks SET stage = 'build', headSHA = '${H1}' WHERE id = '${id}'`);
  }
  deliver(db, { actor: "agent-x", now: 1_200 }, { taskId: "T61", headSHA: H1, moveFrom: "build" });
  assignStep(db, { actor: "agent-pm", now: 1_300 }, { taskId: "T61", step: "review", executor: "agent-y", executorKind: "agent" });
});
afterEach(() => {
  closeLedger(join(dir, "ledger.sqlite"));
  rmSync(dir, { recursive: true, force: true });
});

describe("登记", () => {
  test("三个工具在 channel-server 的派单工具表里；deliver 带 memoryRefs、submit_verdict 的 finding 带 pitfall", () => {
    for (const n of ["record_memory", "mark_memory", "show_memory"]) expect(isOrderTool(n)).toBe(true);
    const props = (n: string) => (ORDER_TOOLS.find((t) => t.name === n)!.inputSchema as { properties: Record<string, any> }).properties;
    expect(props("deliver").memoryRefs.items.properties.use.enum).toEqual(["applied", "irrelevant", "wrong"]);
    expect(props("submit_verdict").findings.items.properties.pitfall.type).toBe("boolean");
  });
});

describe("验收线 1：身份只取已验证会话", () => {
  test("执行者带当前写单 → executor、锚本卡、candidate；来源 = 卡上最近的事件；actor 来自频道", async () => {
    const r = await tools().record_memory!(X, { ...PIT, orderId: WRITE_ORDER });
    expect(r).toMatchObject({ ok: true, role: "executor", status: "candidate", memoryId: "ab12-m1" });
    const s = memoryState(db, "ab12-m1")!;
    expect(s.memory).toMatchObject({ author: "agent-x", authorRole: "executor", taskId: "T60", head: H1, specRev: 1, via: "tool" });
    expect(s.memory.sources.length).toBe(1);
    expect(runs[0]!.slice(0, 2)).toEqual(["ledger", "memory-record"]);
  });

  test("审查员带当前审查单 → reviewer、直接 open", async () => {
    const r = await tools().record_memory!(Y, { ...PIT, orderId: REVIEW_ORDER });
    expect(r).toMatchObject({ ok: true, role: "reviewer", status: "open" });
  });

  test("参数里自报身份（actor / role / author / authorRole）一律拒，什么都没写", async () => {
    for (const k of ["actor", "role", "author", "authorRole"]) {
      const r = await tools().record_memory!(X, { ...PIT, orderId: WRITE_ORDER, [k]: "pm" });
      expect(r).toMatchObject({ ok: false, code: "invalid_wire" });
    }
    expect(await tools().mark_memory!(X, { v: 1, memoryId: "ab12-m1", mark: "confirm", actor: "owner" })).toMatchObject({ ok: false, code: "invalid_wire" });
    expect(runs).toEqual([]);
  });

  test("别人的单号认不成执行者 / 审查员", async () => {
    expect(await tools().record_memory!(Y, { ...PIT, orderId: WRITE_ORDER })).toMatchObject({ ok: false, code: "forbidden" });
    expect(await tools().record_memory!(X, { ...PIT, orderId: REVIEW_ORDER })).toMatchObject({ ok: false, code: "forbidden" });
  });

  test("CLI 不带票据：执行者在 Bash 里跑认不成执行者；自带 --session 不认；伪造票据拒", async () => {
    const wire = JSON.stringify({ ...PIT, v: undefined, orderId: WRITE_ORDER });
    expect(await cli(["memory-record", `--wire=${wire}`], "agent-x")).toMatchObject({ ok: false, code: "forbidden" });
    expect(await cli(["memory-record", `--wire=${wire}`, "--session=sx", "--family=claude-code"], "agent-x")).toMatchObject({ ok: false, code: "forbidden" });
    expect(await cli(["memory-record", `--wire=${wire}`, "--session=sx", "--family=claude-code", "--ticket-file=/nonexistent", "--ticket=00"], "agent-x"))
      .toMatchObject({ ok: false, code: "forbidden" });
    expect(listEvents(db, { project: P }).filter((e) => e.kind === "memory")).toEqual([]);
  });

  test("票据核过但会话不是 registry 当前会话 → 拒（会话换过）", async () => {
    const stale: VerifiedCall = { ...X, sessionId: "old" };
    expect(await tools().record_memory!(stale, { ...PIT, orderId: WRITE_ORDER })).toMatchObject({ ok: false, code: "forbidden" });
  });

  test("CLI 不带票据：PM / owner 照常（项目级）；不在 PM 名单的 agent 拒", async () => {
    const wire = JSON.stringify({ ...PIT, project: P });
    expect(await cli(["memory-record", `--wire=${wire}`], "agent-pm")).toMatchObject({ ok: true, role: "pm", status: "open" });
    expect(await cli(["memory-record", `--wire=${JSON.stringify({ ...PIT, title: "另一条：迁移逐条 prepare", family: "mig" , project: P })}`], "owner"))
      .toMatchObject({ ok: true, role: "owner" });
    expect(await cli(["memory-record", `--wire=${JSON.stringify({ ...PIT, family: "zz", project: P })}`], "agent-x")).toMatchObject({ ok: false, code: "forbidden" });
  });

  test("memoryRole：未验证调用方带单号也认不成执行者", () => {
    expect(memoryRole(db, { actor: "agent-x", sessionId: "sx", family: "claude-code", verified: false }, { orderId: WRITE_ORDER }).ok).toBe(false);
    expect(memoryRole(db, { actor: "agent-x", sessionId: "sx", family: "claude-code", verified: true }, { orderId: WRITE_ORDER })).toMatchObject({ ok: true, role: "executor" });
  });

  test("同一参数重试：回已写的那条（duplicate），不长第二条", async () => {
    await tools().record_memory!(X, { ...PIT, orderId: WRITE_ORDER });
    const again = await tools().record_memory!(X, { ...PIT, orderId: WRITE_ORDER });
    expect(again).toMatchObject({ ok: true, duplicate: true, memoryId: "ab12-m1" });
    expect(db.query("SELECT COUNT(*) AS n FROM memories").get()).toEqual({ n: 1 });
  });

  test("memoryLint 拒绝原样回给调用方（带第几条）", async () => {
    const r = await tools().record_memory!(X, { ...PIT, orderId: WRITE_ORDER, title: "已完成 widget 批量写" });
    expect(r).toMatchObject({ ok: false, code: "invalid" });
    expect((r as { error: string }).error).toContain("第 1 条");
  });
});

describe("mark_memory / show_memory", () => {
  test("PM confirm 执行者的候选 → open；show_memory 带全文与 marks 历史", async () => {
    await tools().record_memory!(X, { ...PIT, orderId: WRITE_ORDER });
    expect(await tools().mark_memory!(PM, { v: 1, memoryId: "ab12-m1", mark: "confirm" })).toMatchObject({ ok: true, status: "open" });
    const s = await tools().show_memory!(X, { v: 1, id: "ab12-m1" });
    expect(s).toMatchObject({ ok: true, status: "open", memory: { body: { rule: PIT.rule } }, marks: [{ mark: "confirm", actor: "agent-pm" }] });
    expect(await tools().show_memory!(X, { v: 1, id: "ab12-m9" })).toMatchObject({ ok: false, code: "not_found" });
  });

  test("审查员带审查单可以 confirm 坑；不带单号认不出角色", async () => {
    await tools().record_memory!(X, { ...PIT, orderId: WRITE_ORDER });
    expect(await tools().mark_memory!(Y, { v: 1, memoryId: "ab12-m1", mark: "confirm" })).toMatchObject({ ok: false, code: "forbidden" });
    expect(await tools().mark_memory!(Y, { v: 1, memoryId: "ab12-m1", mark: "confirm", orderId: REVIEW_ORDER })).toMatchObject({ ok: true, status: "open" });
  });

  test("fixed / reopen 工具层就拒（只有调度器）", async () => {
    for (const mark of ["fixed", "reopen"]) {
      const r = await tools().mark_memory!(PM, { v: 1, memoryId: "ab12-m1", mark, taskId: "T60" });
      expect(r).toMatchObject({ ok: false, code: "invalid_wire" });
      expect((r as { error: string }).error).toContain("只有调度器");
    }
  });

  test("CLI 终端写法 --mark / --reason 与工具同一套权限", async () => {
    await tools().record_memory!(X, { ...PIT, orderId: WRITE_ORDER });
    expect(await cli(["memory-mark", "ab12-m1", "--mark", "dispute", "--reason", "规矩写反了"], "owner")).toMatchObject({ ok: true, disputed: true });
    expect(await cli(["memory-mark", "ab12-m1", "--mark", "supersede", "--by", "ab12-m1"], "agent-x")).toMatchObject({ ok: false, code: "forbidden" });
    expect(await cli(["memory-show", "ab12-m1"], "owner")).toMatchObject({ ok: true, disputed: true });
  });
});

describe("出借档不开放 show_memory（PM 定 lend-memory-read）", () => {
  test("lend 档白名单里没有三个记忆工具；出借 worker 调 show_memory 被 lend 路由拒", async () => {
    for (const n of ["record_memory", "mark_memory", "show_memory"]) expect(LEND_MCP_TOOLS.has(n)).toBe(false);
    const r = await routeLendTool("show_memory", { agent: "agent-lend-abc", sessionId: "s", family: "claude-code", verified: true } as never, { v: 1, id: "ab12-m1" },
      { db: null, call: (async () => ({ ok: false })) as never, log: () => {}, now: () => 0 });
    expect(r.ok).toBe(false);
  });
});

describe("验收线 4：deliver.memoryRefs 标 wrong 自动转为争议", () => {
  const delivered = () => deliver(db, { actor: "agent-x", now: 1_400, dedupKey: `mcp-deliver:${WRITE_ORDER}:${H1}` }, { taskId: "T60", headSHA: H1, moveFrom: "build" });
  const pmPit = () => recordMemory(db, { actor: "agent-pm", now: 1_000 }, { ...PIT, project: P, via: "tool", authorRole: "pm", fixable: true } as never);

  test("交付成功后：整份 refs 记一条 memory 事件；wrong → dispute（reason = note，source = 那条事件），不再进单子", async () => {
    pmPit();
    delivered();
    const refs = [{ id: "ab12-m1", use: "wrong" as const, note: "这里的事务是 IMMEDIATE，不受影响" }, { id: "ab12-m7", use: "applied" as const }];
    const r = await withMemoryRefs({ ok: true, orderId: WRITE_ORDER }, X, run, WRITE_ORDER, H1, refs);
    expect(r).toMatchObject({ ok: true, memoryRefs: { ok: true, disputed: ["ab12-m1"], unknown: [] } });
    expect(memoryState(db, "ab12-m1")).toMatchObject({ status: "open", disputed: true });
    const [m] = listMarks(db, "ab12-m1");
    expect(m).toMatchObject({ mark: "dispute", actor: "agent-x", reason: refs[0]!.note });
    expect(m!.dedupKey).toStartWith("auto:dispute:ab12-m1:T60:");
    const ev = listEvents(db, { project: P, target: "T60" }).find((e) => e.kind === "memory" && e.data.op === "refs");
    expect(ev?.data.refs).toEqual(refs);
    // 重试（含 deliver 重放）不重记
    await withMemoryRefs({ ok: true }, X, run, WRITE_ORDER, H1, refs);
    expect(listMarks(db, "ab12-m1").length).toBe(1);
  });

  test("没有这次交付、或交付不是调用方记的 → 拒；交付被拒时不补记", async () => {
    pmPit();
    const refs = [{ id: "ab12-m1", use: "wrong" as const, note: "x" }];
    expect(await withMemoryRefs({ ok: true }, X, run, WRITE_ORDER, H1, refs)).toMatchObject({ memoryRefs: { ok: false } });
    delivered();
    expect(await withMemoryRefs({ ok: true }, Y, run, WRITE_ORDER, H1, refs)).toMatchObject({ memoryRefs: { ok: false } });
    expect(await withMemoryRefs({ ok: false, code: "x", error: "y" }, X, run, WRITE_ORDER, H1, refs)).toEqual({ ok: false, code: "x", error: "y" });
    expect(listMarks(db, "ab12-m1")).toEqual([]);
  });
});

describe("pmem-M2 r1 审查修复：memoryRefs 项目边界 / 重放一致 / mark 重试判断", () => {
  const delivered = () => deliver(db, { actor: "agent-x", now: 1_400, dedupKey: `mcp-deliver:${WRITE_ORDER}:${H1}` }, { taskId: "T60", headSHA: H1, moveFrom: "build" });
  const pit = (project: string, title = PIT.title) =>
    recordMemory(db, { actor: "agent-pm", now: 1_000 }, { ...PIT, title, project, via: "tool", authorRole: "pm", fixable: true } as never).memory.id;

  test("refs-project：引用别的项目的记忆 → 整份拒，不落 refs 事件、不标争议", async () => {
    setMeta(db, OWNER, { project: "beta", key: "pms", value: ["agent-pm"] });
    const foreign = pit("beta");
    delivered();
    const r = await withMemoryRefs({ ok: true }, X, run, WRITE_ORDER, H1, [{ id: foreign, use: "wrong", note: "借交付标别处的记忆" }]);
    expect(r).toMatchObject({ ok: true, memoryRefs: { ok: false } });
    expect((r as { memoryRefs?: { error: string } }).memoryRefs?.error).toContain("不在这次交付的项目");
    expect(memoryState(db, foreign)).toMatchObject({ disputed: false });
    expect(listMarks(db, foreign)).toEqual([]);
    expect(listEvents(db, { project: P, target: "T60" }).some((e) => e.kind === "memory" && e.data.op === "refs")).toBe(false);
  });

  test("refs-replay：同一次交付换一份 refs 再来 → 拒，不追加 dispute；同一份重来只按已落的那份补齐", async () => {
    const m1 = pit(P), m2 = pit(P, "另一条坑：迁移语句逐条执行");
    delivered();
    const first = [{ id: m1, use: "applied" as const }];
    expect(await withMemoryRefs({ ok: true }, X, run, WRITE_ORDER, H1, first)).toMatchObject({ memoryRefs: { ok: true, disputed: [] } });
    const changed = await withMemoryRefs({ ok: true }, X, run, WRITE_ORDER, H1, [{ id: m2, use: "wrong", note: "改过的参数" }]);
    expect(changed).toMatchObject({ memoryRefs: { ok: false } });
    expect(listMarks(db, m2)).toEqual([]);
    expect(await withMemoryRefs({ ok: true }, X, run, WRITE_ORDER, H1, first)).toMatchObject({ memoryRefs: { ok: true } });
    expect(listEvents(db, { project: P, target: "T60" }).filter((e) => e.kind === "memory" && e.data.op === "refs").length).toBe(1);
  });

  test("mark-reconfirm：PM confirm → 执行者 dispute → 同一 PM 再 confirm 清争议；紧接着的同内容重试才是 duplicate", async () => {
    await tools().record_memory!(X, { ...PIT, orderId: WRITE_ORDER });
    now = 2_200;
    expect(await tools().mark_memory!(PM, { v: 1, memoryId: "ab12-m1", mark: "confirm" })).toMatchObject({ ok: true, disputed: false });
    now = 2_300;
    expect(await tools().mark_memory!(X, { v: 1, memoryId: "ab12-m1", mark: "dispute", reason: "规矩写反了", orderId: WRITE_ORDER }))
      .toMatchObject({ ok: true, disputed: true });
    now = 2_400;
    expect(await tools().mark_memory!(PM, { v: 1, memoryId: "ab12-m1", mark: "confirm" })).toMatchObject({ ok: true, duplicate: false, disputed: false });
    now = 2_500;
    expect(await tools().mark_memory!(PM, { v: 1, memoryId: "ab12-m1", mark: "confirm" })).toMatchObject({ ok: true, duplicate: true, disputed: false });
    expect(listMarks(db, "ab12-m1").map((m) => [m.actor, m.mark, m.ts])).toEqual([
      ["agent-pm", "confirm", 2_200], ["agent-x", "dispute", 2_300], ["agent-pm", "confirm", 2_400]]);
  });
});

describe("pmem-M2 r2 审查修复：refs 先校验再落 / record 重试只认同内容", () => {
  const delivered = () => deliver(db, { actor: "agent-x", now: 1_400, dedupKey: `mcp-deliver:${WRITE_ORDER}:${H1}` }, { taskId: "T60", headSHA: H1, moveFrom: "build" });
  const pit = () => recordMemory(db, { actor: "agent-pm", now: 1_000 }, { ...PIT, project: P, via: "tool", authorRole: "pm", fixable: true } as never).memory.id;
  const refsEvents = () => listEvents(db, { project: P, target: "T60" }).filter((e) => e.kind === "memory" && e.data.op === "refs");
  const SECRET = "ghp_" + "a".repeat(36); // 合成串，只为命中脱敏闸

  test("refs-secret：wrong 的 note 命中脱敏闸 → 整份拒，不落原文、不占幂等键；改成普通 note 重交照常转争议", async () => {
    const m1 = pit();
    delivered();
    const bad = await withMemoryRefs({ ok: true }, X, run, WRITE_ORDER, H1, [{ id: m1, use: "wrong", note: SECRET }]);
    expect(bad).toMatchObject({ ok: true, memoryRefs: { ok: false } });
    expect((bad as { memoryRefs?: { error: string } }).memoryRefs?.error).toContain("脱敏闸");
    expect(refsEvents()).toEqual([]);
    expect(JSON.stringify(listEvents(db, { project: P }))).not.toContain(SECRET);
    expect(memoryState(db, m1)).toMatchObject({ disputed: false });
    const fixed = await withMemoryRefs({ ok: true }, X, run, WRITE_ORDER, H1, [{ id: m1, use: "wrong", note: "该规矩需要修正" }]);
    expect(fixed).toMatchObject({ memoryRefs: { ok: true, disputed: [m1] } });
    expect(memoryState(db, m1)).toMatchObject({ disputed: true });
    expect(refsEvents().length).toBe(1);
  });

  test("refs-secret：applied / irrelevant 的 note 命中脱敏闸也整份拒（note 随 refs 事件落库）", async () => {
    const m1 = pit();
    delivered();
    const bad = await withMemoryRefs({ ok: true }, X, run, WRITE_ORDER, H1, [{ id: m1, use: "applied", note: SECRET }]);
    expect(bad).toMatchObject({ memoryRefs: { ok: false } });
    expect(refsEvents()).toEqual([]);
  });

  test("refs-secret：wrong 转争议被拒（如 note 含本项目内部名字）→ refs 事件一并回滚，不留部分成功", async () => {
    const m1 = pit();
    delivered();
    db.run(`INSERT INTO features (id, project, title, status, createdBy, createdAt, updatedAt) VALUES ('F1', '${P}', '小部件存储重构', 'active', 'owner', 1, 1)`);
    const bad = await withMemoryRefs({ ok: true }, X, run, WRITE_ORDER, H1, [{ id: m1, use: "wrong", note: "小部件存储重构里不是这样" }]);
    expect(bad).toMatchObject({ memoryRefs: { ok: false } });
    expect(refsEvents()).toEqual([]);
    expect(listMarks(db, m1)).toEqual([]);
  });

  test("record-retry：同作者同标题、同 family 有交集但正文不同 → 回 lint 拒绝（不当重试吞掉），库里正文不变", async () => {
    const rec = (extra: Record<string, unknown> = {}) => cli(["memory-record", `--wire=${JSON.stringify({ ...PIT, project: P, ...extra })}`], "agent-pm");
    expect(await rec()).toMatchObject({ ok: true, memoryId: "ab12-m1", status: "open" });
    const changed = await rec({ rule: "必须等待所有异步写完成" });
    expect(changed).toMatchObject({ ok: false });
    expect(JSON.stringify(changed)).toContain("ab12-m1");
    expect(memoryState(db, "ab12-m1")!.memory.body).toMatchObject({ rule: PIT.rule });
    // 完整同内容同锚点 → 才是重试
    expect(await rec()).toMatchObject({ ok: true, duplicate: true, memoryId: "ab12-m1" });
  });
});
