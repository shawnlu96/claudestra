import { afterEach, beforeEach, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { askOrder, openOrderAsk, type AskDeps } from "../src/lib/order-ask.js";
import { ASK_DEFAULT_MS, recordDefaultPmReply, sweepAskDefaults } from "../src/lib/order-ask-default.js";
import { getAsk, listAsks, openAskFull, patchAsk } from "../src/lib/ledger-asks.js";
import { closeLedger, getTask, listEvents, openLedger } from "../src/lib/ledger-store.js";
import { appendEvent, createTask, setMeta } from "../src/lib/ledger-write.js";
import { parseV2Request } from "../src/lib/lend-wire-v2.js";
import type { PmNoticeLevel } from "../src/lib/pm-notice-level.js";
import type { RecoveryMode, RecoveryPolicyPort } from "../src/lib/recovery-policy.js";

let db: Database, dir: string, dbPath: string, spec: string, mode: RecoveryMode;
let notices: { to: string; text: string; id: string; level: PmNoticeLevel }[];
let told: { to: string | null; text: string }[];
const now = 1_000_000;
const SPEC = "# T1 卡\n模板：code\n\n## 范围\n\n- src/lib/x.ts\n\n精准例外（不进 fileGlobs）：src/lib/a.ts 只加一行；`src/lib/b.ts` 只改注释\n";
const who = { agent: "agent-author", sessionId: "s", channelId: "ch", family: "codex" };
const policy: RecoveryPolicyPort = () => ({ mode, manualAfterMs: null, source: "config" });
const deps = (): AskDeps => ({ db, policy, open: (x) => openAskFull(db, x, now),
  notify: async (to, text, id, level) => (notices.push({ to, text, id, level }), { handed: true, note: "queued" }),
  markHanded: (id) => patchAsk(db, id, { extra: { notice: "handed" } }), record: (ctx, x) => void appendEvent(db, ctx, x) });
const sweepDeps = () => ({
  notify: async (to: string, text: string, id: string, level: PmNoticeLevel) => (notices.push({ to, text, id, level }), { handed: true, note: "q" }),
  tell: async (a: { fromAgent: string | null }, text: string) => (told.push({ to: a.fromAgent, text }), true),
});
const remote = (q: Record<string, unknown>, orderId = "pool") =>
  openOrderAsk(db, deps(), { task: getTask(db, "T1")!, orderId, from: "worker@peer", keyPrefix: "lend" }, { question: "远端", options: [], ...q });
const local = async (q: Record<string, unknown>) => askOrder(who, { v: 1, orderId: "T1:write:r0", question: "本机", ...q }, deps());
const idOf = (r: unknown): string => (r as { askId: string }).askId;
const notes = (op: string) => listEvents(db, { target: "T1" }).filter((e) => e.data.op === op);

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "ask-default-all-")); dbPath = join(dir, "ledger.db"); spec = join(dir, "T1.md");
  writeFileSync(spec, SPEC); db = openLedger(dbPath); notices = []; told = []; mode = "on";
  setMeta(db, { actor: "owner" }, { project: "p", key: "pms", value: ["agent-pm"] });
  createTask(db, { actor: "owner" }, { id: "T1", project: "p", title: "默认", kind: "code", agent: who.agent, pm: "agent-pm", spec });
  db.run("UPDATE tasks SET stage = 'build' WHERE id = 'T1'");
  // 真表：远端单挂在别的卡上（本机 T1 的单不算被借走），只按 step 判写单
  for (const [orderId, step] of [["pool", "write"], ["poolfix", "fix"]]) {
    db.run(`INSERT INTO lend_orders (orderId, taskId, project, peer, family, step, specRev, round, head, repo, wire, text, sha256, status, leaseMs, createdBy, createdAt, updatedAt)
      VALUES (?, ?, 'p', 'peer', 'claude', ?, 1, 0, 'h', 'o/r', '{}', '', 's', 'claimed', 1, 'owner', 0, 0)`, [orderId, `OTHER-${orderId}`, step]);
  }
});
afterEach(() => { closeLedger(dbPath); rmSync(dir, { recursive: true, force: true }); });

test("[1] remote write design with default: on = nonblocking, decided at 15 min and told via tell; off = blocks forever", async () => {
  const r = await remote({ class: "design", default: "保留两边" });
  expect(r).toMatchObject({ blocking: false, notified: true });
  expect(notices[0]).toMatchObject({ to: "agent-pm", level: "info" });
  expect(notices[0].text).toContain("15 分钟没回按默认定");
  expect(await sweepAskDefaults(db, now + ASK_DEFAULT_MS - 1, sweepDeps())).toBe(0);
  expect(getAsk(db, idOf(r))?.state).toBe("open");
  expect(await sweepAskDefaults(db, now + ASK_DEFAULT_MS, sweepDeps())).toBe(1);
  expect(getAsk(db, idOf(r))).toMatchObject({ state: "answered", answer: { text: "按执行者默认做法定" }, extra: { tell: "told" } });
  expect(told).toHaveLength(1);
  expect(told[0].to).toBe("worker@peer");
  expect(told[0].text).toContain("「保留两边」");
  expect(readFileSync(spec, "utf8")).toContain("## 自动定（");
  expect(notes("ask_default_all")).toHaveLength(1);
  // fix step counts as a write order too
  expect(await remote({ class: "scope", default: "改", question: "fix" }, "poolfix")).toMatchObject({ blocking: false });

  mode = "off";
  const off = await remote({ class: "design", default: "保留两边", question: "关掉" });
  expect(off).toMatchObject({ blocking: true });
  expect(getAsk(db, idOf(off))?.blocking).toBeNull();
  expect(getAsk(db, idOf(off))?.extra.defaultAll).toBeUndefined();
  await sweepAskDefaults(db, now + ASK_DEFAULT_MS * 3, sweepDeps());
  expect(getAsk(db, idOf(off))?.state).toBe("open");
});

test("[1] observe keeps the old behavior and records one would-be note per ask", async () => {
  mode = "observe";
  const r = await remote({ class: "design", default: "保留两边" });
  expect(r).toMatchObject({ blocking: true });
  await remote({ class: "design", default: "保留两边" }); // retry: same ask, no second note
  const ex = await local({ class: "scope", default: "改", files: ["src/lib/a.ts"] });
  expect(ex).toMatchObject({ ok: true, blocking: false, message: "已登记，按你的默认做法继续" });
  expect(notes("recovery_observe").map((e) => e.data.would).sort()).toEqual(["default", "exception"]);
  await sweepAskDefaults(db, now + ASK_DEFAULT_MS * 2, sweepDeps());
  expect(getAsk(db, idOf(r))?.state).toBe("open");
});

test("[2] blocker: no default = invalid_wire; with default blocks, decided at 15 min and the local executor is told", async () => {
  expect(await local({ class: "blocker" })).toMatchObject({ ok: false, code: "invalid_wire" });
  expect(await remote({ class: "blocker" })).toMatchObject({ code: "invalid_wire" });
  const r = await local({ class: "blocker", default: "先跳过这一步" });
  expect(r).toMatchObject({ ok: true, blocking: true });
  const a = getAsk(db, idOf(r))!;
  expect(a.blocking).toBeNull(); // 仍阻塞：和改前的 blocker 同一列值
  expect(a.extra).toMatchObject({ class: "blocker", default: "先跳过这一步", defaultAll: true });
  expect(notices[0]).toMatchObject({ level: "action" });
  expect(notices[0].text).toContain("15 分钟没回按默认做法定。执行者在等回复");
  notices = [];
  await sweepAskDefaults(db, now + ASK_DEFAULT_MS - 1, sweepDeps());
  expect(getAsk(db, a.id)?.state).toBe("open");
  await sweepAskDefaults(db, now + ASK_DEFAULT_MS, sweepDeps());
  expect(getAsk(db, a.id)).toMatchObject({ state: "answered", extra: { tell: "told" } });
  expect(notices).toEqual([expect.objectContaining({ to: who.agent, level: "info", id: `ask-default-told:${a.id}` })]);
  expect(notices[0].text).toContain("已按你的默认做法定");
  // off: a blocker without default is accepted exactly as before
  mode = "off";
  expect(await local({ class: "blocker", question: "旧" })).toMatchObject({ ok: true, blocking: true });
});

test("[2] remote blocker with default is decided and told to the remote worker", async () => {
  const r = await remote({ class: "blocker", default: "按旧接口" });
  expect(r).toMatchObject({ blocking: true });
  await sweepAskDefaults(db, now + ASK_DEFAULT_MS, sweepDeps());
  expect(getAsk(db, idOf(r))?.state).toBe("answered");
  expect(told.map((t) => t.to)).toEqual(["worker@peer"]);
});

test("[2] risk-tagged asks and security-template cards always wait for the PM", async () => {
  const asks = [
    await remote({ class: "design", default: "删表重建", risk: "delete_data" }),
    await remote({ class: "blocker", default: "放开权限", risk: "permission", question: "权限" }),
    await local({ class: "design", default: "改 schema", risk: "schema" }),
    await local({ class: "scope", default: "x", risk: "security", files: ["src/lib/a.ts"] }), // even a spec-exception hit
  ];
  for (const r of asks) expect(r).toMatchObject({ blocking: true });
  writeFileSync(spec, SPEC.replace("模板：code", "模板：security"));
  asks.push(await remote({ class: "design", default: "照做", question: "sec" }), await local({ class: "scope", default: "改", files: ["src/lib/a.ts"], question: "sec" }),
    await local({ class: "design", default: "本机", question: "sec2" }));
  for (const r of asks.slice(4)) expect(r).toMatchObject({ blocking: true });
  await sweepAskDefaults(db, now + ASK_DEFAULT_MS * 10, sweepDeps());
  expect(listAsks(db, { states: ["answered"] })).toHaveLength(0);
  expect(told).toHaveLength(0);
  expect(notes("ask_default_all")).toHaveLength(0);
  // risk is stored (structured), and every one of these PM notices is action
  expect(notices.every((n) => n.level === "action")).toBe(true);
  expect(listAsks(db, { states: ["open"] }).filter((a) => a.extra.risk)).toHaveLength(4);
});

test("[3] scope files all in the spec exceptions: answered at once, PM not notified; partial hit falls back to the 15-minute default", async () => {
  const r = await local({ class: "scope", default: "改一行", files: ["src/lib/a.ts", "src/lib/b.ts"] });
  expect(r).toMatchObject({ ok: true, blocking: false, notified: false, message: "规格精准例外已列：src/lib/a.ts、src/lib/b.ts，按规格写的限制改，交付说明逐条列" });
  expect(notices).toHaveLength(0);
  await sweepAskDefaults(db, now, sweepDeps());
  expect(getAsk(db, idOf(r))).toMatchObject({ state: "answered", answer: { text: expect.stringContaining("规格精准例外已列") } });
  expect(notices).toHaveLength(0); // local executor already has the answer; PM never notified
  expect(readFileSync(spec, "utf8")).toBe(SPEC); // auto answer appends nothing to the spec
  expect(notes("ask_default_all")[0].data).toMatchObject({ auto: "spec_exception", files: ["src/lib/a.ts", "src/lib/b.ts"] });

  const rr = await remote({ class: "scope", default: "改", files: ["src/lib/a.ts"] });
  expect(notices).toHaveLength(0);
  await sweepAskDefaults(db, now, sweepDeps());
  expect(getAsk(db, idOf(rr))?.state).toBe("answered");
  expect(told[0]).toMatchObject({ to: "worker@peer", text: expect.stringContaining("【自动答】") });

  const part = await remote({ class: "scope", default: "改", files: ["src/lib/a.ts", "src/lib/c.ts"] });
  expect(part).toMatchObject({ blocking: false, notified: true });
  expect(getAsk(db, idOf(part))?.extra.specException).toBeUndefined();
  await sweepAskDefaults(db, now + 1, sweepDeps());
  expect(getAsk(db, idOf(part))?.state).toBe("open");
  await sweepAskDefaults(db, now + ASK_DEFAULT_MS, sweepDeps());
  expect(getAsk(db, idOf(part))?.answer?.text).toBe("按执行者默认做法定");
});

test("[4] renotified nonblocking asks carry info, blocker and risk asks carry action", async () => {
  const deps0 = { ...deps(), notify: async () => ({ handed: false, note: "offline" }) };
  const src = { task: getTask(db, "T1")!, orderId: "pool", from: "worker@peer", keyPrefix: "lend" };
  await openOrderAsk(db, deps0, src, { question: "d", options: [], class: "design", default: "x" });
  await openOrderAsk(db, deps0, src, { question: "b", options: [], class: "blocker", default: "x" }).catch(() => null);
  notices = [];
  await sweepAskDefaults(db, now, sweepDeps());
  expect(notices.map((n) => n.level).sort()).toEqual(["action", "info"]);
});

test("PM reply within 15 minutes wins; ASK4 test-scope asks on remote writes keep their path under on", async () => {
  const r = await remote({ class: "blocker", default: "x" });
  expect(recordDefaultPmReply(() => db, { agent: "agent-pm", verified: true }, "worker@peer", `ask ${idOf(r)} 换做法`, now + 1)).toEqual([idOf(r)]);
  await sweepAskDefaults(db, now + ASK_DEFAULT_MS, sweepDeps());
  expect(getAsk(db, idOf(r))?.answer?.labels).toEqual(["PM 已回复"]);
  const t = await remote({ class: "scope", default: "补测试", files: ["tests/a.test.ts"], reason: "new_test" });
  expect(t).toMatchObject({ blocking: true });
  await sweepAskDefaults(db, now + ASK_DEFAULT_MS, sweepDeps());
  expect(getAsk(db, idOf(t))?.answer?.text).toBe("测试类扩围自动批准（文件全在 tests/）");
  expect(getTask(db, "T1")?.extra.fileGlobs).toEqual(["tests/a.test.ts"]);
});

test("lend v2 ask passes class / default / risk through leniently; old peers parse as classless asks", async () => {
  const base = { v: 1, orderId: "pool", gen: 1, question: "q", options: [] };
  expect(parseV2Request("ask", base)).toMatchObject({ ok: true });
  const old = parseV2Request("ask", base);
  if (!old.ok) throw new Error(old.error);
  expect(old.value).not.toHaveProperty("class");
  expect(old.value).not.toHaveProperty("default");
  const bad = parseV2Request("ask", { ...base, class: "weird", risk: "nope", default: "x".repeat(700) });
  if (!bad.ok) throw new Error(bad.error);
  expect(bad.value).not.toHaveProperty("class");
  expect(bad.value).not.toHaveProperty("risk");
  expect(bad.value.default?.length).toBe(600);
  expect(parseV2Request("ask", { ...base, default: 5, class: null })).toMatchObject({ ok: true });

  const scope = parseV2Request("ask", { ...base, class: "scope", default: "直接做" });
  if (!scope.ok) throw new Error(scope.error);
  const r = await openOrderAsk(db, deps(), { task: getTask(db, "T1")!, orderId: "pool", from: "worker@peer", keyPrefix: "lend" }, scope.value);
  expect(getAsk(db, idOf(r))?.extra.class).toBe("scope");
  await sweepAskDefaults(db, now + ASK_DEFAULT_MS, sweepDeps());
  expect(getAsk(db, idOf(r))?.answer?.text).toBe("按执行者默认做法定");

  const risky = parseV2Request("ask", { ...base, question: "r", class: "scope", default: "直接做", risk: "schema" });
  if (!risky.ok) throw new Error(risky.error);
  const rr = await openOrderAsk(db, deps(), { task: getTask(db, "T1")!, orderId: "pool", from: "worker@peer", keyPrefix: "lend" }, risky.value);
  await sweepAskDefaults(db, now + ASK_DEFAULT_MS * 5, sweepDeps());
  expect(getAsk(db, idOf(rr))?.state).toBe("open");

  const classless = await openOrderAsk(db, deps(), { task: getTask(db, "T1")!, orderId: "pool", from: "worker@peer", keyPrefix: "lend" }, old.value);
  expect(classless).toMatchObject({ blocking: true });
  await sweepAskDefaults(db, now + ASK_DEFAULT_MS * 5, sweepDeps());
  expect(getAsk(db, idOf(classless))?.state).toBe("open");
});

test("[2] ASK4 test-scope auto-approval also respects risk and the security template (one shared hold)", async () => {
  const q = { class: "scope", default: "补测试", files: ["tests/a.test.ts"], reason: "new_test" };
  const risk = await remote({ ...q, risk: "security" });
  const classless = await remote({ files: ["tests/b.test.ts"], reason: "new_test", risk: "permission", question: "旧版带 risk" });
  writeFileSync(spec, SPEC.replace("模板：code", "模板：security"));
  const sec = await remote({ ...q, question: "sec" });
  for (const r of [risk, classless, sec]) expect(r).toMatchObject({ blocking: true });
  await sweepAskDefaults(db, now + ASK_DEFAULT_MS * 2, sweepDeps());
  for (const r of [risk, classless, sec]) expect(getAsk(db, idOf(r))).toMatchObject({ state: "open", extra: { held: expect.any(String) } });
  expect(getTask(db, "T1")?.extra.fileGlobs).toBeUndefined();
  expect(told).toHaveLength(0);
  // off: verbatim pre-change behavior, ASK4 still approves
  mode = "off";
  const off = await remote({ ...q, question: "off" });
  await sweepAskDefaults(db, now + ASK_DEFAULT_MS * 3, sweepDeps());
  expect(getAsk(db, idOf(off))?.state).toBe("answered");
});

test("spec-exception lint hints reach the PM as one card note (non-blocking)", async () => {
  db.run("UPDATE tasks SET extra = json_set(extra, '$.fileGlobs', json('[\"src/lib/*.ts\"]')) WHERE id = 'T1'");
  writeFileSync(spec, `${SPEC}\n## 精准例外\n\n- 改一下 lib 目录下的东西\n`);
  const r = await remote({ class: "design", default: "保留两边" });
  await remote({ class: "design", default: "另一个", question: "再问" });
  expect(r).toMatchObject({ blocking: false });
  const n = notes("spec_exceptions_lint");
  expect(n).toHaveLength(1);
  expect(n[0].text).toContain("src/lib/a.ts 已在本卡 fileGlobs");
  expect(n[0].text).toContain("没解析出来");
  mode = "off";
  await remote({ class: "design", default: "x", question: "off" });
  expect(notes("spec_exceptions_lint")).toHaveLength(1);
});
