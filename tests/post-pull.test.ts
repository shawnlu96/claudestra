import { describe, expect, test } from "bun:test";
import { installAfterPull } from "../src/lib/post-pull";

// 副作用全部注入：绝不跑真实的 manager update（会改写生产 launchd plist、给 master 发 /exit）
const deps = (o: { install?: string | null; changed?: boolean | Error; rollback?: string | null }) => {
  const calls: string[] = [];
  return {
    calls,
    d: {
      runInstall: async () => { calls.push("install"); return o.install ?? null; },
      depsChanged: async () => {
        calls.push("diff");
        if (o.changed instanceof Error) throw o.changed;
        return o.changed ?? false;
      },
      rollback: async () => { calls.push("rollback"); return o.rollback ?? null; },
    },
  };
};

describe("installAfterPull", () => {
  test("装成功 → 继续，不查 diff 不回退", async () => {
    const { d, calls } = deps({});
    expect(await installAfterPull(d)).toEqual({ ok: true });
    expect(calls).toEqual(["install"]);
  });

  test("装失败 + 依赖清单没变 → 只警告、继续", async () => {
    const { d, calls } = deps({ install: "exit=1：network", changed: false });
    const r = await installAfterPull(d);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.warning).toContain("network");
    expect(calls).toEqual(["install", "diff"]);
  });

  test("装失败 + 依赖清单变了 → 回退，报失败", async () => {
    const { d, calls } = deps({ install: "exit=1：lockfile", changed: true });
    expect(await installAfterPull(d)).toEqual({ ok: false, step: "bun install", err: "exit=1：lockfile", rolledBack: true });
    expect(calls).toEqual(["install", "diff", "rollback"]);
  });

  test("判断不了依赖变没变 → 按变了算（保守回退）", async () => {
    const { d, calls } = deps({ install: "x", changed: new Error("git 挂了") });
    const r = await installAfterPull(d);
    expect(r.ok).toBe(false);
    expect(calls).toContain("rollback");
  });

  test("回退也失败 → 如实报出", async () => {
    const { d } = deps({ install: "x", changed: true, rollback: "工作区有改动" });
    expect(await installAfterPull(d)).toEqual({
      ok: false, step: "bun install", err: "x", rolledBack: false, rollbackError: "工作区有改动",
    });
  });
});
