/**
 * T74 入站账（src/lib/inbound-ledger.ts + bridge/inbound-event.ts 的接线）：按 (agent, message_id) 记正文哈希与 meta；
 * 写账失败不抛（投递照常）、读侧出错按无账；库在磁盘上，关库重开仍对得上；过期 / 超量清理；tmux 版 Pi 的原样投递清掉该 agent 的账。
 * 历史怎么按账还原见 tests/foreign-runtime-headers.test.ts。
 */
import { Database } from "bun:sqlite";
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { noteAcpChannel } from "../src/bridge/acp-state.ts";
import { inboundFor, inboundLedgerGate } from "../src/bridge/inbound-event.js";
import { setWebStatePathForTest } from "../src/bridge/local-api/db.js";
import type { Envelope } from "../src/bridge/router.js";
import { ensureInboundTable, forgetInbound, inboundLookup, inboundSha, noteInbound, pruneInbound } from "../src/lib/inbound-ledger.js";
import { closeWebState, openWebState } from "../src/lib/web-state.js";

const dir = mkdtempSync(join(tmpdir(), "inbound-ledger-"));
afterAll(() => {
  setWebStatePathForTest(undefined);
  rmSync(dir, { recursive: true, force: true });
});

const DAY = 86_400_000;
const META = { chat_id: "api:owner:self", message_id: "api_1", user: "owner", user_id: "api:owner:self", api: "true" };
function memDb(): Database {
  const db = new Database(":memory:");
  ensureInboundTable(db);
  return db;
}
const rows = (db: Database) => (db.query("SELECT COUNT(*) AS n FROM inbound_ledger").get() as { n: number }).n;

describe("noteInbound / inboundLookup", () => {
  test("按 agent 记正文哈希与 meta，不存正文；裸名与 agent- 名是同一个 agent；同一 mid 重投覆盖写", () => {
    const db = memDb();
    noteInbound(db, "pi", "api_1", "正文", META, 1);
    expect(inboundLookup(db, "agent-pi")("api_1")).toEqual({ sha: inboundSha("正文"), meta: META });
    expect(JSON.stringify(db.query("SELECT * FROM inbound_ledger").all())).not.toContain("正文");
    noteInbound(db, "agent-pi", "api_1", "改过", META, 2);
    expect(inboundLookup(db, "pi")("api_1")?.sha).toBe(inboundSha("改过"));
    expect(rows(db)).toBe(1);
    expect(inboundLookup(db, "agent-other")("api_1")).toBeNull();
  });
  test("没有 mid、agent 认不出（?）不记", () => {
    const db = memDb();
    noteInbound(db, "pi", undefined, "x", META, 1);
    noteInbound(db, "?", "api_2", "x", META, 1);
    expect(rows(db)).toBe(0);
  });
  test("写账失败（库已关）不抛；读侧表缺失 / 库已关 / meta 坏了都按无账，不抛", () => {
    const closed = memDb();
    closed.close();
    expect(() => noteInbound(closed, "pi", "api_1", "x", META, 1)).not.toThrow();
    expect(() => forgetInbound(closed, "pi")).not.toThrow();
    expect(inboundLookup(closed, "pi")("api_1")).toBeNull();
    const noTable = new Database(":memory:");
    expect(inboundLookup(noTable, "pi")("api_1")).toBeNull();
    const db = memDb();
    db.query("INSERT INTO inbound_ledger VALUES (?, ?, ?, ?, ?)").run("agent-pi", "bad", "s", 1, "{not json");
    db.query("INSERT INTO inbound_ledger VALUES (?, ?, ?, ?, ?)").run("agent-pi", "arr", "s", 1, '["x"]');
    db.query("INSERT INTO inbound_ledger VALUES (?, ?, ?, ?, ?)").run("agent-pi", "num", "s", 1, '{"user":1}');
    for (const mid of ["bad", "arr", "num"]) expect(inboundLookup(db, "pi")(mid)).toBeNull();
  });
  test("清理：180 天前的删掉，超量只留最新的；forgetInbound 只清这一个 agent", () => {
    const db = memDb();
    const now = 1_000 * DAY;
    noteInbound(db, "pi", "old", "x", META, now - 181 * DAY);
    for (let i = 0; i < 5; i++) noteInbound(db, "pi", `m${i}`, "x", META, now - i);
    noteInbound(db, "codex", "c1", "x", META, now);
    pruneInbound(db, now, 3);
    expect(inboundLookup(db, "pi")("old")).toBeNull();
    expect((db.query("SELECT mid FROM inbound_ledger ORDER BY ms DESC").all() as { mid: string }[]).map((r) => r.mid).sort()).toEqual(["c1", "m0", "m1"]);
    forgetInbound(db, "agent-pi");
    expect((db.query("SELECT agent FROM inbound_ledger").all() as { agent: string }[]).map((r) => r.agent)).toEqual(["agent-codex"]);
  });
  test("库在磁盘上：关库重开仍查得到；文件只给本 OS 用户读写", () => {
    const path = join(dir, "restart.sqlite");
    noteInbound(openWebState(path), "pi", "api_1", "正文", META, Date.now());
    closeWebState(path);
    expect(inboundLookup(openWebState(path), "pi")("api_1")?.sha).toBe(inboundSha("正文"));
    expect(statSync(path).mode & 0o777).toBe(0o600);
    closeWebState(path);
  });
});

/** 押后队列替身 + 投给某频道的信封（gate 只看 env.to.channelId） */
function heldSpy() {
  const envs: Envelope[] = [];
  return { envs, holdEnv: (e: Envelope) => envs.push(e) };
}
const envTo = (channelId: string) => ({ to: { kind: "local", channelId } }) as unknown as Envelope;
const meta = (mid: string) => ({ ...META, message_id: mid });

describe("bridge 接线（inboundLedgerGate / inboundFor）", () => {
  test("CC 不记；tmux Codex、ACP 宿主记；tmux 版 Pi 先清掉该 agent 已有的账再放行", async () => {
    setWebStatePathForTest(join(dir, "wiring.sqlite"));
    const held = heldSpy();
    expect(await inboundLedgerGate(envTo("c-cc"), undefined, "cc", "x", meta("cc_1"), held)).toBeNull();
    expect(await inboundLedgerGate(envTo("c-codex"), "codex", "codex", "x", meta("cx_1"), held)).toBeNull();
    noteAcpChannel("c-pi", "acp");
    expect(await inboundLedgerGate(envTo("c-pi"), "pi", "pi", "x", meta("pi_1"), held)).toBeNull();
    expect(inboundFor("cc")("cc_1")).toBeNull();
    expect(inboundFor("codex")("cx_1")?.sha).toBe(inboundSha("x"));
    expect(inboundFor("pi")("pi_1")?.sha).toBe(inboundSha("x"));
    noteAcpChannel("c-pi", undefined); // 回退到 tmux 版 Pi
    expect(await inboundLedgerGate(envTo("c-pi"), "pi", "pi", "<channel message_id=\"pi_1\">…", meta("pi_2"), held)).toBeNull();
    expect(inboundFor("pi")("pi_1")).toBeNull();
    expect(inboundFor("pi")("pi_2")).toBeNull();
    expect(inboundFor("codex")("cx_1")).not.toBeNull();
    expect(held.envs).toEqual([]);
  });
  test("web 状态库打不开（文件是垃圾）：包装投递照常发、不抛；tmux 版 Pi 清不掉账就押后；查账给永远查不到的", async () => {
    const junk = join(dir, "junk.sqlite");
    writeFileSync(junk, "this is not a database ".repeat(200));
    setWebStatePathForTest(junk);
    const held = heldSpy();
    expect(await inboundLedgerGate(envTo("c-codex"), "codex", "codex", "x", meta("j1"), held)).toBeNull();
    const env = envTo("c-junk-pi");
    expect((await inboundLedgerGate(env, "pi", "pi", "x", meta("j2"), held))?.outcome).toEqual({ kind: "sent", note: "queued" });
    expect(held.envs).toEqual([env]);
    expect(inboundFor("codex")("j1")).toBeNull();
  });
});
