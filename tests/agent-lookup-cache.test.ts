/** SYN-4：manager list 短缓存的单元行为（缓存期 ≤ 3s、并发合并、registry 变即作废、失败不缓存）；接口层见 tests/api-routes-agent-lookup.test.ts */
import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createListCache, LIST_CACHE_TTL_MS, registryVersion } from "../src/lib/agent-lookup-cache.ts";

const ok = (n: number) => ({ ok: true, agents: [{ name: `agent-${n}` }] });

function rig(results: Array<unknown | Error> = []) {
  let t = 0;
  let v = "v1";
  let calls = 0;
  const cache = createListCache({
    list: async () => {
      const r = results[calls++] ?? ok(calls);
      await Bun.sleep(5);
      if (r instanceof Error) throw r;
      return r;
    },
    version: () => v,
    now: () => t,
  });
  return { cache, calls: () => calls, advance: (ms: number) => void (t += ms), setVersion: (x: string) => void (v = x) };
}

describe("createListCache", () => {
  test("缓存期上限 3s：差 1ms 命中，满 3s 重读", async () => {
    expect(LIST_CACHE_TTL_MS).toBeLessThanOrEqual(3_000);
    const r = rig();
    expect(await r.cache.result()).toEqual(ok(1));
    r.advance(LIST_CACHE_TTL_MS - 1);
    expect(await r.cache.result()).toEqual(ok(1));
    expect(r.calls()).toBe(1);
    r.advance(1);
    expect(await r.cache.result()).toEqual(ok(2));
    expect(r.calls()).toBe(2);
  });

  test("传进来的 ttlMs 超过 3s 也被压到 3s", async () => {
    let t = 0;
    let calls = 0;
    const cache = createListCache({ list: async () => ok(++calls), version: () => "v", now: () => t, ttlMs: 60_000 });
    await cache.result();
    t = 3_000;
    await cache.result();
    expect(calls).toBe(2);
  });

  test("并发请求合成一次", async () => {
    const r = rig();
    const all = await Promise.all(Array.from({ length: 10 }, () => r.cache.result()));
    expect(r.calls()).toBe(1);
    expect(new Set(all).size).toBe(1);
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

  test("失败不缓存：{ok:false}、缺 agents、抛错都原样交回，下一次重新读", async () => {
    const r = rig([{ ok: false, error: "超时" }, { ok: true }, new Error("spawn failed")]);
    expect(await r.cache.result()).toEqual({ ok: false, error: "超时" });
    expect(await r.cache.result()).toEqual({ ok: true });
    await expect(r.cache.result()).rejects.toThrow("spawn failed");
    expect(await r.cache.result()).toEqual(ok(4));
    expect(await r.cache.result()).toEqual(ok(4));
    expect(r.calls()).toBe(4);
  });
});

describe("registryVersion", () => {
  test("文件不存在 → missing；重写（内容变）→ 版本变", async () => {
    const dir = mkdtempSync(join(tmpdir(), "syn4-regver-"));
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
