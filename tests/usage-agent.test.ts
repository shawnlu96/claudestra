import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { agentUsage, parseAgentUsageOptions } from "../src/lib/usage-agent.js";
import { usageSummary } from "../src/lib/usage-query.js";
import { openUsageDb, retentionCutoff, usageWriter } from "../src/lib/usage-store.js";
import { currentUsageWindow } from "../src/lib/usage-window.js";
import { handleUsageApi, setUsageDbPathForTest } from "../src/bridge/local-api/usage.js";
import { effectivePrincipal, type DeviceCredential } from "../src/lib/devices.js";

const now = Date.now(), day = currentUsageWindow(now).dayStart;
const OWNER = effectivePrincipal({
  principal: { id: "owner:self", role: "owner", agents: ["*"], createdAt: "2026-01-01" },
  credential: { id: "dev_test", grant: { agents: ["*"], manage: true }, type: "bearer" } as DeviceCredential,
});
function fixture() {
  const path = join(mkdtempSync(join(tmpdir(), "usage-agent-")), "usage.sqlite");
  return { path, db: openUsageDb(path) };
}
function turn(db: Database, id: string, startedAt: number, agent = "agent-a", runtime = "claude-code", callAt = startedAt) {
  const w = usageWriter(db);
  w.turn({ turnId: `secret-session:${id}`, sessionId: "secret-session", agent, sidechain: id === "child", startedAt,
    runtime, kind: "channel", trigger: "脱敏 [REDACTED] /Users/private/file secret-session " + "好".repeat(100) });
  w.call({ key: id, ts: callAt, model: "same-model", input: 11, cacheCreation: 13, cacheRead: 17, output: 19, reasoning: runtime === "codex" ? 23 : 0,
    tools: [] }, `secret-session:${id}`);
}
afterEach(() => setUsageDbPathForTest(null));

function call(query = "", method = "GET") {
  return handleUsageApi(new Request(`http://test/api/v1/usage/agent/agent-a${query}`, { method }), "/usage/agent/agent-a", OWNER)!;
}

test("today matches CLI summary by runtime/model, including midnight, sidechains and exact cache/reasoning totals", () => {
  const { db } = fixture();
  turn(db, "midnight", day - 100, "agent-a", "claude-code", day + 1);
  turn(db, "child", day + 2, "agent-a", "codex");
  turn(db, "other", day + 3, "agent-b", "codex");
  turn(db, "yesterday", day - 1000);
  turn(db, "too-old", now - 8 * 86400_000);
  const result = agentUsage(db, "agent-a", { since: day, limit: 20 }, now);
  const cli = usageSummary(db, day).filter((r) => r.agent === "agent-a").map(({ agent, ...r }) => r);
  expect(result.today!.rows).toEqual(cli);
  expect(result.today!.total).toEqual({ input: 22, cacheCreation: 26, cacheRead: 34, output: 38, reasoning: 23, calls: 2, totalTokens: 143 });
  expect(result.week!.total.calls).toBe(3);
  expect(result.turns).toHaveLength(1); // since filters turn starts; the summary independently filters call times.
  expect(result.today!.rows.find((r) => r.runtime === "codex")!.modelBasis).toBe("request");
  db.close();
});

test("bounded pages remain distinct at equal timestamps and after a newer turn arrives; tools are top three", () => {
  const { db } = fixture();
  db.transaction(() => { for (let i = 0; i < 600; i++) turn(db, `t${i}`, day + 10); })();
  for (let i = 0; i < 10; i++) {
    for (let j = 0; j <= i; j++) usageWriter(db).tool(`${i}-${j}`, "secret-session:t599", `tool${i}`);
  }
  const first = agentUsage(db, "agent-a", { since: 0, limit: 20 }, now);
  expect(first.turns).toHaveLength(20);
  expect(first.turns[0].tools).toEqual([{ name: "tool9", count: 10 }, { name: "tool8", count: 9 }, { name: "tool7", count: 8 }]);
  expect(Buffer.byteLength(JSON.stringify(first))).toBeLessThan(200_000);
  turn(db, "new", day + 20);
  const all = [...first.turns]; let cursor = first.next;
  while (cursor) {
    const options = parseAgentUsageOptions(new URL(`http://x?before=${cursor}`))!;
    const page = agentUsage(db, "agent-a", options, now);
    expect(page.turns.length).toBeLessThanOrEqual(20);
    all.push(...page.turns); cursor = page.next;
  }
  expect(all).toHaveLength(600);
  expect(new Set(all.map((r) => r.id)).size).toBe(600);
  db.close();
});

test("public response excludes session/turn identities, local paths and excess summary text", async () => {
  const { db, path } = fixture(); turn(db, "t", day + 1);
  db.prepare("UPDATE turns SET attr_task = 'T4', attr_step = 'write', attr_round = 0, attr_basis = 'session'").run();
  db.close(); setUsageDbPathForTest(path);
  const res = await call().json() as ReturnType<typeof agentUsage>; const text = JSON.stringify(res);
  expect(res.turns[0].attr).toEqual({ task: "T4", step: "write", round: 0, basis: "session" });
  expect(res.turns[0].trigger.length).toBeLessThanOrEqual(80);
  for (const hidden of ["sessionId", "turnId", "secret-session", "/Users/", "filePath"]) expect(text).not.toContain(hidden);
  expect(res.turns[0].trigger).toContain("[REDACTED]");
});

test("readonly API leaves database bytes and uncomputed attribution unchanged", async () => {
  const { db, path } = fixture(); turn(db, "t", day + 1); db.close();
  setUsageDbPathForTest(path);
  const before = readFileSync(path);
  expect(call().status).toBe(200);
  expect(readFileSync(path)).toEqual(before);
  const readonly = new Database(path, { readonly: true });
  expect(readonly.query("SELECT attr_basis FROM turns").get()).toEqual({ attr_basis: null });
  expect(readonly.query("SELECT count(*) AS n FROM daily").get()).toEqual({ n: 0 });
  readonly.close();
  for (const method of ["POST", "PUT", "DELETE", "PATCH"]) expect(call("", method).status).toBe(405);
});

test("path masking covers arbitrary local roots without changing a source URL", () => {
  const { db } = fixture(); turn(db, "paths", day + 1);
  for (const path of ["/workspace/repo/file", "~/project/file", "C:\\repo\\file", "file:///srv/repo/file"]) {
    db.prepare("UPDATE turns SET trigger = ?").run(`${path} https://example.test/docs`);
    const trigger = agentUsage(db, "agent-a", { since: 0, limit: 20 }, now).turns[0].trigger;
    expect(trigger).toBe("[path] https://example.test/docs");
  }
  db.close();
});

test("absolute paths after colons or quotes, single roots and spaced names are fully masked", () => {
  const { db } = fixture(); turn(db, "paths", day + 1);
  for (const path of ["/tmp", "~/secret", "/Users/private/my file.txt", "~/my project", "/"]) {
    for (const [source, expected] of [[`path:${path}`, "path:[path]"], [`'${path}'`, "'[path]"],
      [`"${path}"`, '"[path]']]) {
      db.prepare("UPDATE turns SET trigger = ?").run(source);
      expect(agentUsage(db, "agent-a", { since: 0, limit: 20 }, now).turns[0].trigger).toBe(expected);
    }
  }
  db.close();
});

test("path punctuation and quotes cannot expose any suffix, and following URLs survive", () => {
  const { db } = fixture(); turn(db, "punctuation", day + 1);
  for (const mark of [",", ";", "!", "?", ")", "'", '"']) {
    for (const root of ["/private/", "~/", "file:///", "X:\\"]) {
      const path = `${root}hidden${mark}suffix/file`;
      for (const tail of ["", " https://example.test/docs", "http://example.test/docs"]) {
        db.prepare("UPDATE turns SET trigger = ?").run(`path:${path}${tail}`);
        const trigger = agentUsage(db, "agent-a", { since: 0, limit: 20 }, now).turns[0].trigger;
        expect(trigger).toBe("path:[path]" + (tail ? " " + tail.trim() : ""));
        for (const fragment of [root, "hidden", "suffix", "file"]) expect(trigger).not.toContain(fragment);
      }
    }
  }
  db.prepare("UPDATE turns SET trigger = ?").run("path:/hidden,quoted\nnext line");
  expect(agentUsage(db, "agent-a", { since: 0, limit: 20 }, now).turns[0].trigger).toBe("path:[path]\nnext line");
  db.close();
});

test("a call retained across the cutoff prevents expiry even when its turn is filtered out", () => {
  const { db } = fixture(), cutoff = retentionCutoff(now);
  db.prepare(`INSERT INTO daily (day,agent,runtime,model,calls,input,cache_creation,cache_read,output,reasoning)
    VALUES ('2000-01-01','agent-a','claude-code','m',1,1,0,0,1,0)`).run();
  turn(db, "boundary", cutoff - 1000, "agent-a", "claude-code", cutoff + 1000);
  expect(agentUsage(db, "agent-a", { since: 0, limit: 20 }, now).state).toBe("ready");
  const filtered = agentUsage(db, "agent-a", { since: cutoff - 500, limit: 20 }, now);
  expect(filtered.turns).toEqual([]);
  expect(filtered.state).toBe("empty");
  db.close();
});

test("filtered and exhausted pages do not mistake old daily totals for expired details", () => {
  const { db } = fixture();
  db.prepare(`INSERT INTO daily (day,agent,runtime,model,calls,input,cache_creation,cache_read,output,reasoning)
    VALUES ('2000-01-01','agent-a','claude-code','m',1,1,0,0,1,0)`).run();
  turn(db, "current", day + 1);
  expect(agentUsage(db, "agent-a", { since: day + 2, limit: 20 }, now).state).toBe("empty");
  expect(agentUsage(db, "agent-a", { since: 0, limit: 20, before: { at: 0, row: 0 } }, now).state).toBe("empty");
  db.prepare("DELETE FROM calls").run();
  expect(agentUsage(db, "agent-a", { since: now, limit: 20 }, now).state).toBe("empty");
  expect(agentUsage(db, "agent-a", { since: 0, limit: 20 }, now).state).toBe("expired");
  db.close();
});

test("missing store, empty agent and expired details are successful empty states", async () => {
  const { db, path } = fixture();
  expect(agentUsage(db, "agent-a", { since: 0, limit: 20 }, now).state).toBe("empty");
  db.prepare(`INSERT INTO daily (day,agent,runtime,model,calls,input,cache_creation,cache_read,output,reasoning)
    VALUES ('2000-01-01','agent-a','claude-code','m',1,1,0,0,1,0)`).run();
  expect(agentUsage(db, "agent-a", { since: 0, limit: 20 }, now).state).toBe("expired");
  db.close(); setUsageDbPathForTest(path + ".missing");
  expect(await call().json()).toMatchObject({ ok: true, state: "missing", turns: [], next: null });
  expect(existsSync(path + ".missing")).toBe(false);
});

test("short web names resolve the same agent, while exact names take precedence", () => {
  const { db } = fixture(); turn(db, "prefixed", day + 1);
  expect(agentUsage(db, "a", { since: 0, limit: 20 }, now).today!.total.calls).toBe(1);
  turn(db, "bare", day + 2, "a", "codex");
  expect(agentUsage(db, "a", { since: 0, limit: 20 }, now).today!.total.reasoning).toBe(23);
  db.close();
});

describe("query bounds", () => {
  for (const q of ["?since=no", "?since=-1", "?limit=0", "?limit=1.5", "?limit=Infinity", "?before=abc", "?before=1.2.3"]) {
    test(q, () => expect(call(q).status).toBe(400));
  }
  test("defaults, ISO since, hard limit cap", () => {
    expect(parseAgentUsageOptions(new URL("http://x"))).toEqual({ since: 0, limit: 20 });
    expect(parseAgentUsageOptions(new URL("http://x?limit=100000&since=2026-10-01T00:00:00Z")))
      .toEqual({ since: Date.parse("2026-10-01T00:00:00Z"), limit: 100 });
  });
});
