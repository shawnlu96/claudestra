/**
 * LSC-1：bridge 共享 manager list 缓存的单元行为（保底 TTL、并发合并、registry 变 / 显式作废、失败兜底窗口、深拷贝）。
 * 接口层见 tests/api-routes-agent-lookup.test.ts。
 */
import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createListCache, LIST_CACHE_TTL_MS, LIST_STALE_FALLBACK_MS, registryVersion } from "../src/lib/agent-list-cache.ts";
import { REPO_ROOT } from "../src/lib/repo-root.ts";
import { testChildEnv } from "./test-env.ts";

const ok = (n: number) => ({ ok: true, agents: [{ name: `agent-${n}` }] });

function rig(results: Array<unknown | Error> = [], gate?: Promise<void>) {
  let t = 0;
  let v = "v1";
  let calls = 0;
  const cache = createListCache({
    list: async () => {
      const r = results[calls++] ?? ok(calls);
      await (gate ?? Bun.sleep(5));
      if (r instanceof Error) throw r;
      return r;
    },
    version: () => v,
    now: () => t,
  });
  return { cache, calls: () => calls, advance: (ms: number) => void (t += ms), setVersion: (x: string) => void (v = x) };
}

describe("createListCache", () => {
  test("保底 TTL ≤ 30s：差 1ms 命中，满 TTL 重读", async () => {
    expect(LIST_CACHE_TTL_MS).toBeLessThanOrEqual(30_000);
    const r = rig();
    expect(await r.cache.result()).toEqual(ok(1));
    r.advance(LIST_CACHE_TTL_MS - 1);
    expect(await r.cache.result()).toEqual(ok(1));
    expect(r.calls()).toBe(1);
    r.advance(1);
    expect(await r.cache.result()).toEqual(ok(2));
    expect(r.calls()).toBe(2);
  });

  test("并发读合成一次子进程，各拿各的拷贝（改了不串）", async () => {
    const r = rig();
    const all = await Promise.all(Array.from({ length: 10 }, () => r.cache.result()));
    expect(r.calls()).toBe(1);
    (all[0] as any).agents.push({ name: "x" });
    expect(all[1]).toEqual(ok(1));
    expect(await r.cache.result()).toEqual(ok(1));
  });

  test("版本（registry）一变立刻重读；途中变了不搭旧车", async () => {
    const r = rig();
    await r.cache.result();
    r.setVersion("v2");
    expect(await r.cache.result()).toEqual(ok(2));
    r.setVersion("v3");
    const first = r.cache.result();
    r.setVersion("v4");
    const second = r.cache.result();
    expect(await first).toEqual(ok(3));
    expect(await second).toEqual(ok(4));
    expect(r.calls()).toBe(4);
  });

  test("新建 / 删除 / 改名：registry 不变也能靠显式作废拿到新名单", async () => {
    const lists = [
      { ok: true, agents: [{ name: "agent-a" }] },
      { ok: true, agents: [{ name: "agent-a" }, { name: "agent-b" }] }, // create b
      { ok: true, agents: [{ name: "agent-b" }] }, // kill a
      { ok: true, agents: [{ name: "agent-c" }] }, // rename b → c
    ];
    const r = rig(lists);
    expect(await r.cache.result()).toEqual(lists[0]);
    for (const next of lists.slice(1)) {
      r.cache.invalidate();
      expect(await r.cache.result()).toEqual(next);
    }
    expect(r.calls()).toBe(4);
  });

  test("作废前发起的子进程：结果交回原调用方，但不落缓存、作废后的读不搭车", async () => {
    let release!: () => void;
    const gate = new Promise<void>((res) => (release = res));
    const r = rig([ok(1)], gate);
    const before = r.cache.result();
    r.cache.invalidate();
    const after = r.cache.result();
    expect(r.calls()).toBe(2);
    release();
    expect(await before).toEqual(ok(1));
    expect(await after).toEqual(ok(2));
    expect(await r.cache.result()).toEqual(ok(2));
    expect(r.calls()).toBe(2);
  });

  test("没有好名单时失败原样交回（不回空名单），下一次重新读", async () => {
    const r = rig([{ ok: false, error: "超时" }, { ok: true }, new Error("spawn failed")]);
    expect(await r.cache.result()).toEqual({ ok: false, error: "超时" });
    expect(await r.cache.result()).toEqual({ ok: true });
    await expect(r.cache.result()).rejects.toThrow("spawn failed");
    expect(await r.cache.result()).toEqual(ok(4));
    expect(await r.cache.result()).toEqual(ok(4));
    expect(r.calls()).toBe(4);
  });

  test("兜底窗口：同版本、未作废、不满 LIST_STALE_FALLBACK_MS 的上一份好名单顶上；超窗 / 版本变 / 作废后照报失败", async () => {
    const fail = { ok: false, error: "超时" };
    const r = rig([ok(1), fail, new Error("boom"), fail, fail, ok(6), fail]);
    await r.cache.result();
    r.advance(LIST_CACHE_TTL_MS);
    expect(await r.cache.result()).toEqual(ok(1)); // {ok:false} → 兜底
    expect(await r.cache.result()).toEqual(ok(1)); // 抛错 → 兜底
    r.advance(LIST_STALE_FALLBACK_MS - LIST_CACHE_TTL_MS);
    expect(await r.cache.result()).toEqual(fail); // 超窗
    r.setVersion("v2");
    expect(await r.cache.result()).toEqual(fail); // 版本变了旧名单不算数
    expect(await r.cache.result()).toEqual(ok(6));
    r.cache.invalidate();
    expect(await r.cache.result()).toEqual(fail); // 作废后不兜底
  });
});

describe("registryVersion", () => {
  test("文件不存在 → missing；重写（内容变）→ 版本变", async () => {
    const dir = mkdtempSync(join(tmpdir(), "lsc1-regver-"));
    try {
      const p = join(dir, "registry.json");
      expect(registryVersion(p)).toBe("missing");
      writeFileSync(p, "{}");
      const v1 = registryVersion(p);
      expect(v1).not.toBe("missing");
      expect(registryVersion(p)).toBe(v1);
      await Bun.sleep(5);
      writeFileSync(p, '{"agents":{}}');
      expect(registryVersion(p)).not.toBe(v1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("不让进程常驻（PR #1614 CI 超时排查）", () => {
  test("import 缓存 + management 链、跑一次 route 预算后，子进程 1 秒内自然退出", async () => {
    // 计时从 import 完成算起：只量常驻句柄（定时器 / watch），不量 CI 上 bun 冷启动的快慢
    const script = `await import("${REPO_ROOT}/src/lib/agent-list-cache.ts");
const m = await import("${REPO_ROOT}/src/bridge/agent-lookup.ts");
await import("${REPO_ROOT}/src/bridge/management.ts");
await m.listForRoute(async () => ({ ok: true, agents: [] }));
console.log("loaded");`;
    const p = Bun.spawn([process.execPath, "--no-env-file", "-e", script], { cwd: REPO_ROOT, stdout: "pipe", stderr: "pipe", env: testChildEnv() });
    const reader = p.stdout.getReader();
    let out = "";
    while (!out.includes("loaded")) {
      const { value, done } = await reader.read();
      if (done) break;
      out += new TextDecoder().decode(value);
    }
    expect(out).toContain("loaded");
    const t0 = performance.now();
    const killer = setTimeout(() => p.kill(), 5_000);
    const code = await p.exited;
    clearTimeout(killer);
    expect(performance.now() - t0).toBeLessThan(1_000);
    expect(code).toBe(0);
  }, 30_000);
});
