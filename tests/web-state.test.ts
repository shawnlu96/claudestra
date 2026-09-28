/** bridge 侧 web 状态库（src/lib/web-state.ts）：8 张表齐全、列名与 BFF 的 settings.db 一致、同路径只开一次 */
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { closeWebState, openWebState, WEB_STATE_TABLES } from "../src/lib/web-state.js";

describe("openWebState", () => {
  test("建全 8 张表；user_profile 直接带 claude_* 两列；同一路径返回同一个连接", () => {
    const db = openWebState(":memory:");
    const names = (db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all() as { name: string }[]).map((r) => r.name);
    for (const t of WEB_STATE_TABLES) expect(names).toContain(t);
    const cols = (db.prepare("PRAGMA table_info(user_profile)").all() as { name: string }[]).map((c) => c.name);
    expect(cols).toEqual(["id", "nickname", "avatar", "updated_at", "claude_nickname", "claude_avatar"]);
    db.prepare("INSERT INTO agent_unread (agent, count, last_reply_ts) VALUES (?, ?, ?)").run("a", 3, 1);
    expect(openWebState(":memory:")).toBe(db);
    expect(db.prepare("SELECT count FROM agent_unread WHERE agent = ?").get("a")).toEqual({ count: 3 });
    closeWebState(":memory:");
    expect(openWebState(":memory:")).not.toBe(db);
    closeWebState(":memory:");
  });
  test("老库的 push_subscriptions 补 vapid_key 列，老行保留且为 NULL；再开一次不重复补", () => {
    const dir = mkdtempSync(join(tmpdir(), "web-state-"));
    const path = join(dir, "web-state.sqlite");
    try {
      const old = new Database(path);
      old.exec("CREATE TABLE push_subscriptions (endpoint TEXT PRIMARY KEY, keys TEXT NOT NULL, ua TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL)");
      old.prepare("INSERT INTO push_subscriptions VALUES (?, ?, ?, ?)").run("https://push.example/old", "{}", "", "2026-07-24");
      old.close();
      const db = openWebState(path);
      expect(db.prepare("SELECT endpoint, vapid_key FROM push_subscriptions").all()).toEqual([{ endpoint: "https://push.example/old", vapid_key: null }]);
      closeWebState(path);
      const again = openWebState(path);
      expect((again.prepare("PRAGMA table_info(push_subscriptions)").all() as { name: string }[]).filter((c) => c.name === "vapid_key")).toHaveLength(1);
      closeWebState(path);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
