/**
 * manager migrate-web-state（lib/web-state-migrate.ts）：先 tar 备份整个 web 目录，
 * 再把旧 settings.db 的 8 张表 INSERT OR IGNORE 进新库（重复执行不重复插入），config.json 的 groqApiKey / lang 只补缺。
 */
import { Database } from "bun:sqlite";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeWebState, openWebState, WEB_STATE_TABLES } from "../src/lib/web-state.js";
import { copyWebStateTables, migrateWebState, type MigrateResult } from "../src/lib/web-state-migrate.js";

let root: string;
let webDir: string;
let targetDb: string;
const adopted: unknown[] = [];
const fakeAdopt = async (web: { groqApiKey?: unknown; lang?: unknown }) => {
  adopted.push(web);
  return { groqApiKey: typeof web.groqApiKey === "string", lang: web.lang === "en" };
};

/** 旧 BFF 的 settings.db：登录体系的表也在，user_profile 是 ALTER 出来的两列 */
function writeLegacySettingsDb(path: string): void {
  const db = new Database(path);
  db.exec("CREATE TABLE agent_settings (agent TEXT PRIMARY KEY, init_message TEXT NOT NULL DEFAULT '', updated_at TEXT NOT NULL)");
  db.exec("CREATE TABLE user_profile (id INTEGER PRIMARY KEY CHECK (id = 1), nickname TEXT NOT NULL DEFAULT '', avatar TEXT NOT NULL DEFAULT '', updated_at TEXT NOT NULL)");
  db.exec("ALTER TABLE user_profile ADD COLUMN claude_nickname TEXT NOT NULL DEFAULT ''");
  db.exec("ALTER TABLE user_profile ADD COLUMN claude_avatar TEXT NOT NULL DEFAULT ''");
  db.exec("CREATE TABLE skill_prefs (name TEXT PRIMARY KEY, pinned INTEGER NOT NULL DEFAULT 0, used_count INTEGER NOT NULL DEFAULT 0, updated_at TEXT NOT NULL)");
  db.exec("CREATE TABLE push_subscriptions (endpoint TEXT PRIMARY KEY, keys TEXT NOT NULL, ua TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL)");
  db.exec("CREATE TABLE push_read (agent TEXT PRIMARY KEY, ts INTEGER NOT NULL)");
  db.exec(`CREATE TABLE hidden_messages (agent TEXT NOT NULL, session_id TEXT NOT NULL, seq_from INTEGER NOT NULL, seq_to INTEGER NOT NULL,
    hidden_at INTEGER NOT NULL, PRIMARY KEY (agent, session_id, seq_from))`);
  db.exec("CREATE TABLE agent_unread (agent TEXT PRIMARY KEY, count INTEGER NOT NULL DEFAULT 0, last_reply_ts INTEGER NOT NULL DEFAULT 0)");
  db.exec("CREATE TABLE auth_config (id INTEGER PRIMARY KEY CHECK (id = 1), totp_secret TEXT NOT NULL DEFAULT '')");
  db.exec("INSERT INTO auth_config (id, totp_secret) VALUES (1, 'SECRET')");
  db.prepare("INSERT INTO agent_settings VALUES (?, ?, ?)").run("agent-worker", "读 HANDOFF", "2026-09-01T00:00:00Z");
  db.prepare("INSERT INTO user_profile (id, nickname, avatar, updated_at, claude_nickname, claude_avatar) VALUES (1, ?, ?, ?, ?, ?)").run("Shawn", "data:image/png;base64,AA", "t", "小克", "");
  db.prepare("INSERT INTO skill_prefs VALUES (?, ?, ?, ?)").run("save-compact", 1, 7, "t");
  db.prepare("INSERT INTO push_subscriptions VALUES (?, ?, ?, ?)").run("https://push.example/1", '{"p256dh":"a","auth":"b"}', "Safari", "t");
  db.prepare("INSERT INTO push_read VALUES (?, ?)").run("agent-worker", 1700000000000);
  db.prepare("INSERT INTO hidden_messages VALUES (?, ?, ?, ?, ?)").run("agent-worker", "sid-1", 3, 5, 1700000000000);
  db.prepare("INSERT INTO agent_unread VALUES (?, ?, ?)").run("agent-worker", 2, 1700000000000);
  db.close();
}

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "migrate-web-"));
  webDir = join(root, "web");
  targetDb = join(root, "web-state.sqlite");
  mkdirSync(join(webDir, "db"), { recursive: true });
  writeLegacySettingsDb(join(webDir, "db", "settings.db"));
  // 旧 web 的登录会话在另一个库 auth.db（与 settings.db 分开）
  const auth = new Database(join(webDir, "db", "auth.db"));
  auth.exec("CREATE TABLE sessions (id TEXT PRIMARY KEY, username TEXT NOT NULL, expires_at TEXT NOT NULL, created_at TEXT NOT NULL)");
  auth.prepare("INSERT INTO sessions VALUES (?, ?, ?, ?)").run("live-session-000000000000000000", "shawn", "2099-01-01T00:00:00.000Z", "2026-09-20T00:00:00.000Z");
  auth.prepare("INSERT INTO sessions VALUES (?, ?, ?, ?)").run("dead-session-000000000000000000", "shawn", "2026-09-01T00:00:00.000Z", "2026-08-20T00:00:00.000Z");
  auth.close();
  writeFileSync(join(webDir, "config.json"), JSON.stringify({ groqApiKey: "gsk_legacy_key_00000000000", lang: "en" }));
  writeFileSync(join(webDir, "client.log"), "old log\n");
});
afterAll(() => {
  closeWebState(targetDb);
  rmSync(root, { recursive: true, force: true });
});

describe("migrateWebState", () => {
  test("备份 → 复制 8 张表（apns_devices 旧库没有 → rows null）→ 设置补缺；登录体系的表不搬", async () => {
    const now = new Date("2026-09-27T08:09:10.123Z");
    const r = (await migrateWebState({ webDir, backupDir: join(root, "backups"), targetDb, adopt: fakeAdopt, now })) as MigrateResult;
    expect(r.ok).toBe(true);
    expect(r.backup).toBe(join(root, "backups", "web-2026-09-27T08-09-10-123Z.tgz"));
    expect(existsSync(r.backup)).toBe(true);
    const listed = await new Response(Bun.spawn(["tar", "-tzf", r.backup], { stdout: "pipe" }).stdout).text();
    expect(listed).toContain("web/db/settings.db");
    expect(listed).toContain("web/config.json");
    expect(listed).toContain("web/client.log");
    expect(r.settingsDb).toBe(join(webDir, "db", "settings.db"));
    expect(r.tables).toEqual({
      agent_settings: { rows: 1, inserted: 1 }, user_profile: { rows: 1, inserted: 1 }, skill_prefs: { rows: 1, inserted: 1 },
      push_subscriptions: { rows: 1, inserted: 1 }, push_read: { rows: 1, inserted: 1 }, hidden_messages: { rows: 1, inserted: 1 },
      agent_unread: { rows: 1, inserted: 1 }, apns_devices: { rows: null, inserted: 0 },
    });
    expect(r.config).toEqual({ groqApiKey: true, lang: true });
    expect(adopted).toEqual([{ groqApiKey: "gsk_legacy_key_00000000000", lang: "en" }]);
    expect(r.sessions).toBe(1); // auth.db 里没过期的那条；过期的不搬
    const db = openWebState(targetDb);
    expect(db.prepare("SELECT count(*) AS n FROM legacy_sessions").get()).toEqual({ n: 1 });
    expect(db.prepare("SELECT init_message FROM agent_settings WHERE agent = ?").get("agent-worker")).toEqual({ init_message: "读 HANDOFF" });
    expect(db.prepare("SELECT nickname, claude_nickname FROM user_profile WHERE id = 1").get()).toEqual({ nickname: "Shawn", claude_nickname: "小克" });
    expect(db.prepare("SELECT seq_from, seq_to FROM hidden_messages").all()).toEqual([{ seq_from: 3, seq_to: 5 }]);
    const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[]).map((t) => t.name);
    expect(tables).not.toContain("auth_config");
    closeWebState(targetDb);
  });
  test("再跑一次：幂等——已存在的行 IGNORE，新库里改过的值不被旧库覆盖，备份再做一份", async () => {
    const db = openWebState(targetDb);
    db.prepare("UPDATE agent_settings SET init_message = ? WHERE agent = ?").run("新指令", "agent-worker");
    closeWebState(targetDb);
    const r = (await migrateWebState({ webDir, backupDir: join(root, "backups"), targetDb, adopt: fakeAdopt, now: new Date("2026-09-28T00:00:00Z") })) as MigrateResult;
    for (const t of WEB_STATE_TABLES) expect(r.tables![t].inserted).toBe(0);
    expect(existsSync(r.backup)).toBe(true);
    expect(openWebState(targetDb).prepare("SELECT init_message FROM agent_settings WHERE agent = ?").get("agent-worker")).toEqual({ init_message: "新指令" });
    closeWebState(targetDb);
  });
  test("没有旧 web 目录 → skipped，不建备份", async () => {
    const r = await migrateWebState({ webDir: join(root, "nope"), backupDir: join(root, "backups2"), targetDb, adopt: fakeAdopt });
    expect(r).toMatchObject({ ok: true, skipped: expect.stringContaining("nope") });
    expect(existsSync(join(root, "backups2"))).toBe(false);
  });
  test("有目录没 settings.db / 没 config.json：备份照做，表与设置都跳过", async () => {
    const bare = join(root, "web-bare");
    mkdirSync(bare);
    const r = (await migrateWebState({ webDir: bare, backupDir: join(root, "backups3"), targetDb, adopt: fakeAdopt })) as MigrateResult;
    expect(r.settingsDb).toBeNull();
    expect(r.tables).toBeNull();
    expect(r.config).toEqual({ groqApiKey: false, lang: false });
    expect(r.env).toEqual([]); // 没传 env 选项 = 不碰任何 .env
  });
  test("推送配置：web/.env.local 的 APNS_* / PUSH_VAPID_SUBJECT 补进根 .env，已有的键不动，别的键不搬；幂等；没 .env.local 就跳过", async () => {
    const webEnvLocal = join(root, "env.local");
    const envFile = join(root, "dotenv");
    writeFileSync(webEnvLocal, "APNS_TEAM_ID=G3TEAM\nAPNS_ENV=production\nPUSH_VAPID_SUBJECT=mailto:a@b\nINTERNAL_API_KEY=nope\n");
    writeFileSync(envFile, "BRIDGE_PORT=3847\nAPNS_ENV=sandbox\n");
    const opts = { webDir, backupDir: join(root, "backups4"), targetDb, adopt: fakeAdopt, env: { webEnvLocal, envFile } };
    expect(((await migrateWebState(opts)) as MigrateResult).env).toEqual(["APNS_TEAM_ID", "PUSH_VAPID_SUBJECT"]);
    expect(readFileSync(envFile, "utf8")).toBe("BRIDGE_PORT=3847\nAPNS_ENV=sandbox\nAPNS_TEAM_ID=G3TEAM\nPUSH_VAPID_SUBJECT=mailto:a@b\n");
    expect(((await migrateWebState(opts)) as MigrateResult).env).toEqual([]);
    expect(((await migrateWebState({ ...opts, env: { webEnvLocal: join(root, "none"), envFile } })) as MigrateResult).env).toEqual([]);
    expect(readFileSync(envFile, "utf8")).toBe("BRIDGE_PORT=3847\nAPNS_ENV=sandbox\nAPNS_TEAM_ID=G3TEAM\nPUSH_VAPID_SUBJECT=mailto:a@b\n");
  });
});

describe("copyWebStateTables", () => {
  test("只复制两边都有的列：旧库多出来的列被忽略，新库多出来的列取默认值", () => {
    const src = new Database(":memory:");
    src.exec("CREATE TABLE skill_prefs (name TEXT PRIMARY KEY, pinned INTEGER, used_count INTEGER, updated_at TEXT, extra TEXT)");
    src.prepare("INSERT INTO skill_prefs VALUES (?, ?, ?, ?, ?)").run("run", 0, 3, "t", "junk");
    src.exec("CREATE TABLE user_profile (id INTEGER PRIMARY KEY, nickname TEXT, avatar TEXT, updated_at TEXT)");
    src.prepare("INSERT INTO user_profile VALUES (1, ?, ?, ?)").run("Old", "", "t");
    const dstPath = join(root, "copy-target.sqlite");
    const dst = openWebState(dstPath);
    const r = copyWebStateTables(src, dst);
    expect(r.skill_prefs).toEqual({ rows: 1, inserted: 1 });
    expect(r.user_profile).toEqual({ rows: 1, inserted: 1 });
    expect(r.agent_settings).toEqual({ rows: null, inserted: 0 });
    expect(dst.prepare("SELECT name, used_count FROM skill_prefs").get()).toEqual({ name: "run", used_count: 3 });
    expect(dst.prepare("SELECT nickname, claude_nickname FROM user_profile").get()).toEqual({ nickname: "Old", claude_nickname: "" });
    closeWebState(dstPath);
    src.close();
  });
});
