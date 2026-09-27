/**
 * bridge/agent-calls.ts：send_to_agent 回程路由簿落盘——bridge 重启后对方的答复仍能推回发起方；
 * 坏文件不让 bridge 起不来；touch 重新起算失效钟并落盘。
 */
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentCallBook, type PendingAgentCall } from "../src/bridge/agent-calls.js";

const dir = mkdtempSync(join(tmpdir(), "agent-calls-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
const call = (ts: number): PendingAgentCall => ({
  callerChannelId: "c-me", callerName: "agent-claudestra", targetName: "agent-codex",
  originalReplyChannel: "api:owner:self", expecting: "按意见改设计稿", ts,
});

describe("AgentCallBook", () => {
  test("set 落盘，新实例（= bridge 重启）原样恢复", () => {
    const p = join(dir, "a.json");
    new AgentCallBook(p).set("c-codex", call(1000));
    const back = new AgentCallBook(p).get("c-codex");
    expect(back).toEqual(call(1000));
  });

  test("delete 之后文件里也没了", () => {
    const p = join(dir, "b.json");
    const book = new AgentCallBook(p);
    book.set("c-codex", call(1000));
    book.set("c-pi", { ...call(1000), targetName: "agent-pi" });
    book.delete("c-codex");
    expect(Object.keys(JSON.parse(readFileSync(p, "utf8")))).toEqual(["c-pi"]);
  });

  test("touch 重新起算失效钟并落盘；不存在的 key 什么都不做", () => {
    const p = join(dir, "c.json");
    const book = new AgentCallBook(p);
    book.set("c-codex", call(1000));
    book.touch("c-codex", 5000);
    book.touch("c-nobody", 5000);
    expect(new AgentCallBook(p).get("c-codex")?.ts).toBe(5000);
    expect(book.has("c-nobody")).toBe(false);
  });

  test("坏文件 / 形状不对：不抛、不恢复，原文件挪成 .corrupt-* 保留，之后正常落盘", () => {
    const sub = mkdtempSync(join(dir, "bad-"));
    const p = join(sub, "d.json");
    writeFileSync(p, "{not json");
    expect(new AgentCallBook(p).size).toBe(0);
    writeFileSync(p, JSON.stringify({ "c-codex": { callerChannelId: "c-me" } }));
    const book = new AgentCallBook(p);
    expect(book.size).toBe(0);
    const kept = readdirSync(sub).filter((f) => f.startsWith("d.json.corrupt-"));
    expect(kept.length).toBe(2);
    expect(kept.map((f) => readFileSync(join(sub, f), "utf8")).sort()).toEqual(['{"c-codex":{"callerChannelId":"c-me"}}', "{not json"]);
    book.set("c-codex", call(1));
    expect(new AgentCallBook(p).get("c-codex")?.ts).toBe(1);
  });

  test("path = null 不落盘", () => {
    const book = new AgentCallBook(null);
    book.set("c-codex", call(1));
    expect(book.get("c-codex")?.callerName).toBe("agent-claudestra");
  });
});
