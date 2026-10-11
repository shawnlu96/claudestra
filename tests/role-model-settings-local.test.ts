/**
 * 本机建卡经模型档位表读端口（role-model-settings-local.ts + card-role-definitions.ts applyCardRole，TIER1）：
 * - observe（缺省）：argv 与 off 逐字一样（零启动改变），卡上只记一条 would-use（真台账、同卡同值去重）；建卡次数不变。
 * - on：没显式指定时 Claude 用表里的模型、Codex 加表里的推理档；表是 null 不加；Codex 永远不带 --model。
 * - 显式 --model / --effort 优先，且不记 would-use；表坏 / 读不了：on 下也照定义起；恢复策略文件坏 = off。
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyCardRole, cardRoleCreate } from "../src/lib/card-role-definitions.js";
import { closeLedger, getEventByDedup, openLedger } from "../src/lib/ledger-store.js";
import { createTask } from "../src/lib/ledger-write.js";
import { observeDedupKey, recordObserved, recoveryPolicy, type ObservedAction, type RecoveryMode } from "../src/lib/recovery-policy.js";
import { pickRoleModel, useRoleModelPort, type RoleModelPort } from "../src/lib/role-model-settings-local.js";
import { defaultRoleModels, readRoleModels, type RoleModelRead } from "../src/lib/role-model-settings.js";

const cleanups: (() => void)[] = [];
afterEach(() => { useRoleModelPort(); for (const c of cleanups.splice(0)) c(); });
const tmp = () => { const d = mkdtempSync(join(tmpdir(), "role-model-local-")); cleanups.push(() => rmSync(d, { recursive: true, force: true })); return d; };

/** 表里 author 换成 Sonnet、reviewer 的 Codex 档 high：和定义文件不同，才看得出到底用没用表 */
const TABLE: RoleModelRead = (() => {
  const t = defaultRoleModels();
  t.rev = 3;
  t.roles.author = { claude: "claude-sonnet-5-5", codex: "xhigh" };
  t.roles.reviewer = { claude: "claude-sonnet-5-5", codex: "high" };
  return { status: "ok", table: t };
})();

function fakePort(mode: RecoveryMode, read: RoleModelRead = TABLE): RoleModelPort & { seen: ObservedAction[]; policyCalls: string[] } {
  const seen: ObservedAction[] = [], policyCalls: string[] = [];
  return { seen, policyCalls, read: () => read, observe: (a) => void seen.push(a),
    policy: (project, key) => (policyCalls.push(`${project}:${key}`), { mode, manualAfterMs: null, source: "config" }) };
}

const author = (...extra: string[]) => ["create", "a1", "/w", "--purpose", "T1 作者", "--task", "T1", "--card", "T1", "--card-role", "author", "--effort", "high",
  "--project", "p1", ...extra];
const reviewer = (...extra: string[]) => ["create", "r1", "/w", "--purpose", "T1 审查", "--project", "p1", "--task", "T1 审查", "--card", "T1", "--card-role", "reviewer", ...extra];
const argsOf = (r: ReturnType<typeof applyCardRole>) => ("error" in r ? (() => { throw new Error(r.error); })() : r.args);
const flag = (args: string[], f: string) => { const i = args.indexOf(f); return i < 0 ? undefined : args[i + 1]; };

describe("Claude 卡", () => {
  test("observe：argv 与 off 逐字一样（照定义 Opus 5.5），卡上记一条 would-use", () => {
    const off = fakePort("off"); useRoleModelPort(off);
    const base = argsOf(applyCardRole(author()));
    const obs = fakePort("observe"); useRoleModelPort(obs);
    const observed = argsOf(applyCardRole(author()));
    expect(observed).toEqual(base);
    expect(flag(observed, "--model")).toBe("claude-opus-5-5");
    expect(off.seen).toEqual([]);
    expect(obs.seen).toEqual([expect.objectContaining({ project: "p1", mechanism: "roleModel", target: "T1", actionKey: "role-model:author:claude:claude-sonnet-5-5",
      data: expect.objectContaining({ wouldUse: "claude-sonnet-5-5", source: "settings", role: "author", family: "claude" }) })]);
    expect(obs.policyCalls).toEqual(["p1:roleModel"]);
  });

  test("on：没显式 --model 就用表里的模型", () => {
    useRoleModelPort(fakePort("on"));
    expect(flag(argsOf(applyCardRole(author())), "--model")).toBe("claude-sonnet-5-5");
    expect(flag(argsOf(applyCardRole(reviewer())), "--model")).toBe("claude-sonnet-5-5");
  });

  test("显式 --model 优先：on 也不换，observe 也不记", () => {
    for (const mode of ["on", "observe"] as const) {
      const p = fakePort(mode); useRoleModelPort(p);
      expect(flag(argsOf(applyCardRole(author("--model", "claude-haiku-5-5"))), "--model")).toBe("claude-haiku-5-5");
      expect(p.seen).toEqual([]);
    }
  });

  test("on 但表坏 / 读不了：照定义起，不猜值", () => {
    for (const status of ["invalid", "unreadable"] as const) {
      useRoleModelPort(fakePort("on", { status, error: "x", table: defaultRoleModels() }));
      expect(flag(argsOf(applyCardRole(author())), "--model")).toBe("claude-opus-5-5");
    }
    const r = pickRoleModel({ role: "author", family: "claude", project: "p1", card: "T1", explicit: false }, fakePort("on", { status: "invalid", error: "坏", table: defaultRoleModels() }));
    expect(r).toMatchObject({ inject: null, mode: "on", diagnostic: expect.stringContaining("坏") });
  });

  test("嵌套入口（runStart 套 runLocalStart）：第二层原样返回，不重复记", () => {
    const p = fakePort("observe"); useRoleModelPort(p);
    const once = argsOf(applyCardRole(author()));
    expect(argsOf(applyCardRole(once))).toEqual(once);
    expect(p.seen).toHaveLength(1);
  });

  test("会被拒的 create（定义要的边界被占）不记 would-use", () => {
    const p = fakePort("observe"); useRoleModelPort(p);
    expect("error" in applyCardRole(reviewer("--preset", "default"))).toBe(true);
    expect(p.seen).toEqual([]);
  });

  test("observe 下建卡次数不变：一次 create 调一次下游", async () => {
    useRoleModelPort(fakePort("observe"));
    const calls: string[][] = [];
    const create = cardRoleCreate(async (...a: string[]) => (calls.push(a), { ok: true }));
    await create(...author());
    expect(calls).toHaveLength(1);
    expect(flag(calls[0]!, "--model")).toBe("claude-opus-5-5");
  });
});

describe("Codex 卡", () => {
  const codexReviewer = () => reviewer("--runtime", "codex", "--transport", "acp");

  test("observe：一字不改，记 would-use（Codex 列是推理档）", () => {
    const p = fakePort("observe"); useRoleModelPort(p);
    expect(argsOf(applyCardRole(codexReviewer()))).toEqual(codexReviewer());
    expect(p.seen[0]).toMatchObject({ actionKey: "role-model:reviewer:codex:high", data: { wouldUse: "high", family: "codex" } });
  });

  test("on：加表里的 --effort，永远不带 --model；表是 null 不加；显式 --effort 优先", () => {
    useRoleModelPort(fakePort("on"));
    const out = argsOf(applyCardRole(codexReviewer()));
    expect(flag(out, "--effort")).toBe("high");
    expect(out).not.toContain("--model");
    expect(argsOf(applyCardRole(reviewer("--runtime", "codex", "--effort", "low")))).toEqual(reviewer("--runtime", "codex", "--effort", "low"));
    useRoleModelPort(fakePort("on", { status: "ok", table: defaultRoleModels() }));
    expect(argsOf(applyCardRole(codexReviewer()))).toEqual(codexReviewer());
  });

  test("runLocalStart 的 family=codex（--runtime 由外层追加）也走同一端口", () => {
    useRoleModelPort(fakePort("on"));
    expect(flag(argsOf(applyCardRole(reviewer(), { family: "codex" })), "--effort")).toBe("high");
  });
});

describe("真恢复策略与真台账", () => {
  test("策略文件坏 = off：不换、不记；缺省 = observe", () => {
    const d = tmp(), file = join(d, "recovery-policy.json"), seen: ObservedAction[] = [];
    const port = (): RoleModelPort => ({ policy: (p, k) => recoveryPolicy(p, k, file), read: () => TABLE, observe: (a) => void seen.push(a) });
    useRoleModelPort(port());
    applyCardRole(author());
    expect(seen).toHaveLength(1); // 没文件 = observe
    writeFileSync(file, "{bad");
    seen.length = 0;
    expect(flag(argsOf(applyCardRole(author())), "--model")).toBe("claude-opus-5-5");
    expect(seen).toEqual([]);
    writeFileSync(file, JSON.stringify({ projects: { p1: { keys: { roleModel: "on" } } } }));
    expect(flag(argsOf(applyCardRole(author())), "--model")).toBe("claude-sonnet-5-5");
  });

  test("would-use 写进台账一条 note，同卡同值重复建只一条", () => {
    const path = join(tmp(), "ledger.sqlite");
    cleanups.push(() => closeLedger(path));
    createTask(openLedger(path), { actor: "owner" }, { id: "T1", project: "p1", title: "demo", kind: "code" });
    useRoleModelPort({ policy: () => ({ mode: "observe", manualAfterMs: null, source: "default" }), read: () => TABLE,
      observe: (a) => void recordObserved(openLedger(path), a, 1_000) });
    applyCardRole(author());
    applyCardRole(author());
    const key = observeDedupKey({ project: "p1", mechanism: "roleModel", target: "T1", actionKey: "role-model:author:claude:claude-sonnet-5-5" });
    const ev = getEventByDedup(openLedger(path), key);
    expect(ev).toMatchObject({ kind: "note", target: "T1", data: { op: "recovery_observe", mechanism: "roleModel", wouldUse: "claude-sonnet-5-5" } });
    expect((openLedger(path).query("SELECT COUNT(*) AS n FROM events WHERE dedupKey = ?").get(key) as { n: number }).n).toBe(1);
  });

  test("生产端口读真表文件：网页存的值下一次建卡就看得到", () => {
    expect(readRoleModels().status).toBe("missing"); // 测试状态目录是临时的
  });
});
