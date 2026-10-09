/**
 * 出借 worker 的「回合失败」卡（bridge/acp-link.ts，extra.failure = error：内容策略 / 请求被拒 / 上下文耗尽）也停单，
 * 和额度 / 登录卡走同一条 finish 路径。之前 lend-deps.ts failureOf 只认额度 / 登录，被内容策略拦下的单一直挂在 started、续租占位。
 * 卡走真台账文件 + 生产 failureOf（lendDeps(...).failure）+ 临时 CODEX_HOME 里的真 rollout；worker / 网络 / tmux 都是 lend-harness 的假依赖。
 * 只认本单当前回合的卡（lend-turn-failure.ts，按宿主报的失败时刻，不按写卡时刻）；回执只带类别不带原文；证据文件 0600（PR624 r1/r2）。
 */
import { afterEach, beforeAll, expect, spyOn, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { onAcpFrame } from "../src/bridge/acp-link.ts";
import { askDb, setAsksForTest } from "../src/bridge/asks.ts";
import { setExtensionSocket } from "../src/bridge/pi-abort.ts";
import { workerName } from "../src/lib/lend-drive.js";
import { lendDeps } from "../src/lib/lend-deps.js";
import { keepLendEvidence } from "../src/lib/lend-evidence.js";
import { getMeta, getOrder, type LendRow } from "../src/lib/lend-journal.js";
import { LedgerReader } from "../src/lib/ledger-read.js";
import { listAsks, openAsk, type Ask } from "../src/lib/ledger-asks.js";
import { closeLedger, openLedger } from "../src/lib/ledger-store.js";
import { acpLogDir } from "../src/lib/log-paths.js";
import { codexFailure } from "../src/lib/scheduler-auto-ports.js";
import { runLedger } from "../src/manager/ledger.js";
import { harness, toStarted } from "./lend-harness.js";

const W = workerName("o1");
const SID = "01a1b2c3-0000-7000-8000-00000000c0de";
const CYBER = "This content was flagged for possible cybersecurity risk. If this seems wrong, try rephrasing your request.";
const ledgers: string[] = [];
const journals: ReturnType<typeof harness>[] = [];
const codexHome = process.env.CODEX_HOME;
afterEach(() => {
  if (codexHome === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = codexHome;
  for (const p of ledgers.splice(0)) closeLedger(p);
  for (const h of journals.splice(0)) h.db.close();
});

interface Card { agent?: string; kind?: "owner_action" | "decide"; title?: string; context: string; extra: Record<string, unknown>; at?: number }

const CARD_AT = Date.parse("2026-10-05T03:00:00Z");
/** 当前回合的回合失败卡：带宿主报的会话 id 和失败时刻（写卡前 1 秒），失败在 rollout 最后一个 task_started 之后 */
const turnFail = (context: string, extra: Record<string, unknown> = {}): Card =>
  ({ context, extra: { failure: "error", sessionId: SID, failedAt: CARD_AT - 1_000, ...extra } });
const rolloutLine = (at: number, type: string) => JSON.stringify({ timestamp: new Date(at).toISOString(), type: "event_msg", payload: { type } });

/**
 * 走到 started（journal 会话改成 SID），临时 CODEX_HOME 写 SID 的 rollout（默认这一轮在卡前 5 秒开始），台账里按需开 Codex 运行时卡，
 * failure 换成生产接线；keepEvidence 换成记账的假实现
 */
async function running(...cards: Card[]) { return runningWith(rolloutLine(CARD_AT - 5_000, "task_started"), ...cards); }
async function runningWith(rollout: string | null, ...cards: Card[]) {
  const h = harness();
  journals.push(h);
  await toStarted(h);
  h.db.run("UPDATE lend_orders SET sessionId = ? WHERE orderId = 'o1'", [SID]);
  const home = mkdtempSync(join(tmpdir(), "lend-turnfail-codex-"));
  process.env.CODEX_HOME = home;
  if (rollout !== null) {
    mkdirSync(join(home, "sessions", "2026", "10", "05"), { recursive: true });
    writeFileSync(join(home, "sessions", "2026", "10", "05", `rollout-2026-10-05T10-00-00-${SID}.jsonl`), `${rolloutLine(CARD_AT - 60_000, "session_meta")}\n${rollout}\n`);
  }
  const path = join(mkdtempSync(join(tmpdir(), "lend-turnfail-")), "ledger.sqlite");
  ledgers.push(path);
  const ledger = openLedger(path);
  for (const c of cards) {
    openAsk(ledger, { project: "lend", fromAgent: c.agent ?? W, source: "codex", kind: c.kind ?? "owner_action", title: c.title ?? "Codex 回合失败",
      context: c.context, extra: c.extra }, c.at ?? CARD_AT);
  }
  h.d.failure = lendDeps(h.db, new LedgerReader(path), () => {}, undefined).failure;
  const kept: { orderId: string; why: string }[] = [];
  h.d.keepEvidence = (row, why) => (kept.push({ orderId: row.orderId, why }), `/evidence/${row.orderId}`);
  return { h, ledger, kept };
}
const releases = (h: ReturnType<typeof harness>) => h.calls.filter((c) => c.op === "lease" && c.body.action === "release");

test("内容策略拦下的回合失败：当轮停单，回执只带类别，停前存证据（原文只进证据），kill 并关卡；不暂停借单、不重派", async () => {
  const { h, kept } = await running(turnFail(CYBER));
  await h.tick();
  expect(getOrder(h.db, "o1")!.state).toBe("stopped");
  expect(releases(h).map((c) => c.body.reason)).toEqual(["stopped"]);
  const detail = String(releases(h)[0]!.body.detail);
  for (const s of ["worker 回合失败", "内容策略拦截", "不自动重试", "现场已在出借方本机留存", "报错原文只留在出借方本机"]) expect(detail).toContain(s);
  expect(detail).not.toContain("flagged for possible cybersecurity risk");
  expect(Buffer.byteLength(detail)).toBeLessThanOrEqual(500);
  expect(kept).toEqual([{ orderId: "o1", why: expect.stringContaining(`报错原文（只留本机）：${CYBER}`) }]);
  expect(h.log.killed).toEqual([W]);
  expect(h.log.closedAsks).toEqual([W]);
  expect(h.log.notices.at(-1)?.kind).toBe("stopped");
  expect(getMeta(h.db, "pause:codex")).toBeNull();
  for (let i = 0; i < 3; i++) { h.advanceTime(60_000); await h.tick(); }
  expect(h.log.created).toEqual([W]); // B 不自动重试、不换家族：同一单不再起 worker、不再派单
  expect(h.log.sent).toHaveLength(1);
  expect(releases(h)).toHaveLength(1);
});

test("别的回合失败（请求被拒 / 上下文耗尽之类）：同样停单，类别写成非内容策略", async () => {
  const { h, kept } = await running(turnFail("context window exceeded: start a new thread"));
  await h.tick();
  const detail = String(releases(h)[0]!.body.detail);
  expect(detail).not.toContain("context window exceeded");
  expect(detail).toContain("请求被拒 / 上下文耗尽");
  expect(detail).not.toContain("内容策略拦截");
  expect(kept).toHaveLength(1);
});

test("证据没存成（返回 null）也照样停单，回执不说留存了现场", async () => {
  const { h } = await running(turnFail(CYBER));
  h.d.keepEvidence = () => null;
  await h.tick();
  expect(getOrder(h.db, "o1")!.state).toBe("stopped");
  expect(String(releases(h)[0]!.body.detail)).not.toContain("留存");
});

test("没有卡（retry 类失败 bridge 不开卡）、或只有别的 Codex 弹框卡：单照常跑，不停、不存证据", async () => {
  for (const cards of [[], [{ kind: "decide" as const, title: "Codex 要确认", context: "Allow command?", extra: {} }]]) {
    const { h, kept } = await running(...cards);
    for (let i = 0; i < 3; i++) { h.advanceTime(30_000); await h.tick(); }
    expect(getOrder(h.db, "o1")!.state).toBe("started");
    expect(h.log.killed).toEqual([]);
    expect(kept).toEqual([]);
  }
});

test("非出借 agent 不受影响：别人的回合失败卡不停这张单；调度器那边没归属的回合失败卡照旧不算", async () => {
  const { h, ledger, kept } = await running({ ...turnFail(CYBER), agent: "agent-task-x" });
  for (let i = 0; i < 2; i++) { h.advanceTime(30_000); await h.tick(); }
  expect(getOrder(h.db, "o1")!.state).toBe("started");
  expect(kept).toEqual([]);
  expect(codexFailure(ledger, "agent-task-x")).toBeUndefined(); // scheduler-auto-ports 的归属规则没动：派单前的旧失败不交 PM
});

test("额度 / 登录卡的原有行为不变：照旧停单、额度暂停借单，不走证据保全", async () => {
  const quota = await running({ kind: "decide", title: "Codex 额度用完了", context: "约 3 小时后恢复", extra: { quota: true, raw: "You've hit your usage limit." } });
  await quota.h.tick();
  expect(getOrder(quota.h.db, "o1")!.reason).toContain("撞了 Codex 额度，没交结论：You've hit your usage limit.");
  expect(getMeta(quota.h.db, "pause:codex")).not.toBeNull();
  expect(quota.kept).toEqual([]);
  const auth = await running({ title: "Codex 需要 owner 登录", context: "在终端里跑一次 codex login", extra: {} });
  await auth.h.tick();
  expect(getOrder(auth.h.db, "o1")!.reason).toContain("没登录或登录失效");
  expect(getMeta(auth.h.db, "pause:codex")).toBeNull();
  expect(auth.kept).toEqual([]);
});

/** 出借收尾的真实关卡出口：调度服务身份跑 `ledger lend-close-asks`，关的就是这张临时台账（生产 closeAsks 经 manager 走同一条命令） */
function realCloseAsks(h: ReturnType<typeof harness>, ledger: ReturnType<typeof openLedger>): void {
  h.d.closeAsks = async (agent) => {
    const r = (await runLedger(["lend-close-asks", "--agent", agent], {
      db: ledger, actor: "scheduler", projectIds: [], now: () => Date.now(), loadRegistry: async () => ({ socket: "", agents: {} }) as never, saveRegistry: async () => {},
    })) as Record<string, unknown>;
    return r.ok === true ? { ok: true } : { ok: false, error: String(r.error ?? "lend-close-asks 失败") };
  };
}
const QUOTA_CARD: Card = { kind: "decide", title: "Codex 额度用完了", context: "约 3 小时后恢复", extra: { quota: true, raw: "You've hit your usage limit." } };
const cardStates = (ledger: ReturnType<typeof openLedger>, pick: (a: Ask) => boolean) => listAsks(ledger, { fromAgent: W, source: "codex" }).filter(pick).map((a) => a.state);

test("投递结果不明的回合失败卡：照常停单，但出借收尾的真实关卡（lend-close-asks）不关它；同一个 worker 的额度卡照常 cancelled", async () => {
  const unknown = turnFail("这条消息可能已经被执行，没有自动重发，需要人决定要不要重发（acp 连接断了）。消息原文：\n部署", { deliveryUnknown: true });
  const { h, ledger } = await running({ ...QUOTA_CARD, at: CARD_AT - 10_000 }, unknown);
  realCloseAsks(h, ledger);
  await h.tick();
  expect(getOrder(h.db, "o1")!.state).toBe("stopped");
  expect(cardStates(ledger, (a) => a.extra.deliveryUnknown === true)).toEqual(["open"]);
  expect(cardStates(ledger, (a) => a.extra.quota === true)).toEqual(["cancelled"]);
});

test("对照：只有额度卡时照常停单，真实关卡把它 cancelled", async () => {
  const { h, ledger } = await running(QUOTA_CARD);
  realCloseAsks(h, ledger);
  await h.tick();
  expect(getOrder(h.db, "o1")!.state).toBe("stopped");
  expect(cardStates(ledger, () => true)).toEqual(["cancelled"]);
});

test("报错原文里的本机路径 / 凭据不出本机：release detail、journal reason、日志都只有类别，原文只进本机证据", async () => {
  const raw = "request rejected\nfile=/Users/someone/private/report.txt\nAuthorization: Bearer sk-test-not-a-real-token";
  const { h, kept } = await running(turnFail(raw));
  await h.tick();
  expect(getOrder(h.db, "o1")!.state).toBe("stopped");
  const out = [String(releases(h)[0]!.body.detail), getOrder(h.db, "o1")!.reason ?? "", h.log.lines.join("\n"), JSON.stringify(h.log.notices)];
  for (const leak of ["/Users/someone", "Bearer", "sk-test-not-a-real-token", "request rejected"]) for (const s of out) expect(s).not.toContain(leak);
  expect(kept[0]!.why).toContain(raw);
});

test("不是本单当前回合的回合失败卡不停单：开跑前失败的、没带 / 带错会话或失败时刻、失败后又开过回合（含写卡晚到）、找不到 rollout 或 task_started", async () => {
  const late = [rolloutLine(CARD_AT - 10_000, "task_started"), rolloutLine(CARD_AT - 8_000, "task_complete"), rolloutLine(CARD_AT - 2_000, "task_started")].join("\n");
  const cases: [string, () => ReturnType<typeof running>][] = [
    ["开跑前", () => runningWith(rolloutLine(0, "task_started"), { ...turnFail(CYBER, { failedAt: 400 }), at: 500 })],
    ["老宿主没带会话", () => running(turnFail(CYBER, { sessionId: undefined }))],
    ["老宿主没带失败时刻", () => running(turnFail(CYBER, { failedAt: undefined }))],
    ["旧失败晚到：写卡前新回合已开始", () => runningWith(late, turnFail(CYBER, { failedAt: CARD_AT - 9_000 }))],
    ["会话不对", () => running(turnFail(CYBER, { sessionId: "01a1b2c3-0000-7000-8000-0000000000ff" }))],
    ["卡后又开了一轮", () => runningWith(`${rolloutLine(CARD_AT - 5_000, "task_started")}\n${rolloutLine(CARD_AT + 2_000, "task_started")}`, turnFail(CYBER))],
    ["没有 rollout", () => runningWith(null, turnFail(CYBER))],
    ["rollout 里没有 task_started", () => runningWith(rolloutLine(CARD_AT - 5_000, "token_count"), turnFail(CYBER))],
  ];
  const err = spyOn(console, "error");
  try {
    for (const [name, start] of cases) {
      err.mockClear();
      const { h, kept } = await start();
      for (let i = 0; i < 3; i++) { h.advanceTime(30_000); await h.tick(); }
      expect([name, getOrder(h.db, "o1")!.state, h.log.killed, kept, releases(h)]).toEqual([name, "started", [], [], []]);
      const said = err.mock.calls.map((c) => String(c[0])).filter((m) => m.includes("不自动停单"));
      expect([name, said.length]).toEqual([name, 1]); // 证明不了：不停单，但留一条可见的诊断，同一张卡只记一次
    }
  } finally { err.mockRestore(); }
});

// ── bridge 一侧的约定：只有不能重试的回合失败才开 extra.failure = error 卡（acp-link.ts onFailure），出借停单只认这张 ──

const sockets = new Map<string, { send(d: string): void }>();
beforeAll(() => {
  setExtensionSocket((ch) => sockets.get(ch), {
    deliver: async () => undefined, ownerId: () => "", books: () => ({}) as never,
    hold: () => { throw new Error("turn-failure fixture must not queue an echo"); },
  });
});

test("bridge：retry=true 的回合失败不开卡；不能重试的开 extra.failure=error 卡并记下宿主报的会话和失败时刻；没有在跑的出借单，生产 failureOf 不认", async () => {
  const askDir = mkdtempSync(join(tmpdir(), "lend-turn-asks-"));
  const askPath = join(askDir, "asks.sqlite");
  setAsksForTest({ path: askPath });
  try {
  const ch = "local-lend-turnfail";
  const s = { send: () => {} };
  sockets.set(ch, s);
  const cards = () => listAsks(askDb(), { states: ["open"] }).filter((a) => a.fromChannelId === ch);
  await onAcpFrame({ type: "acp_failure", channelId: ch, failure: { kind: "error", key: "air:r1", message: "Rate limit reached", retry: true } }, s, {} as never);
  await onAcpFrame({ type: "acp_failure", channelId: ch, sessionId: SID, failedAt: 1234, failure: { kind: "error", key: "air:c1", message: CYBER, retry: false } }, s, {} as never);
  for (let i = 0; i < 100 && !cards().length; i++) await Bun.sleep(10);
  const open = cards();
  expect(open.map((a) => [a.context, a.extra.failure, a.extra.sessionId, a.extra.failedAt])).toEqual([[CYBER, "error", SID, 1234]]);
  const journal = harness();
  journals.push(journal);
  const seen = lendDeps(journal.db, new LedgerReader(askDb().filename), () => {}, undefined).failure(open[0]!.fromAgent!);
  expect(seen).toBeUndefined();
  } finally {
    closeLedger(askPath);
    setAsksForTest(undefined);
    rmSync(askDir, { recursive: true, force: true });
  }
});

// ── 证据保全（lend-evidence.ts）：真文件系统，临时目录 ──

function workCopy(startedAt: number) {
  const base = mkdtempSync(join(tmpdir(), "lend-evidence-"));
  const work = join(base, "work");
  for (const d of [".git", "node_modules", "src", ".review"]) mkdirSync(join(work, d), { recursive: true });
  const old = join(work, "src", "repo.ts");
  writeFileSync(old, "仓库原有文件");
  utimesSync(old, new Date(startedAt - 60_000), new Date(startedAt - 60_000));
  writeFileSync(join(work, ".review", "notes.md"), "P1：竞态");
  writeFileSync(join(work, "report.md"), "审查报告草稿");
  writeFileSync(join(work, ".git", "config"), "[core]");
  writeFileSync(join(work, "node_modules", "x.js"), "x");
  writeFileSync(join(work, "big.bin"), Buffer.alloc(1024 * 1024 + 1));
  symlinkSync(join(work, "report.md"), join(work, "link.md"));
  return { base, work };
}

test("证据：只复制 worker 开跑之后写的普通文件（跳过 .git / node_modules / 软链 / 超大文件），index 指向不随结单删除的 ACP 日志", () => {
  const startedAt = Date.now() - 10_000;
  const { base, work } = workCopy(startedAt);
  const row = { orderId: "lend:T1:s1:r2:a0", agent: "agent-lend-0123456789", sessionId: "thr-9", dir: work, startedAt, createdAt: startedAt - 5_000 } as LendRow;
  const lines: string[] = [];
  const dest = keepLendEvidence(row, "worker 回合失败，没交结论：x", join(base, "evidence"), (m) => void lines.push(m));
  expect(dest).toStartWith(join(base, "evidence", "lend_T1_s1_r2_a0-"));
  expect(readFileSync(join(dest!, "work", ".review", "notes.md"), "utf8")).toBe("P1：竞态");
  expect(readFileSync(join(dest!, "work", "report.md"), "utf8")).toBe("审查报告草稿");
  for (const skipped of ["src/repo.ts", ".git/config", "node_modules/x.js", "big.bin", "link.md"]) expect(existsSync(join(dest!, "work", skipped))).toBe(false);
  const index = readFileSync(join(dest!, "index.txt"), "utf8");
  for (const s of ["lend:T1:s1:r2:a0", "agent-lend-0123456789", "thr-9", "worker 回合失败", acpLogDir("agent-lend-0123456789"), "report.md"]) expect(index).toContain(s);
  expect(lines).toEqual([]);
  expect(keepLendEvidence(row, "再存一次", join(base, "evidence"), (m) => void lines.push(m))).toBe(dest); // 停单没确认、下一轮重做：同一处覆盖
});

test("证据：工作副本已不在只写 index；落点写不了返回 null 并记日志，绝不抛", () => {
  const base = mkdtempSync(join(tmpdir(), "lend-evidence-"));
  const row = { orderId: "o9", agent: "agent-lend-ffffffffff", sessionId: null, dir: join(base, "gone"), startedAt: 1, createdAt: 1 } as LendRow;
  const dest = keepLendEvidence(row, "x", join(base, "evidence"), () => {});
  expect(readFileSync(join(dest!, "index.txt"), "utf8")).toContain("0 个");
  writeFileSync(join(base, "file-not-dir"), "");
  const lines: string[] = [];
  expect(keepLendEvidence(row, "x", join(base, "file-not-dir"), (m) => void lines.push(m))).toBeNull();
  expect(lines[0]).toContain("存 o9 的证据失败");
});

test("证据文件一律 0600、目录 0700：源文件 0644 也收紧，重做覆盖时同样", () => {
  const startedAt = Date.now() - 10_000;
  const { base, work } = workCopy(startedAt);
  chmodSync(join(work, "report.md"), 0o644);
  const row = { orderId: "o7", agent: "agent-lend-0123456789", sessionId: SID, dir: work, startedAt, createdAt: startedAt } as LendRow;
  for (let i = 0; i < 2; i++) {
    const dest = keepLendEvidence(row, "x", join(base, "evidence"), () => {})!;
    for (const f of ["work/report.md", "work/.review/notes.md", "index.txt"]) expect([f, statSync(join(dest, f)).mode & 0o777]).toEqual([f, 0o600]);
    expect(statSync(dest).mode & 0o777).toBe(0o700);
    chmodSync(join(dest, "work", "report.md"), 0o644); // 重做前被放宽：再存一次要收回 0600
    chmodSync(join(dest, "index.txt"), 0o644);
  }
});
