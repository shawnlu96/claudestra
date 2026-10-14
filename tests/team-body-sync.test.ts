import { expect, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { recordReview } from "../src/lib/ledger-write.js";
import { listEvents } from "../src/lib/ledger-store.js";
import { readSharedLedgerMirrors } from "../src/lib/shared-ledger-mirror.js";
import { TEAM_BODY_BATCH_MAX_BYTES, TEAM_BODY_TEXT_MAX_BYTES, teamBodyUploadBytes } from "../src/lib/shared-ledger-contract-team-body.js";
import { TEAM_BODY_MASK, TEAM_BODY_SCRUB_VERSION } from "../src/lib/team-body-scrub.js";
import { readTeamBodySync, syncTeamBodies, TEAM_BODY_TRUNCATED, teamBodyText } from "../src/lib/team-body-sync.js";
import { mirrorEntry, SCRUB } from "./shared-ledger-mirror-fixture.test.js";
import { KNOWN, REFUSED, world } from "./team-body-sync-fixture.test.js";

const KEY = "ghp_" + "A1b2C3d4E5f6G7h8I9j0K1l2M3n4";

test("on: a new event goes up once, scrubbed; a refused text is not sent and is recorded", async () => {
  const w = await world("on");
  try {
    const plain = w.note("开工：先读规格");
    const secret = w.note(`第一段说明\n\ntoken ${KEY}\n\n收尾`);
    const refused = w.note(REFUSED);
    await w.pass(KNOWN);
    const [batch, ...rest] = w.uploads();
    expect(rest).toHaveLength(0);
    expect(w.requests.filter((r) => r.path.endsWith("/team-body/batches"))).toHaveLength(1);
    expect(w.requests[0]!.path).toBe("/v1/teams/team-a/team-body/capability");
    expect(batch!.records.map((r) => r.sourceKey)).toEqual([String(plain), String(secret)]);
    expect(batch!.records[0]).toMatchObject({ featureId: "center-feature-1", taskId: "c5-existing", kind: "event", text: "开工：先读规格", maskedSegments: 0 });
    expect(batch!.records[1]).toMatchObject({ text: `第一段说明\n\n${TEAM_BODY_MASK}\n\n收尾`, maskedSegments: 1, scrubVersion: TEAM_BODY_SCRUB_VERSION });
    expect(JSON.stringify(w.uploads())).not.toContain(KEY);
    expect(JSON.stringify(w.uploads())).not.toContain("alpha line");
    const st = readTeamBodySync(w.dir).features[w.f.id]!;
    expect(st.eventSeq).toBe(refused);
    expect(st.refused).toEqual([{ taskId: "c5-existing", kind: "event", sourceKey: String(refused), by: "scrub", at: w.now() }]);
    // Nothing new: the next pass sends nothing, and a capability answer is reused for an hour.
    w.advance(10_000);
    await w.pass(KNOWN);
    expect(w.requests).toHaveLength(2);
    w.note("下一条");
    w.advance(10_000);
    await w.pass(KNOWN);
    expect(w.requests.map((r) => r.method)).toEqual(["GET", "POST", "POST"]);
    expect(w.uploads()[1]!.records.map((r) => r.text)).toEqual(["下一条"]);
  } finally { await w.f.close(); }
});

test("on: review conclusions and the spec text go up with their kinds; a new specRev goes up again", async () => {
  const w = await world("on");
  try {
    writeFileSync(join(w.docs, "tasks", "c5-existing.md"), "# 规格\n正文");
    w.f.db.prepare("INSERT INTO events (ts, actor, project, target, kind, text, data) VALUES (?, 'agent-r', ?, 'c5-existing', 'review', 'P1：缺少校验', '{}')")
      .run(1, w.f.project);
    await w.pass();
    const records = w.uploads().flatMap((u) => u.records);
    expect(records.map((r) => [r.kind, r.text])).toEqual([["review", "P1：缺少校验"], ["spec", "# 规格\n正文"]]);
    expect(records[1]!.sourceKey).toBe("1");
    w.advance(10_000);
    await w.pass();
    expect(w.uploads()).toHaveLength(1);
    w.f.db.prepare("UPDATE tasks SET specRev = 2 WHERE id = 'c5-existing'").run();
    writeFileSync(join(w.docs, "tasks", "c5-existing.md"), "# 规格\n第二版");
    w.advance(10_000);
    await w.pass();
    expect(w.uploads()[1]!.records).toMatchObject([{ kind: "spec", sourceKey: "2", text: "# 规格\n第二版" }]);
  } finally { await w.f.close(); }
});

test("on: a verdict recorded without text goes up from its data, and the watermark only passes it once it is sent", async () => {
  const w = await world("on");
  try {
    w.f.db.prepare("UPDATE tasks SET stage = 'review' WHERE id = 'c5-existing'").run();
    const review = recordReview(w.f.db, { actor: "agent-r" }, { taskId: "c5-existing", reviewer: "agent-r", verdict: "changes", p0: 0, p1: 1, p2: 0,
      path: "/Users/someone/.claude-orchestrator/reviews/c5-existing-r1.md" }).event.seq;
    expect(w.f.db.prepare("SELECT text FROM events WHERE seq = ?").get(review)).toEqual({ text: "" });
    const after = w.note("之后的普通事件");
    await w.pass();
    const records = w.uploads().flatMap((u) => u.records);
    expect(records.map((r) => [r.kind, r.sourceKey])).toEqual([["review", String(review)], ["event", String(after)]]);
    expect(records[0]!.text).toContain("审查结论 changes · P0 0 / P1 1 / P2 0");
    expect(records[0]!.text).toContain("c5-existing-r1.md");
    expect(records[0]!.text).not.toContain("/Users/someone");
  } finally { await w.f.close(); }
});

test("on: a finding with only its probe (older and CLI records carry no description) goes up with that probe", async () => {
  const w = await world("on");
  try {
    const head = "a".repeat(40);
    w.f.db.prepare("UPDATE tasks SET stage = 'review', headSHA = ? WHERE id = 'c5-existing'").run(head);
    recordReview(w.f.db, { actor: "agent-r" }, { taskId: "c5-existing", reviewer: "agent-r", verdict: "changes", p0: 0, p1: 2, p2: 0,
      path: "/Users/someone/.claude-orchestrator/reviews/c5-existing-r1.md", head, reviewerSessionId: "s-1", reviewerFamily: "codex",
      findings: [{ findingId: "race-1", family: "concurrency", severity: "P1", probe: "[回归] src/example.ts:10 并发提交会重复扣款" },
        // The MCP verdict's description rides in data beside the CLI input's fields.
        { findingId: "race-2", family: "concurrency", severity: "P1", probe: "[回归] src/example.ts:20 二次退款", ...{ description: "退款没有幂等" } }] });
    await w.pass();
    const text = w.uploads().flatMap((u) => u.records).find((r) => r.kind === "review")!.text;
    expect(text).toContain("- [P1] race-1\n  复现：[回归] src/example.ts:10 并发提交会重复扣款");
    expect(text).toContain("- [P1] race-2：退款没有幂等\n  复现：[回归] src/example.ts:20 二次退款");
  } finally { await w.f.close(); }
});

test("on: a text the contract cannot carry is refused alone; the records after it still go up", async () => {
  const w = await world("on");
  try {
    const bad = w.note("含\0空字符");
    const good = w.note("合法的下一条");
    await w.pass();
    expect(w.uploads().flatMap((u) => u.records.map((r) => r.sourceKey))).toEqual([String(good)]);
    const st = readTeamBodySync(w.dir).features[w.f.id]!;
    expect(st).toMatchObject({ eventSeq: good, failures: 0, refusedTotal: 1 });
    expect(st.refused).toEqual([{ taskId: "c5-existing", kind: "event", sourceKey: String(bad), by: "invalid", at: w.now() }]);
  } finally { await w.f.close(); }
});

test("a switch turned off or to observe during the pass stops the next request; nothing counts as a failure", async () => {
  for (const to of ["off", "observe"] as const) {
    const w = await world("on");
    try {
      w.note("开工");
      w.onCapability(() => w.policy(to));
      await w.pass();
      expect(w.requests.map((r) => r.method)).toEqual(["GET"]);
      expect(readTeamBodySync(w.dir).features[w.f.id]).toMatchObject({ eventSeq: 0, failures: 0, nextAttemptAt: 0 });
    } finally { await w.f.close(); }
  }
});

test("a switch turned off while the pass awaits writes no note: neither the observe count nor the unsupported note", async () => {
  const unsupported = (w: Awaited<ReturnType<typeof world>>) => listEvents(w.f.db, { project: w.f.project }).filter((e) => e.data.op === "team-body-unsupported");
  const o = await world("observe");
  try {
    o.note("开工");
    o.onScrub(() => o.policy("off"));
    await o.pass();
    expect(o.requests).toHaveLength(0);
    expect(o.observed()).toHaveLength(0);
  } finally { await o.f.close(); }
  const w = await world("on");
  try {
    w.note("开工");
    w.setCapability(() => new Response("not found", { status: 404 }));
    w.onCapability(() => w.policy("off"));
    await w.pass();
    expect(w.requests.map((r) => r.method)).toEqual(["GET"]);
    expect(unsupported(w)).toHaveLength(0);
    expect(w.observed()).toHaveLength(0);
  } finally { await w.f.close(); }
});

test("observe: zero requests and one count note per feature per hour; off: zero requests, zero notes", async () => {
  const w = await world("observe");
  try {
    w.note("开工");
    w.note(`token ${KEY}`);
    w.note(REFUSED);
    await w.pass(KNOWN);
    expect(w.requests).toHaveLength(0);
    const notes = w.observed();
    expect(notes).toHaveLength(1);
    expect(notes[0]).toMatchObject({ target: "", data: { mechanism: "teamBody", featureId: w.f.id, upload: 2, masked: 1, refused: 1 } });
    expect(notes[0]!.text).toContain("上传团队正文 2 条、遮蔽 1 段、拒绝 1 条");
    w.advance(10 * 60_000);
    w.note("又一条");
    await w.pass(KNOWN);
    expect(w.observed()).toHaveLength(1);
    w.advance(60 * 60_000);
    await w.pass(KNOWN);
    expect(w.observed()).toHaveLength(2);
    expect(w.requests).toHaveLength(0);
    // off: neither a request nor a note, and the body state is left as it was.
    w.policy("off");
    const before = readFileSync(join(w.dir, "team-body-sync.json"), "utf8");
    w.advance(2 * 60 * 60_000);
    w.note("关着的时候");
    await w.pass(KNOWN);
    expect(w.requests).toHaveLength(0);
    expect(w.observed()).toHaveLength(2);
    expect(readFileSync(join(w.dir, "team-body-sync.json"), "utf8")).toBe(before);
  } finally { await w.f.close(); }
});

test("a failing body upload leaves the planning watermark and the projection requests exactly as they are", async () => {
  // The same pass twice from the same ledger and mirror state: body off, then body on with every upload failing.
  const w = await world("off");
  try {
    for (let i = 0; i < 5; i++) w.note(`进展 ${i}`);
    const mirrors = join(w.dir, "shared-ledger-mirrors.json"), saved = readFileSync(mirrors, "utf8");
    await w.pass();
    const off = { projections: structuredClone(w.projections), entry: readSharedLedgerMirrors(w.dir)[w.f.id] };
    expect(w.requests).toHaveLength(0);
    writeFileSync(mirrors, saved);
    w.projections.length = 0;
    w.policy("on");
    w.failing(true);
    await w.pass();
    expect(w.uploads()).toHaveLength(1);
    expect(w.projections).toEqual(off.projections);
    expect(readSharedLedgerMirrors(w.dir)[w.f.id]).toEqual(off.entry);
    const st = readTeamBodySync(w.dir).features[w.f.id]!;
    expect(st).toMatchObject({ eventSeq: 0, failures: 1, nextAttemptAt: w.now() + 10_000, lastError: "center unavailable; outcome unconfirmed" });
    // Its own bounded backoff: nothing before nextAttemptAt, then a retry that sends the same records.
    w.advance(5_000);
    await w.pass();
    expect(w.uploads()).toHaveLength(1);
    w.failing(false);
    w.advance(5_000);
    await w.pass();
    expect(w.uploads()).toHaveLength(2);
    expect(w.uploads()[1]!.records.map((r) => r.text)).toEqual(w.uploads()[0]!.records.map((r) => r.text));
    expect(readTeamBodySync(w.dir).features[w.f.id]).toMatchObject({ failures: 0, nextAttemptAt: 0, lastError: null });
  } finally { await w.f.close(); }
});

test("a body 429 holds projections globally until Retry-After, then projection resumes", async () => {
  const run = async (mode: "on" | "off") => {
    const w = await world(mode);
    try {
      for (let i = 0; i < 3; i++) w.note(`进展 ${i}`);
      w.failing(() => new Response("slow down", { status: 429, headers: { "retry-after": "60" } }));
      await w.pass();
      const first = w.projections.length, before = readSharedLedgerMirrors(w.dir)[w.f.id]!.watermark;
      const seq = w.note("下一条");
      w.advance(10_000);
      await w.pass();
      const paused = { added: w.projections.length - first, mark: readSharedLedgerMirrors(w.dir)[w.f.id]!.watermark, posts: w.uploads().length };
      w.failing(false);
      w.advance(60_000);
      await w.pass();
      return { ...paused, before, seq, resumed: w.projections.length - first - paused.added, final: readSharedLedgerMirrors(w.dir)[w.f.id]!.watermark };
    } finally { await w.f.close(); }
  };
  const off = await run("off"), on = await run("on");
  expect(off.posts).toBe(0);
  expect(on.posts).toBe(1);
  expect(off.added).toBe(1);
  expect(on.added).toBe(0);
  expect(on.mark).toBe(on.before);
  expect(on.mark).toBeLessThan(on.seq);
  expect(on.resumed).toBe(1);
  expect(on.final).toBe(on.seq);
  expect(off.final).toBe(off.seq);
});

test("backlog: 300 records go up over two passes, 200 then 100, none twice; a newer scrub version sends them again", async () => {
  const w = await world("on");
  try {
    const seqs = Array.from({ length: 300 }, (_, i) => w.note(`存量 ${i}`));
    await w.pass();
    const first = w.uploads().flatMap((u) => u.records.map((r) => r.sourceKey));
    expect(first).toEqual(seqs.slice(0, 200).map(String));
    expect(w.uploads().every((u) => u.records.length <= 100)).toBe(true);
    w.advance(10_000);
    await w.pass();
    const all = w.uploads().flatMap((u) => u.records.map((r) => r.sourceKey));
    expect(all).toEqual(seqs.map(String));
    expect(new Set(all).size).toBe(300);
    w.advance(10_000);
    await w.pass();
    expect(w.uploads().flatMap((u) => u.records)).toHaveLength(300);
    // State written by an older scrub: the watermark starts over and old records are sent again.
    const path = join(w.dir, "team-body-sync.json"), file = JSON.parse(readFileSync(path, "utf8"));
    file.features[w.f.id].scrubVersion = TEAM_BODY_SCRUB_VERSION - 1;
    writeFileSync(path, JSON.stringify(file));
    w.advance(10_000);
    await w.pass();
    expect(w.uploads().flatMap((u) => u.records).slice(300).map((r) => r.sourceKey)).toEqual(seqs.slice(0, 200).map(String));
  } finally { await w.f.close(); }
});

test("a center without the capability: nothing is uploaded, one note a day", async () => {
  const w = await world("on");
  try {
    w.setCapability(() => new Response("not found", { status: 404 }));
    w.note("开工");
    await w.pass();
    const unsupported = () => listEvents(w.f.db, { project: w.f.project }).filter((e) => e.data.op === "team-body-unsupported");
    expect(w.uploads()).toHaveLength(0);
    expect(unsupported()).toHaveLength(1);
    for (let i = 0; i < 3; i++) { w.advance(2 * 60 * 60_000); await w.pass(); }
    expect(w.uploads()).toHaveLength(0);
    expect(unsupported()).toHaveLength(1);
    // A 200 that says teamBody false is unsupported too; the next day gets its note.
    w.setCapability(() => Response.json({ schemaVersion: 1, teamId: "team-a", teamBody: false }));
    w.advance(24 * 60 * 60_000);
    await w.pass();
    expect(w.uploads()).toHaveLength(0);
    expect(unsupported()).toHaveLength(2);
    // The capability turns up: the next probe (an hour on) uploads.
    w.setCapability(() => Response.json({ schemaVersion: 1, teamId: "team-a", teamBody: true }));
    w.advance(60 * 60_000);
    await w.pass();
    expect(w.uploads()[0]!.records.map((r) => r.text)).toEqual(["开工"]);
  } finally { await w.f.close(); }
});

test("long text is cut after scrubbing to 900 KiB with the note, and every batch stays within 1 MiB of JSON", async () => {
  const w = await world("on");
  try {
    const long = `${"长".repeat(400_000)}`;
    const quoted = '"\n'.repeat(500_000);
    w.note(long);
    w.note(quoted);
    // A key run takes the key characters after it (team-body-scrub.ts runsOf): the 。 ends it before the long paragraph.
    w.note(`前言\n\ntoken ${KEY}。\n\n${"说".repeat(400_000)}`);
    await w.pass();
    const records = w.uploads().flatMap((u) => u.records);
    expect(records).toHaveLength(3);
    for (const u of w.uploads()) expect(teamBodyUploadBytes(u)).toBeLessThanOrEqual(TEAM_BODY_BATCH_MAX_BYTES);
    // What the center receives: the signed body, transport envelope included, within 1 MiB.
    const posts = w.requests.filter((r) => r.method === "POST");
    expect(posts.length).toBeGreaterThan(0);
    for (const r of posts) expect(r.bodyBytes!).toBeLessThanOrEqual(TEAM_BODY_BATCH_MAX_BYTES);
    expect(Math.max(...posts.map((r) => r.bodyBytes!))).toBeGreaterThan(TEAM_BODY_BATCH_MAX_BYTES - 1024);
    for (const r of records) {
      expect(Buffer.byteLength(r.text, "utf8")).toBeLessThanOrEqual(TEAM_BODY_TEXT_MAX_BYTES);
      expect(r.text.endsWith(`\n${TEAM_BODY_TRUNCATED}`)).toBe(true);
    }
    expect(records[0]!.text.startsWith("长长长")).toBe(true);
    expect(records[2]!.text.startsWith(`前言\n\n${TEAM_BODY_MASK}\n\n说说说`)).toBe(true);
    expect(records[2]!.maskedSegments).toBe(1);
    // Quotes and line breaks double on the wire: that record is cut shorter than the text cap.
    expect(Buffer.byteLength(records[1]!.text, "utf8")).toBeLessThan(TEAM_BODY_BATCH_MAX_BYTES / 2 + 1024);
    expect(JSON.stringify(records)).not.toContain(KEY);
  } finally { await w.f.close(); }
});

test("a cut never splits a mask or a surrogate pair", () => {
  const masked = `${"a".repeat(10)}\n\ntoken ${KEY}\n\n${"b".repeat(10)}`;
  for (let max = 12; max < 40; max++) {
    const fits = (text: string) => text.length <= max + TEAM_BODY_TRUNCATED.length + 1;
    const out = teamBodyText(masked, SCRUB, fits);
    expect(out.refused).toBe(false);
    const body = out.text.slice(0, -(TEAM_BODY_TRUNCATED.length + 1));
    expect(body.includes("[已遮蔽") && !body.includes(TEAM_BODY_MASK)).toBe(false);
  }
  const emoji = "😀".repeat(20);
  const out = teamBodyText(emoji, SCRUB, (text) => text.length <= 5 + TEAM_BODY_TRUNCATED.length + 1);
  expect(out.text).toBe(`😀😀\n${TEAM_BODY_TRUNCATED}`);
});

test("syncTeamBodies never throws, whatever breaks", async () => {
  const w = await world("on");
  try {
    w.note("开工");
    await syncTeamBodies(w.f.db, [[w.f.id, readSharedLedgerMirrors(w.dir)[w.f.id]!]], { ...w.deps(), scrub: async () => { throw new Error("no identity"); } });
    expect(readTeamBodySync(w.dir).features[w.f.id]).toMatchObject({ failures: 1 });
    await syncTeamBodies(w.f.db, [["missing-feature", mirrorEntry(w.f, 0)]], { ...w.deps(), stateDir: join(w.dir, "nope", "\0") });
  } finally { await w.f.close(); }
});

test("the mirror loop calls the body sync in exactly one place", () => {
  const source = readFileSync(join(import.meta.dir, "../src/lib/shared-ledger-mirror-loop.ts"), "utf8");
  // The import, the comment above the call, the call.
  expect(source.split("\n").filter((line) => /team-body|TeamBod/.test(line))).toHaveLength(3);
  expect(source.match(/syncTeamBodies\(/g)).toHaveLength(1);
});
