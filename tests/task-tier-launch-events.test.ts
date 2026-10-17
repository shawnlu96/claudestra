/**
 * TIER3 启动事实（src/lib/task-tier-launch-events.ts）经真实的 create 包装（cardRoleCreate）落到临时台账：每次尝试一行
 * （角色、类型、家族、轮次、启动标识、建议值、最终参数、来源），create 失败 / 被拒单列 failed，会话证实后 bound；实际没被运行时证实就是 unknown。
 * 记成项目级 note（卡自己的事件流不多一条）；调度器手里是只读连接也记得上（走同一文件的可写连接）；卡不在这本台账不记。create 是替身，不调真实模型。
 */
import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyCardRole, cardRoleCreate } from "../src/lib/card-role-definitions.js";
import { extractEffortFlag, extractModelFlag } from "../src/manager/core.js";
import { parseCreateArgs } from "../src/manager/create-args.js";
import { closeLedger, openLedger } from "../src/lib/ledger-store.js";
import { createTask } from "../src/lib/ledger-write.js";
import { useRoleModelPort } from "../src/lib/role-model-settings-local.js";
import { defaultRoleModels } from "../src/lib/role-model-settings.js";
import { bindLaunchSession, taskTierLaunchHistory } from "../src/lib/task-tier-launch-events.js";
import { bindTierSession, useTaskTierPort, type TierLaunchCtx } from "../src/lib/task-tier-models.js";

const cleanups: (() => void)[] = [];
afterEach(() => { useTaskTierPort(); useRoleModelPort(); for (const c of cleanups.splice(0)) c(); });

function ledger(): { path: string; db: Database } {
  const dir = mkdtempSync(join(tmpdir(), "tier3-facts-"));
  const path = join(dir, "ledger.sqlite"), db = openLedger(path);
  cleanups.push(() => { closeLedger(path); rmSync(dir, { recursive: true, force: true }); });
  createTask(db, { actor: "owner" }, { id: "T1", project: "p1", title: "demo", kind: "code" });
  useTaskTierPort({ policy: () => ({ mode: "on", manualAfterMs: null, source: "config" }), read: () => ({ status: "missing", table: defaultRoleModels() }) });
  useRoleModelPort({ policy: () => ({ mode: "observe", manualAfterMs: null, source: "config" }), read: () => ({ status: "missing", table: defaultRoleModels() }), observe: () => undefined });
  return { path, db };
}
const ctx = (db: Database, tier: string, extra: Partial<TierLaunchCtx> = {}): TierLaunchCtx => ({ db, project: "p1", card: "T1", tier, round: 2, ...extra });
const author = (...extra: string[]) => ["create", "t1", "/w", "--purpose", "T1", "--task", "T1", "--card", "T1", "--card-role", "author", "--effort", "high", "--project", "p1", ...extra];
const CODEX = ["--runtime", "codex", "--transport", "acp"];
type Create = (...a: string[]) => Promise<Record<string, unknown>>;
const ok: Create = async () => ({ ok: true });

describe("[验收线 3] 成功 / 失败 / unknown 可追溯", () => {
  test("成功：attempt 带全字段，会话证实后 bound；actual 没被运行时证实 = unknown（不拿 argv 冒充）", async () => {
    const { db } = ledger();
    const sent: string[][] = [];
    const r = await cardRoleCreate<Create>(async (...a) => (sent.push(a), { ok: true }), { tier: ctx(db, "ui") })(...author());
    expect(r).toEqual({ ok: true });
    const [f] = taskTierLaunchHistory(db, "p1", "T1");
    expect(f).toMatchObject({ status: "attempted", sessionId: null, actual: { model: null, effort: null, source: "unknown" },
      plan: { project: "p1", card: "T1", role: "author", tier: "ui", family: "claude", round: 2, agent: "t1", suggested: "claude-sonnet-5-5",
        final: { model: "claude-sonnet-5-5", effort: null }, source: "tier-default", launchId: expect.stringMatching(/^T1:author:r2:[0-9a-f]{8}$/) } });
    expect(sent[0][sent[0].indexOf("--model") + 1]).toBe(f.plan.final.model!);
    bindTierSession(db, { project: "p1", id: "T1" }, "agent-t1", "sess-1", "author"); // registry 全名多一层 agent-
    expect(taskTierLaunchHistory(db, "p1", "T1")).toEqual([expect.objectContaining({ status: "bound", sessionId: "sess-1", actual: { model: null, effort: null, source: "unknown" } })]);
    expect(bindLaunchSession(db, { project: "p1", card: "T1", role: "author", agent: "t1", sessionId: "sess-2" })).toBe(false); // 已绑过不再绑
  });

  test("运行时证实的 actual 照记；Codex 尝试记最终 --effort", async () => {
    const { db } = ledger();
    await cardRoleCreate(ok, { tier: ctx(db, "ui", { baseEffort: "high" }) })(...author(), ...CODEX);
    const [f] = taskTierLaunchHistory(db, "p1", "T1");
    expect(f.plan).toMatchObject({ family: "codex", suggested: "medium", final: { model: null, effort: "medium" } });
    bindLaunchSession(db, { project: "p1", card: "T1", role: "author", agent: "t1", sessionId: "s", actual: { model: null, effort: "medium", source: "suggest" } });
    expect(taskTierLaunchHistory(db, "p1", "T1")[0].actual).toEqual({ model: null, effort: "medium", source: "suggest" });
  });

  test("失败单列：create 没成记 failed 带原因；被下限拒的也记，且 create 没被调用", async () => {
    const { db } = ledger();
    let calls = 0;
    const fail: Create = async () => (calls++, { ok: false, error: "Selected model is at capacity." });
    await cardRoleCreate(fail, { tier: ctx(db, "code") })(...author());
    const refused = await cardRoleCreate(fail, { tier: ctx(db, "security") })(...author("--model", "claude-sonnet-5-5"));
    expect(refused).toMatchObject({ ok: false, error: expect.stringContaining("不得低于 Opus") });
    expect(calls).toBe(1);
    const h = taskTierLaunchHistory(db, "p1", "T1");
    expect(h.map((f) => [f.plan.tier, f.status, f.reason])).toEqual([
      ["code", "failed", "Selected model is at capacity."], ["security", "failed", expect.stringContaining("不得低于 Opus")]]);
    expect(h[1].plan).toMatchObject({ source: "explicit", final: { model: "claude-sonnet-5-5" } });
    bindTierSession(db, { project: "p1", id: "T1" }, "t1", "late", "author");
    expect(taskTierLaunchHistory(db, "p1", "T1").every((f) => f.status === "failed")).toBe(true); // 失败的不被后来的会话翻案
  });

  test("create 抛错：记 failed（结果不明 + 原因），异常照旧抛出；之后同名会话不会被绑到这次尝试", async () => {
    const { db } = ledger();
    const boom: Create = async () => { throw new Error("create transport failed"); };
    await expect(cardRoleCreate(boom, { tier: ctx(db, "code") })(...author())).rejects.toThrow("create transport failed");
    const h = taskTierLaunchHistory(db, "p1", "T1");
    expect(h.map((f) => [f.status, f.reason])).toEqual([["failed", expect.stringContaining("结果不明：create transport failed")]]);
    bindTierSession(db, { project: "p1", id: "T1" }, "t1", "other", "author");
    expect(taskTierLaunchHistory(db, "p1", "T1").map((f) => f.status)).toEqual(["failed"]);
  });

  test("调度器的只读连接也记得上；卡不在这本台账不记；卡的事件流不多一条", async () => {
    const { path, db } = ledger();
    const before = db.query("SELECT COUNT(*) AS n FROM events WHERE target = 'T1'").get() as { n: number };
    const ro = new Database(path, { readonly: true });
    cleanups.push(() => ro.close());
    await cardRoleCreate(ok, { tier: ctx(ro, "code") })(...author());
    expect(taskTierLaunchHistory(db, "p1", "T1").length).toBe(1);
    await cardRoleCreate(ok, { tier: { ...ctx(db, "code"), card: "NOPE" } })(...author().map((a) => (a === "T1" ? "NOPE" : a)));
    expect(taskTierLaunchHistory(db, "p1", "NOPE")).toEqual([]);
    expect(db.query("SELECT COUNT(*) AS n FROM events WHERE target = 'T1'").get()).toEqual(before);
  });
});

describe("[验收线 2] 最终启动参数按启动器口径核验 security 下限（重复参数、已装饰 argv）", () => {
  const reviewer = (...extra: string[]) => ["create", "rv", "/w", "--purpose", "T1 审查", "--task", "T1 审查", "--card", "T1", "--card-role", "reviewer", "--project", "p1", ...extra];
  const counting = () => { const seen: string[][] = []; const create: Create = async (...a) => (seen.push(a), { ok: true }); return { seen, create }; };

  test("security Claude：--model Opus 后再跟 --model=Sonnet（启动器取最后一个）= 拒绝、记 failed、不调 create", async () => {
    const { db } = ledger();
    const { seen, create } = counting();
    const r = await cardRoleCreate(create, { tier: ctx(db, "security") })(...author("--model", "claude-opus-5-5", "--model=claude-sonnet-5-5"));
    expect(r).toMatchObject({ ok: false, error: expect.stringContaining("--model 出现了 2 次") });
    expect(seen).toEqual([]);
    expect(extractModelFlag(author("--model", "claude-opus-5-5", "--model=claude-sonnet-5-5")).model).toBe("claude-sonnet-5-5"); // 启动器口径
    expect(taskTierLaunchHistory(db, "p1", "T1").map((f) => f.status)).toEqual(["failed"]);
  });

  test("security Codex 审查员（原格 xhigh）：--effort xhigh 后再跟 --effort=low = 拒绝、不调 create", async () => {
    const { db } = ledger();
    const t = defaultRoleModels(); t.roles.reviewer = { claude: "claude-opus-5-5", codex: "xhigh" };
    useTaskTierPort({ policy: () => ({ mode: "on", manualAfterMs: null, source: "config" }), read: () => ({ status: "ok", table: t }) });
    const { seen, create } = counting();
    const r = await cardRoleCreate(create, { tier: ctx(db, "security") })(...reviewer(...CODEX, "--effort", "xhigh", "--effort=low"));
    expect(r).toMatchObject({ ok: false, error: expect.stringContaining("--effort 出现了 2 次") });
    expect(seen).toEqual([]);
    expect(extractEffortFlag(reviewer("--effort", "xhigh", "--effort=low")).effort).toBe("low");
  });

  test("已装饰的 argv（旧包装加过 Sonnet）再带 security 上下文：去重不跳核验，拒绝；已装饰 Opus 照放行且不重复记尝试", async () => {
    const { db } = ledger();
    const decorated = applyCardRole(author("--model", "claude-sonnet-5-5"));
    if (!("args" in decorated)) throw new Error(decorated.error);
    const { seen, create } = counting();
    expect(await cardRoleCreate(create, { tier: ctx(db, "security") })(...decorated.args))
      .toMatchObject({ ok: false, error: expect.stringContaining("不得低于 Opus") });
    expect(seen).toEqual([]);
    const opus = applyCardRole(author("--model", "claude-opus-5-5"));
    if (!("args" in opus)) throw new Error(opus.error);
    expect(await cardRoleCreate(create, { tier: ctx(db, "security") })(...opus.args)).toEqual({ ok: true });
    expect(seen).toEqual([opus.args]);
    expect(taskTierLaunchHistory(db, "p1", "T1").map((f) => f.status)).toEqual(["failed"]);
  });

  test("自由文本（--task / --purpose 的值）里形似 --model 的字样不算参数：与 parseCreateArgs 一致，唯一的 Opus 照放行", async () => {
    for (const free of ["--task", "--purpose"]) {
      const { db } = ledger();
      const args = ["create", "rv", "/w", "--card", "T1", "--card-role", "reviewer", "--project", "p1", free, "--model=claude-sonnet-5-5", "--model", "claude-opus-5-5"];
      const parsed = parseCreateArgs(args.slice(1));
      if ("error" in parsed) throw new Error(parsed.error);
      expect(parsed.model).toBe("claude-opus-5-5"); // 正式解析器口径
      const { seen, create } = counting();
      expect(await cardRoleCreate(create, { tier: ctx(db, "security") })(...args)).toEqual({ ok: true });
      expect(seen.length).toBe(1);
      const sent = parseCreateArgs(seen[0].slice(1));
      expect("error" in sent ? sent.error : sent.model).toBe("claude-opus-5-5");
      cleanups.splice(0).forEach((c) => c());
    }
  });

  test("自由文本之外的值格里藏 --model（--project 的值）：核验值与启动器值对不上 = 拒，不调 create", async () => {
    const { db } = ledger();
    const { seen, create } = counting();
    const args = ["create", "rv", "/w", "--card", "T1", "--card-role", "reviewer", "--project", "--model=claude-opus-5-5", "--model", "claude-sonnet-5-5"];
    const parsed = parseCreateArgs(args.slice(1));
    expect("error" in parsed ? null : parsed.model).toBe("claude-sonnet-5-5");
    expect(await cardRoleCreate(create, { tier: ctx(db, "security") })(...args)).toMatchObject({ ok: false });
    expect(seen).toEqual([]);
  });

  test("非 security 的重复参数同样拒（on 下核验值必须是启动值）；off 原样委托旧路径", async () => {
    const { db } = ledger();
    const { seen, create } = counting();
    expect(await cardRoleCreate(create, { tier: ctx(db, "code") })(...author("--model", "claude-opus-5-5", "--model", "claude-haiku-5-5")))
      .toMatchObject({ ok: false, error: expect.stringContaining("--model 出现了 2 次") });
    useTaskTierPort({ policy: () => ({ mode: "off", manualAfterMs: null, source: "config" }), read: () => ({ status: "missing", table: defaultRoleModels() }) });
    const args = author("--model", "claude-opus-5-5", "--model", "claude-haiku-5-5");
    const old = applyCardRole(args);
    expect(await cardRoleCreate(create, { tier: ctx(db, "code") })(...args)).toEqual({ ok: true });
    expect(seen).toEqual(["args" in old ? old.args : []]);
  });
});
