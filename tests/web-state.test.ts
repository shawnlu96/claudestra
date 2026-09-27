/** bridge 侧 web 状态库（src/lib/web-state.ts）：8 张表齐全、列名与 BFF 的 settings.db 一致、同路径只开一次 */
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
});
