import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync, utimesSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  parseLocalCache,
  parseRemoteCatalog,
  labelFromId,
  builtinCatalog,
  loadModelCatalog,
} from "../src/lib/model-catalog";

// 形状取自 2026-09-22 本机实物（CC 2.1.280），字段删到只剩用得上的
const localCache = (ids: string[]) => ({
  version: 2,
  catalog: {
    surface: "cc",
    config: { id: "cc", models: ids.map((id, i) => ({ id, name: `M${i}`, section: i ? "overflow" : "main" })) },
    state: { model: ids[0] },
  },
});
const remote = {
  schema_version: 1,
  surfaces: {
    chat: { model_selector_config: [{ id: "chat", models: [{ id: "claude-wrong-surface" }] }] },
    cc: { model_selector_config: [{ id: "cc", models: [{ id: "claude-opus-5-5", name: "Opus 5.5", section: "main" }] }] },
  },
};

describe("parse", () => {
  test("本地缓存：取 catalog.config.models", () => {
    expect(parseLocalCache(localCache(["claude-opus-5-5", "claude-opus-4-6"]))).toEqual([
      { id: "claude-opus-5-5", name: "M0", section: "main" },
      { id: "claude-opus-4-6", name: "M1", section: "overflow" },
    ]);
  });

  test("公开端点：只取 cc 分区", () => {
    expect(parseRemoteCatalog(remote)).toEqual([{ id: "claude-opus-5-5", name: "Opus 5.5", section: "main" }]);
  });

  test("格式对不上 → null（交给下一档），不抛", () => {
    for (const bad of [null, {}, { catalog: {} }, { catalog: { config: { models: [] } } }, { surfaces: {} }]) {
      expect(parseLocalCache(bad)).toBeNull();
      expect(parseRemoteCatalog(bad)).toBeNull();
    }
  });

  test("缺 name 用 id 推", () => {
    expect(parseLocalCache({ catalog: { config: { models: [{ id: "claude-opus-5-5" }] } } })?.[0].name).toBe("Opus 5.5");
  });
});

test("labelFromId", () => {
  expect(labelFromId("claude-opus-5-5")).toBe("Opus 5.5");
  expect(labelFromId("claude-fable-5-1")).toBe("Fable 5.1");
  expect(labelFromId("claude-sonnet-5")).toBe("Sonnet 5");
  expect(labelFromId("claude-haiku-4-5-20251001")).toBe("Haiku 4.5");
  expect(labelFromId("claude-opus-4-1-20250805")).toBe("Opus 4.1");
});

test("builtin 兜底：别名表去重，裸名与版本别名不重复出现", () => {
  const ids = builtinCatalog().map((m) => m.id);
  expect(new Set(ids).size).toBe(ids.length);
  expect(ids).toContain("claude-opus-5");
});

describe("loadModelCatalog 回退链", () => {
  const noRemote = async () => null;

  test("本地缓存优先；多份取最新写入的", async () => {
    const dir = mkdtempSync(join(tmpdir(), "mc-"));
    writeFileSync(join(dir, "old-cc.json"), JSON.stringify(localCache(["claude-old"])));
    writeFileSync(join(dir, "new-cc.json"), JSON.stringify(localCache(["claude-new"])));
    writeFileSync(join(dir, "x-chat.json"), JSON.stringify(localCache(["claude-chat-surface"])));
    utimesSync(join(dir, "old-cc.json"), 1000, 1000);
    const c = await loadModelCatalog({ dir, fetchRemote: noRemote });
    expect(c.source).toBe("local-cache");
    expect(c.models[0].id).toBe("claude-new");
  });

  test("本地坏文件跳过，看下一份", async () => {
    const dir = mkdtempSync(join(tmpdir(), "mc-"));
    writeFileSync(join(dir, "bad-cc.json"), "{not json");
    writeFileSync(join(dir, "ok-cc.json"), JSON.stringify(localCache(["claude-ok"])));
    utimesSync(join(dir, "ok-cc.json"), 1000, 1000);
    expect((await loadModelCatalog({ dir, fetchRemote: noRemote })).models[0].id).toBe("claude-ok");
  });

  test("本地没有 → 公开端点", async () => {
    const c = await loadModelCatalog({ dir: "/nonexistent", fetchRemote: async () => parseRemoteCatalog(remote) });
    expect(c.source).toBe("remote");
    expect(c.models[0].id).toBe("claude-opus-5-5");
  });

  test("都拿不到 → 别名表兜底，下拉永远不空", async () => {
    const c = await loadModelCatalog({ dir: "/nonexistent", fetchRemote: noRemote });
    expect(c.source).toBe("builtin");
    expect(c.models.length).toBeGreaterThan(0);
  });
});
