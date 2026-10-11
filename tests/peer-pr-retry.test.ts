/**
 * PRRETRY：临时台账 + 真 ledger CLI + 真推送一轮（pushPending）+ 真报告文件 + 真 bridge 复核（handlePeerPrPush），只有对 peer 的 POST 是抓下来的。
 * 旧行为（拒收是终态、永不再发）不变；PM 显式申请后按原通道发一次；未授权、错 review / peer / head、已 sent、结果不明、门仍拒、
 * 重复 / 并发 / CAS / 重启都不多发一个字节。报告是不是原样只认原推送留在台账里的摘要（不看文件时间）；head 漂移在申请、渲染、
 * 认领事务、发帧前四处都拒。
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { handlePeerPrPush, type PeerPrSendDeps } from "../src/bridge/peer-pr-send.ts";
import { getTask, LedgerError, listEvents } from "../src/lib/ledger-store.ts";
import type { LedgerEvent } from "../src/lib/ledger-stages.ts";
import { insertEvent } from "../src/lib/ledger-tx.ts";
import { moveStage } from "../src/lib/ledger-write.ts";
import { statePath } from "../src/lib/paths.ts";
import { PEER_PR_CONFIG_PATH, readPeerPrConfig } from "../src/lib/peer-pr-config.ts";
import type { PeerPrGithub } from "../src/lib/peer-pr-github.ts";
import { recordPeerPrNote } from "../src/lib/peer-pr-ledger.ts";
import { GATE_REJECTED, PUSH_MAX_BYTES, renderReviewPush } from "../src/lib/peer-pr-message.ts";
import { stateFor, type BridgeSendResult, type PeerPrCtx } from "../src/lib/peer-pr-notice.ts";
import { pushPending } from "../src/lib/peer-pr-push.ts";
import { redactPeerPr } from "../src/lib/peer-pr-redact.ts";
import { renderRedeliveryPush, requestRedelivery } from "../src/lib/peer-pr-retry.ts";
import { readReviewReport } from "../src/lib/peer-pr-tick.ts";
import { schedulerAutoTick } from "../src/lib/scheduler-auto-tick.ts";
import { SCHEDULER_CONFIG_PATH } from "../src/lib/scheduler-config.ts";
import { intakeGithub } from "../src/manager/ledger-peer-pr-cmds.ts";
import { autoFixture, P1 } from "./scheduler-auto-helpers.ts";

const HEAD = "c3".repeat(20), HEAD2 = "d4".repeat(20), FP = "0a1b-2c3d-4e5f-6a7b", OUT_TOKEN = "synthetic-out-credential";
const PEERS = { enabled: true, project: "p", fromNumber: 400, replyTo: "agent-pm@me",
  peers: [{ peer: "he", fp: FP, agent: "agent-x", githubLogins: ["he-dev"], authorFamily: "claude" }] };
const REPORT = `P1 finding race-1: two ticks claim one intent\nevidence at ${HEAD.slice(0, 12)}, log /private/tmp/claude-501/trace.log\n{"password": "synthetic-private-value"}`;
const REPORT_PATH = "reviews/PR401-r1/report.md", REPORT_FILE = statePath("ledger", REPORT_PATH);
const IDENTITY = { username: "nobodyhere", hostname: "nohost" };
const sha = (s: string) => createHash("sha256").update(s).digest("hex");
const realMake = intakeGithub.make;
const github = { repo: async () => "o/r", listOpen: async () => [], files: async () => [{ path: "src/lib/plain-thing.ts" }], body: async () => "b",
  fetchHead: async () => null, view: async (_r: string, n: number) => ({ state: "OPEN", url: `https://github.com/o/r/pull/${n}`, login: "he-dev", title: "t",
    head: HEAD, base: "main", branch: "fix/x", crossRepo: false, headOwner: "o", draft: false }) } as PeerPrGithub;

const writeConfig = (peers = PEERS) => writeFileSync(PEER_PR_CONFIG_PATH, JSON.stringify(peers));
function writeReport(text: string) {
  mkdirSync(dirname(REPORT_FILE), { recursive: true });
  writeFileSync(REPORT_FILE, text);
}

beforeAll(() => {
  intakeGithub.make = () => github;
  writeFileSync(SCHEDULER_CONFIG_PATH, JSON.stringify({ enabled: true, autoDispatch: true,
    projects: { p: { maxActiveWorkers: 2, requiredChecks: ["check"], repoDir: statePath() } } }));
});
afterAll(() => {
  intakeGithub.make = realMake;
  for (const p of [SCHEDULER_CONFIG_PATH, PEER_PR_CONFIG_PATH]) rmSync(p, { force: true });
  rmSync(statePath("ledger", "reviews"), { recursive: true, force: true });
});

type Answer = (frame: Record<string, unknown>) => Promise<BridgeSendResult>;
const OLD_GATE: Answer = async () => ({ ok: false, sent: false, error: "门拦下（敏感字段名）", rejected: GATE_REJECTED });
const UNKNOWN: Answer = async () => ({ ok: false, sent: true, error: "答复丢了" });

/** A peer card in review with one recorded verdict on HEAD and its report on disk; nothing pushed yet. */
async function world(report = REPORT) {
  writeConfig();
  writeReport(report);
  const f = autoFixture();
  const posts: string[] = [], frames: Record<string, unknown>[] = [], notices: string[] = [];
  let status = 202;
  /** Test seams on the pass's own awaits: inside the commits lookup of a render, and right after the claim record returned. */
  const hooks: { commits?: () => Promise<unknown>; claimed?: () => Promise<unknown> } = {};
  const manager: PeerPrCtx["deps"]["manager"] = async (...args) => {
    const r = await f.tickDeps.manager(...args);
    if (args.includes("claimed")) await hooks.claimed?.();
    return r;
  };
  const send: PeerPrSendDeps = {
    readConfig: () => readPeerPrConfig(),
    peers: async () => [{ name: "he", fp: FP, baseUrl: "http://127.0.0.1:9", outToken: OUT_TOKEN, addedAt: "" }],
    commits: async (_dir, shas) => new Set(shas.filter((s) => s === HEAD || s === HEAD2)),
    post: async (_url, _headers, body) => { posts.push(JSON.parse(body).text); return status; },
  };
  /** The real bridge handler: its own config read, target triple, peers.json row, gate and size cap. */
  const realBridge: Answer = async (frame) => {
    const a = await handlePeerPrPush(frame, false, send);
    return "result" in a ? { ok: true, result: a.result } : { ok: false, sent: !a.rejected, error: a.error, ...(a.rejected ? { rejected: a.rejected } : {}) };
  };
  let answer: Answer = realBridge;
  const ctx = (): PeerPrCtx => {
    const read = readPeerPrConfig();
    if (read.kind !== "on") throw new Error("peer-prs.json 没开");
    return { db: f.db, cfg: read.config, state: stateFor(f.db), deps: { github, manager, now: f.tickDeps.now, identity: IDENTITY,
      commits: async (shas) => (await hooks.commits?.(), new Set(shas.filter((s) => s === HEAD || s === HEAD2))), readReport: (p) => readReviewReport(p),
      bridge: async (frame) => (frames.push(frame), answer(frame)), notifyPm: async (_p, text) => { notices.push(text); } } };
  };
  expect(await f.cli("scheduler", "peer-pr-intake", "--project", "p", "--number", "401", "--head", HEAD)).toMatchObject({ ok: true });
  for (let i = 0; i < 2; i++) await schedulerAutoTick(f.db, { p: { maxActiveWorkers: 2 } }, f.tickDeps);
  const findings = `${f.dir}/findings.json`;
  writeFileSync(findings, JSON.stringify([P1]));
  f.reviewerCheckoutAt(HEAD);
  expect(await f.cli("agent-rv-t1", "review", "PR401", "--reviewer", "agent-rv-t1", "--verdict", "changes", "--p0", "0", "--p1", "1", "--p2", "0",
    "--head", HEAD, "--session", "s-rv", "--family", "codex", "--findings", findings, "--path", REPORT_PATH)).toMatchObject({ ok: true });
  const events = () => listEvents(f.db, { project: "p", target: "PR401" });
  const review = events().findLast((e) => e.kind === "review")!;
  const rows = (key: string) => events().filter((e) => e.data.op === "peer_pr_push" && e.data.key === key).map((e) => String(e.data.result));
  const row = (key: string, result: string) => events().find((e) => e.data.op === "peer_pr_push" && e.data.key === key && e.data.result === result)!;
  const pass = async () => (await pushPending(ctx())).map((r) => `${r.key} ${r.outcome}`);
  const retry = (actor: string, reviewSeq: number, refusedSeq: number) =>
    f.cli(actor, "peer-pr-retry", "PR401", "--review", String(reviewSeq), "--refused", String(refusedSeq));
  /** The first push meets `first`, the next pass (30 s later) meets `then`; afterwards the bridge is the real one. */
  const refuseOriginal = async (first: Answer = OLD_GATE, then?: Answer) => {
    answer = first;
    await pass();
    if (then) { f.advance(31_000); answer = then; await pass(); }
    answer = realBridge;
    return row(`review:${review.seq}`, "refused");
  };
  /** The PR gets a new head: the card leaves the reviewed head for the next round. */
  const drift = async () => {
    if (getTask(f.db, "PR401")!.stage === "review") moveStage(f.db, f.at("pm"), { taskId: "PR401", from: "review", to: "fix", text: "P1" });
    expect(await f.cli("scheduler", "peer-pr-observe", "PR401", "--head", HEAD2)).toMatchObject({ ok: true, moved: true });
  };
  return { f, posts, frames, notices, events, review, rows, row, pass, retry, refuseOriginal, hooks, drift, key: `review:${review.seq}`,
    answerWith: (a: Answer | null) => { answer = a ?? realBridge; }, statusIs: (n: number) => { status = n; } };
}
type World = Awaited<ReturnType<typeof world>>;
const queued = (w: World) => w.events().filter((e) => e.data.result === "queued");

describe("默认路径不变", () => {
  test("自动回推：帧 key、正文与原渲染逐字节一致，认证回执后才记 sent", async () => {
    const w = await world();
    expect(await w.pass()).toEqual([`PR401:${w.key} sent`]);
    const red = redactPeerPr(REPORT, IDENTITY, new Set([HEAD]));
    const expected = renderReviewPush({ number: 401, taskId: "PR401", head: HEAD, counts: { verdict: "changes", p0: 0, p1: 1, p2: 0, round: 1 }, maxRounds: 3,
      replyTo: "agent-pm@me", report: red.text, masked: red.count });
    expect(w.posts).toEqual([expected]);
    expect(w.frames[0]).toMatchObject({ type: "peer_pr_push", peer: "he", fp: FP, agent: "agent-x", key: `PR401:${w.key}`, text: expected });
    expect(w.rows(w.key)).toEqual(["claimed", "sent"]);
    expect(await w.pass()).toEqual([]);
    w.f.close();
  });

  test("旧行为：拒收是终态，记录与 PM 通知的文字照旧，之后不论跑多少轮都不再发", async () => {
    const w = await world();
    const refused = await w.refuseOriginal();
    expect(refused.text).toBe("没发给对方：bridge 复核拦下：门拦下（敏感字段名）");
    // the record's only addition: the report's own digest (the evidence a later redelivery is checked against)
    expect(refused.data).toEqual({ op: "peer_pr_push", key: w.key, result: "refused", rule: "bridge 复核拦下：门拦下（敏感字段名）",
      report: { sha256: sha(REPORT), bytes: Buffer.byteLength(REPORT) } });
    expect(w.notices).toEqual([`[peer PR] PR401 的推送 ${w.key} 没发给对方：bridge 复核拦下：门拦下（敏感字段名）；本机报告 ${REPORT_PATH}`]);
    for (let i = 0; i < 3; i++) { w.f.advance(3_600_000); expect(await w.pass()).toEqual([]); }
    expect(w.frames).toHaveLength(1);
    expect(w.posts).toHaveLength(0);
    expect(w.rows(w.key)).toEqual(["claimed", "refused"]);
    w.f.close();
  });

  test("失败照旧退避重试（非补发的 key 可以多次认领）", async () => {
    const w = await world();
    w.answerWith(UNKNOWN);
    expect(await w.pass()).toEqual([`PR401:${w.key} failed`]);
    expect(await w.pass()).toEqual([`PR401:${w.key} backoff`]);
    w.f.advance(31_000);
    w.answerWith(null);
    expect(await w.pass()).toEqual([`PR401:${w.key} sent`]);
    expect(w.rows(w.key)).toEqual(["claimed", "failed", "claimed", "sent"]);
    w.f.close();
  });
});

describe("PM 显式补发", () => {
  test("申请一次 → 原通道发一次：同一报告编号、标明是投递补发，原审查 / 原拒收 / 报告字节都不动", async () => {
    const w = await world();
    const refused = await w.refuseOriginal();
    const before = JSON.stringify([w.review, refused]), digest = sha(readFileSync(REPORT_FILE, "utf8"));
    const r = await w.retry("pm", w.review.seq, refused.seq);
    const key = `redeliver:${w.review.seq}:${refused.seq}`;
    expect(r).toMatchObject({ ok: true, key, duplicate: false });
    expect(JSON.stringify(r)).not.toContain("report.md");
    const request = queued(w)[0]!;
    expect(request).toMatchObject({ actor: "pm", kind: "note", data: { key, redeliver: { review: w.review.seq, refused: refused.seq,
      report: { sha256: digest, bytes: Buffer.byteLength(REPORT) },
      origin: { kind: "report", sha256: digest, bytes: Buffer.byteLength(REPORT), seq: refused.seq }, task: { id: "PR401", head: HEAD, specRev: getTask(w.f.db, "PR401")!.specRev, round: 1 },
      peer: { peer: "he", fp: FP, agent: "agent-x" } } } });
    expect(request.text).toContain("投递补发，不是新结论");

    expect(await w.pass()).toEqual([`PR401:${key} sent`]);
    expect(w.posts).toHaveLength(1);
    const lines = w.posts[0]!.split("\n");
    expect(lines[0]).toBe("[Claudestra 调度器 · PR #401 第 1 轮审查] 不通过（1 个 P1）");
    expect(lines[1]).toContain("投递补发：这是第 1 轮原审查报告的补发");
    expect(lines[1]).toContain("不是新的审查结论");
    expect(lines.slice(2, 6)).toEqual([`head：${HEAD.slice(0, 12)}`, "报告编号：PR401-r1（若收到重发，同编号按一份处理）",
      "现状：这条不要求你动作；下一步以调度器之后的消息为准。", "有异议或问题回：agent-pm@me"]);
    expect(w.posts[0]).toContain("P1 finding race-1: two ticks claim one intent");
    for (const leak of ["synthetic-private-value", "/private/tmp", statePath(), OUT_TOKEN, REPORT_PATH, "下一步：修在本 PR"]) expect(w.posts[0]).not.toContain(leak);
    expect(w.frames.at(-1)).toMatchObject({ peer: "he", fp: FP, agent: "agent-x", key: `PR401:${key}` });
    expect(w.rows(key)).toEqual(["queued", "claimed", "sent"]);

    expect(JSON.stringify([w.events().find((e) => e.seq === w.review.seq), w.row(w.key, "refused")])).toBe(before);
    expect(sha(readFileSync(REPORT_FILE, "utf8"))).toBe(digest);
    expect(w.events().filter((e) => e.kind === "review")).toHaveLength(1);
    expect(getTask(w.f.db, "PR401")).toMatchObject({ stage: "review", round: 1, headSHA: HEAD });
    for (let i = 0; i < 2; i++) { w.f.advance(3_600_000); expect(await w.pass()).toEqual([]); }
    expect(await w.retry("pm", w.review.seq, refused.seq)).toMatchObject({ ok: true, duplicate: true });
    expect(await w.pass()).toEqual([]);
    expect(w.posts).toHaveLength(1);
    w.f.close();
  });

  test("合并后的卡：正文写明已合并、不要求动作；审查推送格式对不上就不发", () => {
    const push = renderReviewPush({ number: 665, taskId: "PR665", head: HEAD, counts: { verdict: "pass", p0: 0, p1: 0, p2: 1, round: 2 }, maxRounds: 3,
      replyTo: "agent-pm@me", report: "正文", masked: 0 });
    const text = renderRedeliveryPush(push, 2, { stage: "verified" })!;
    expect(text).toContain("现状：该 PR 已合并，这条不需要你做任何动作。");
    expect(text).toContain("报告编号：PR665-r2（若收到重发，同编号按一份处理）");
    expect(text).not.toContain("已进合并队列");
    expect(text.split("\n").slice(-3)).toEqual(push.split("\n").slice(-3));
    expect(renderRedeliveryPush("标题\nhead\n别的行\n下一步：x", 1, { stage: "review" })).toBeNull();
  });

  test("确定没发出去的失败（bridge 带类型拒发）之后的拒收可以申请", async () => {
    const w = await world();
    const refused = await w.refuseOriginal(async () => ({ ok: false, sent: false, error: "peer-prs.json 没开", rejected: "peer_pr_config" }), OLD_GATE);
    expect(w.rows(w.key)).toEqual(["claimed", "failed", "claimed", "refused"]);
    expect(await w.retry("pm", w.review.seq, refused.seq)).toMatchObject({ ok: true, duplicate: false });
    expect(await w.pass()).toEqual([`PR401:redeliver:${w.review.seq}:${refused.seq} sent`]);
    expect(w.posts).toHaveLength(1);
    w.f.close();
  });
});

describe("拒：身份", () => {
  test("调度身份、执行者、普通 agent 都不能申请；通用记录命令也写不出申请行；伪造的申请行发不出去", async () => {
    const w = await world();
    const refused = await w.refuseOriginal();
    const key = `redeliver:${w.review.seq}:${refused.seq}`;
    for (const actor of ["scheduler", "agent-task-one", "agent-rv-t1", "unknown"]) {
      expect(await w.retry(actor, w.review.seq, refused.seq)).toMatchObject({ ok: false, code: "forbidden" });
    }
    const input = { taskId: "PR401", review: w.review.seq, refused: refused.seq };
    const cfg = (readPeerPrConfig() as { config: PeerPrCtx["cfg"] }).config;
    const read = () => ({ text: REPORT });
    for (const actor of ["scheduler", "peer:he", "agent-rv-t1"]) {
      expect(() => requestRedelivery(w.f.db, w.f.at(actor), input, cfg, read)).toThrow(LedgerError);
    }
    const record = (...extra: string[]) => w.f.cli("scheduler", "peer-pr-push-record", "PR401", "--text", "x", ...extra);
    expect(await record("--key", key, "--result", "queued")).toMatchObject({ ok: false, code: "forbidden" });
    expect(await record("--key", "drift:1", "--result", "queued", "--data", JSON.stringify({ redeliver: {} }))).toMatchObject({ ok: false, code: "forbidden" });
    expect(await w.f.cli("pm", "peer-pr-push-record", "PR401", "--text", "x", "--key", key, "--result", "queued")).toMatchObject({ ok: false, code: "forbidden" });
    expect(queued(w)).toHaveLength(0);

    // a row with a complete, correct binding (taken from an identical ledger), but written under the scheduler identity
    const twin = await world();
    const twinRefused = await twin.refuseOriginal();
    expect([twin.review.seq, twinRefused.seq, twin.review.ts]).toEqual([w.review.seq, refused.seq, w.review.ts]);
    const real = requestRedelivery(twin.f.db, twin.f.at("pm"), input, cfg, read).event;
    twin.f.close();
    insertEvent(w.f.db, w.f.at("scheduler"), { project: "p", target: "PR401", kind: "note", text: "x", data: real.data }, true);
    expect(await w.pass()).toEqual([`PR401:${key} refused`]);
    expect(w.row(key, "refused").text).toContain("申请人已不是本项目的 PM");
    expect(w.posts).toHaveLength(0);
    w.f.close();
  });

  test("申请人之后不再是 PM：发送前拒", async () => {
    const w = await world();
    const refused = await w.refuseOriginal();
    expect(await w.retry("pm", w.review.seq, refused.seq)).toMatchObject({ ok: true });
    w.f.db.query("UPDATE meta SET value = '[\"someone-else\"]' WHERE project = 'p' AND key = 'pms'").run();
    const key = `redeliver:${w.review.seq}:${refused.seq}`;
    expect(await w.pass()).toEqual([`PR401:${key} refused`]);
    expect(w.row(key, "refused").text).toContain("申请人已不是本项目的 PM");
    expect(w.posts).toHaveLength(0);
    w.f.close();
  });
});

describe("拒：指错对象", () => {
  test("错 review、错拒收记录、非 peer 卡、已 sent 的审查：不写申请行、不外发", async () => {
    const w = await world();
    const refused = await w.refuseOriginal();
    const claimed = w.row(w.key, "claimed");
    expect(await w.retry("pm", refused.seq, refused.seq)).toMatchObject({ ok: false, code: "invalid" });
    expect(await w.retry("pm", w.review.seq + 100_000, refused.seq)).toMatchObject({ ok: false, code: "invalid" });
    expect(await w.retry("pm", w.review.seq, claimed.seq)).toMatchObject({ ok: false, code: "invalid" });
    expect(await w.retry("pm", w.review.seq, w.review.seq)).toMatchObject({ ok: false, code: "invalid" });
    expect(await w.f.cli("pm", "peer-pr-retry", "T1", "--review", "1", "--refused", "2")).toMatchObject({ ok: false, code: "invalid" });
    expect(await w.f.cli("pm", "peer-pr-retry", "PR401", "--review", String(w.review.seq))).toMatchObject({ ok: false, code: "invalid" });
    expect(await w.f.cli("pm", "peer-pr-retry", "PR999", "--review", "1", "--refused", "2")).toMatchObject({ ok: false, code: "not_found" });
    expect(queued(w)).toHaveLength(0);
    expect(await w.pass()).toEqual([]);
    w.f.close();

    const s = await world();
    expect(await s.pass()).toEqual([`PR401:${s.key} sent`]);
    expect(await s.retry("pm", s.review.seq, s.row(s.key, "sent").seq)).toMatchObject({ ok: false, code: "invalid" });
    // a refused row forged next to a real sent one still cannot be requested
    insertEvent(s.f.db, s.f.at("scheduler"), { project: "p", target: "PR401", kind: "note", text: "x", data: { op: "peer_pr_push", key: s.key, result: "refused" } }, true);
    const forged = s.events().at(-1)!;
    expect(await s.retry("pm", s.review.seq, forged.seq)).toMatchObject({ ok: false, code: "conflict", error: expect.stringContaining("已经送达") });
    expect(s.posts).toHaveLength(1);
    s.f.close();
  });

  test("peer 的指纹 / agent 换了或撤了：申请时拒；申请后才撤的，发送前拒（拒收保留，不再发）", async () => {
    const w = await world();
    const refused = await w.refuseOriginal();
    const other = { ...PEERS, peers: [{ ...PEERS.peers[0]!, fp: "ffff-ffff-ffff-ffff" }] };
    writeConfig(other);
    expect(await w.retry("pm", w.review.seq, refused.seq)).toMatchObject({ ok: false, code: "forbidden" });
    writeConfig({ ...PEERS, enabled: false });
    expect(await w.retry("pm", w.review.seq, refused.seq)).toMatchObject({ ok: false, code: "forbidden" });
    writeConfig();
    expect(await w.retry("pm", w.review.seq, refused.seq)).toMatchObject({ ok: true });
    writeConfig({ ...PEERS, peers: [{ ...PEERS.peers[0]!, agent: "agent-y" }] });
    const key = `redeliver:${w.review.seq}:${refused.seq}`;
    expect(await w.pass()).toEqual([`PR401:${key} refused`]);
    writeConfig();
    expect(await w.pass()).toEqual([]);
    expect(w.posts).toHaveLength(0);
    expect(w.rows(key)).toEqual(["queued", "refused"]);
    w.f.close();
  });

  test("申请后 head 漂了（进了下一轮）：发送前拒", async () => {
    const w = await world();
    const refused = await w.refuseOriginal();
    expect(await w.retry("pm", w.review.seq, refused.seq)).toMatchObject({ ok: true });
    await w.drift();
    const key = `redeliver:${w.review.seq}:${refused.seq}`;
    expect(await w.pass()).toEqual([`PR401:${key} refused`]);
    expect(w.row(key, "refused").text).toContain("head 漂移");
    expect(w.rows(key)).toEqual(["queued", "refused"]);
    expect(w.frames).toHaveLength(1);
    expect(w.posts).toHaveLength(0);
    w.f.close();
  });
});

describe("拒：报告不是原样", () => {
  test("拒收之后改过的报告不能申请；申请之后改了正文的，发送前拒", async () => {
    const w = await world();
    const refused = await w.refuseOriginal();
    const stat = statSync(REPORT_FILE);
    writeReport(REPORT.replace("P1 finding", "P2 finding"));
    utimesSync(REPORT_FILE, stat.atime, stat.mtime); // the old timestamp proves nothing
    expect(await w.retry("pm", w.review.seq, refused.seq)).toMatchObject({ ok: false, code: "conflict", error: expect.stringContaining("摘要不一致") });
    expect(queued(w)).toHaveLength(0);
    rmSync(REPORT_FILE);
    expect(await w.retry("pm", w.review.seq, refused.seq)).toMatchObject({ ok: false, code: "invalid" });
    writeReport(REPORT);
    expect(await w.retry("pm", w.review.seq, refused.seq)).toMatchObject({ ok: true });
    writeReport(REPORT.replace("P1 finding", "P2 finding"));
    const key = `redeliver:${w.review.seq}:${refused.seq}`;
    expect(await w.pass()).toEqual([`PR401:${key} refused`]);
    expect(w.row(key, "refused").text).toContain("报告正文在申请补发之后变了");
    expect(w.posts).toHaveLength(0);
    w.f.close();
  });
});

describe("拒：门禁照旧", () => {
  const cases: [string, string][] = [
    ["发送门", `P1 finding race-1\ns k - abcdefghijklmnopqrstuvwx\nhead ${HEAD}`],
    ["大小上限", `P1 finding race-1\n${"长".repeat(PUSH_MAX_BYTES / 3)}`],
  ];
  for (const [what, report] of cases) {
    test(`${what}仍拦：补发照样拒收并停下，不自己再排一次`, async () => {
      const w = await world(report);
      expect(await w.pass()).toEqual([`PR401:${w.key} refused`]);
      const refused = w.row(w.key, "refused");
      expect(await w.retry("pm", w.review.seq, refused.seq)).toMatchObject({ ok: true });
      const key = `redeliver:${w.review.seq}:${refused.seq}`;
      expect(await w.pass()).toEqual([`PR401:${key} refused`]);
      for (let i = 0; i < 3; i++) { w.f.advance(3_600_000); expect(await w.pass()).toEqual([]); }
      expect(queued(w)).toHaveLength(1);
      expect(w.rows(key)).toEqual(["queued", "refused"]);
      expect(w.frames).toHaveLength(0);
      expect(w.posts).toHaveLength(0);
      expect(w.notices.filter((n) => n.includes(key))).toHaveLength(1);
      w.f.close();
    });
  }

  test("本机门过了、bridge 复核拦下：同样是拒收终态；PM 再对新的拒收记录显式申请才有下一次", async () => {
    const w = await world();
    const refused = await w.refuseOriginal();
    expect(await w.retry("pm", w.review.seq, refused.seq)).toMatchObject({ ok: true });
    w.answerWith(OLD_GATE);
    const key = `redeliver:${w.review.seq}:${refused.seq}`;
    expect(await w.pass()).toEqual([`PR401:${key} refused`]);
    w.answerWith(null);
    w.f.advance(3_600_000);
    expect(await w.pass()).toEqual([]);
    expect(w.posts).toHaveLength(0);
    const again = w.row(key, "refused");
    expect(await w.retry("pm", w.review.seq, again.seq)).toMatchObject({ ok: true, key: `redeliver:${w.review.seq}:${again.seq}`, duplicate: false });
    expect(await w.pass()).toEqual([`PR401:redeliver:${w.review.seq}:${again.seq} sent`]);
    expect(w.posts).toHaveLength(1);
    w.f.close();
  });
});

describe("拒：结果不明不盲发", () => {
  test("原推送有过结果不明的一次：之后的拒收不能申请", async () => {
    const w = await world();
    const refused = await w.refuseOriginal(UNKNOWN, OLD_GATE);
    expect(w.rows(w.key)).toEqual(["claimed", "failed", "claimed", "refused"]);
    expect(await w.retry("pm", w.review.seq, refused.seq)).toMatchObject({ ok: false, code: "conflict", error: expect.stringContaining("核实是否收到") });
    expect(queued(w)).toHaveLength(0);
    w.f.close();
  });

  for (const [what, set] of [["答复丢了", (w: World) => w.answerWith(UNKNOWN)], ["对方回 500", (w: World) => w.statusIs(500)]] as const) {
    test(`补发那一次${what}：不记 sent、不重发，告诉 PM 去核实，之后也不能再申请`, async () => {
      const w = await world();
      const refused = await w.refuseOriginal();
      expect(await w.retry("pm", w.review.seq, refused.seq)).toMatchObject({ ok: true });
      set(w);
      const key = `redeliver:${w.review.seq}:${refused.seq}`, sentFrames = w.frames.length;
      expect(await w.pass()).toEqual([`PR401:${key} failed`]);
      w.answerWith(null);
      w.statusIs(202);
      w.f.advance(3_600_000);
      expect(await w.pass()).toEqual([`PR401:${key} abandoned`]);
      expect(await w.pass()).toEqual([]);
      expect(w.frames).toHaveLength(sentFrames + 1);
      expect(w.rows(key)).toEqual(["queued", "claimed", "failed", "abandoned"]);
      expect(w.notices.at(-1)).toContain("请先用原通道向对方核实是否收到");
      expect(await w.retry("pm", w.review.seq, refused.seq)).toMatchObject({ ok: true, duplicate: true });
      expect(await w.pass()).toEqual([]);
      w.f.close();
    });
  }
});

describe("只发一次", () => {
  test("重复 / 并发申请只有一行；两轮并发推送只认领一次、只 POST 一次", async () => {
    const w = await world();
    const refused = await w.refuseOriginal();
    const both = await Promise.all([w.retry("pm", w.review.seq, refused.seq), w.retry("owner", w.review.seq, refused.seq)]);
    expect(both.map((r) => r.duplicate).sort()).toEqual([false, true]);
    expect(await w.retry("master", w.review.seq, refused.seq)).toMatchObject({ ok: true, duplicate: true });
    expect(queued(w)).toHaveLength(1);
    const key = `redeliver:${w.review.seq}:${refused.seq}`;
    const outcomes = (await Promise.all([w.pass(), w.pass(), w.pass()])).flat().sort();
    expect(outcomes).toEqual([`PR401:${key} claimed-elsewhere`, `PR401:${key} claimed-elsewhere`, `PR401:${key} sent`]);
    expect(w.posts).toHaveLength(1);
    expect(w.rows(key)).toEqual(["queued", "claimed", "sent"]);
    w.f.close();
  });

  test("重启：认领后没有回执的补发不再发；认领记录本身幂等", async () => {
    const w = await world();
    const refused = await w.refuseOriginal();
    expect(await w.retry("pm", w.review.seq, refused.seq)).toMatchObject({ ok: true });
    const key = `redeliver:${w.review.seq}:${refused.seq}`;
    const claim = () => w.f.cli("scheduler", "peer-pr-push-record", "PR401", "--key", key, "--result", "claimed", "--text", "认领推送");
    expect(await claim()).toMatchObject({ ok: true, duplicate: false });
    expect(await claim()).toMatchObject({ ok: true, duplicate: true });
    const frames = w.frames.length;
    expect(await w.pass()).toEqual([`PR401:${key} in-flight`]);
    w.f.advance(61_000);
    expect(await w.pass()).toEqual([`PR401:${key} abandoned`]);
    expect(await w.pass()).toEqual([]);
    expect(w.frames).toHaveLength(frames);
    expect(w.posts).toHaveLength(0);
    expect(w.notices.at(-1)).toContain("认领后没有回执");
    w.f.close();
  });

  test("CAS：核对报告期间卡上多了事件，整笔不写", async () => {
    const w = await world();
    const refused = await w.refuseOriginal();
    const cfg = (readPeerPrConfig() as { config: PeerPrCtx["cfg"] }).config;
    const input = { taskId: "PR401", review: w.review.seq, refused: refused.seq };
    const racing = () => {
      recordPeerPrNote(w.f.db, w.f.at("scheduler"), { project: "p", target: "PR401", key: "late:x", result: "notice", text: "别处写了一行" });
      return { text: REPORT };
    };
    let error: LedgerEvent | LedgerError | null = null;
    try { error = requestRedelivery(w.f.db, w.f.at("pm"), input, cfg, racing).event; } catch (e) { error = e as LedgerError; }
    expect(error).toMatchObject({ code: "conflict", message: expect.stringContaining("重新申请") });
    expect(queued(w)).toHaveLength(0);
    expect(requestRedelivery(w.f.db, w.f.at("pm"), input, cfg, () => ({ text: REPORT }))).toMatchObject({ duplicate: false });
    expect(queued(w)).toHaveLength(1);
    w.f.close();
  });
});

describe("报告是不是原样：只认原推送留在台账里的摘要", () => {
  /**
   * A refusal as it was recorded before refused rows carried the report digest (the row is written through the real record
   * command): after a claim whose frame provably never left, so the only evidence is that claim's push digest; or with no claim.
   */
  const historic = async (w: World, claimFirst = true) => {
    if (claimFirst) {
      w.answerWith(async () => ({ ok: false, sent: false, error: "peer-prs.json 没开", rejected: "peer_pr_config" }));
      expect(await w.pass()).toEqual([`PR401:${w.key} failed`]);
      w.answerWith(null);
    }
    expect(await w.f.cli("scheduler", "peer-pr-push-record", "PR401", "--key", w.key, "--result", "refused", "--text", "没发给对方：门拦下（x）",
      "--data", JSON.stringify({ rule: "门拦下（x）" }))).toMatchObject({ ok: true, duplicate: false });
    return w.row(w.key, "refused");
  };

  test("历史拒收（只有认领时的正文摘要）：原样的报告补发成功", async () => {
    const w = await world();
    const refused = await historic(w);
    expect(await w.retry("pm", w.review.seq, refused.seq)).toMatchObject({ ok: true, duplicate: false });
    const claim = w.row(w.key, "claimed");
    expect(queued(w)[0]!.data.redeliver).toMatchObject({ origin: { kind: "push", digest: claim.data.digest, bytes: claim.data.bytes, seq: claim.seq } });
    expect(await w.pass()).toEqual([`PR401:redeliver:${w.review.seq}:${refused.seq} sent`]);
    expect(w.posts).toHaveLength(1);
    w.f.close();
  });

  test("历史拒收：P1 改成 P2、文件时间照旧，渲染出的正文对不上原认领摘要，一个字节不发", async () => {
    const w = await world();
    const refused = await historic(w);
    const stat = statSync(REPORT_FILE);
    writeReport(REPORT.replace("P1 finding", "P2 finding"));
    utimesSync(REPORT_FILE, stat.atime, stat.mtime);
    const key = `redeliver:${w.review.seq}:${refused.seq}`;
    await w.retry("pm", w.review.seq, refused.seq); // the request cannot render; the send-time comparison is what decides
    expect(await w.pass()).toEqual([`PR401:${key} refused`]);
    expect(w.row(key, "refused").text).toContain("与原推送认领时记下的摘要不一致");
    expect(w.rows(key)).toEqual(["queued", "refused"]);
    expect(w.frames).toHaveLength(1);
    expect(w.posts).toHaveLength(0);
    w.f.close();
  });

  test("台账里什么摘要都没留下：申请就拒；伪造在别的 key 上的摘要不算数", async () => {
    const w = await world();
    const refused = await w.refuseOriginal();
    const changed = REPORT.replace("P1 finding", "P2 finding");
    const forgedKey = `redeliver:${w.review.seq}:999999`;
    expect(await w.f.cli("pm", "peer-pr-push-record", "PR401", "--key", forgedKey, "--result", "refused", "--text", "x", "--data",
      JSON.stringify({ report: { sha256: sha(changed), bytes: Buffer.byteLength(changed) } }))).toMatchObject({ ok: true });
    writeReport(changed);
    expect(await w.retry("pm", w.review.seq, w.row(forgedKey, "refused").seq)).toMatchObject({ ok: false, code: "conflict", error: expect.stringContaining("摘要不一致") });
    expect(queued(w)).toHaveLength(0);
    w.f.close();

    const bare = await world();
    const old = await historic(bare, false);
    expect(await bare.retry("pm", bare.review.seq, old.seq)).toMatchObject({ ok: false, code: "conflict", error: expect.stringContaining("没有在台账里留下") });
    expect(queued(bare)).toHaveLength(0);
    expect(await bare.pass()).toEqual([]);
    expect(bare.posts).toHaveLength(0);
    bare.f.close();
  });
});

describe("拒：head 漂移的每个窗口", () => {
  test("申请之前 head 已经漂了：不写申请行、不外发", async () => {
    const w = await world();
    const refused = await w.refuseOriginal();
    await w.drift();
    expect(await w.retry("pm", w.review.seq, refused.seq)).toMatchObject({ ok: false, code: "conflict", error: expect.stringContaining("head 漂移") });
    expect(queued(w)).toHaveLength(0);
    expect(await w.pass()).toEqual([]);
    expect(w.frames).toHaveLength(1);
    expect(w.posts).toHaveLength(0);
    w.f.close();
  });

  const windows: [string, "commits" | "claimed", string[], (w: World) => Promise<unknown>][] = [
    ["渲染的异步查 commit 期间 head 漂了：认领事务里重核，拒", "commits", ["queued", "refused"], (w) => w.drift()],
    ["渲染期间 peer 的 agent 被换掉：认领事务里重核，拒", "commits", ["queued", "refused"],
      async () => writeConfig({ ...PEERS, peers: [{ ...PEERS.peers[0]!, agent: "agent-y" }] })],
    ["认领之后、发帧之前 head 漂了：发送前最后一核，拒", "claimed", ["queued", "claimed", "refused"], (w) => w.drift()],
  ];
  for (const [what, at, rows, move] of windows) {
    test(what, async () => {
      const w = await world();
      const refused = await w.refuseOriginal();
      expect(await w.retry("pm", w.review.seq, refused.seq)).toMatchObject({ ok: true });
      const key = `redeliver:${w.review.seq}:${refused.seq}`;
      w.hooks[at] = async () => { w.hooks[at] = undefined; await move(w); };
      expect(await w.pass()).toEqual([`PR401:${key} refused`]);
      writeConfig();
      expect(w.rows(key)).toEqual(rows);
      expect(w.frames).toHaveLength(1); // only the original push's frame
      expect(w.posts).toHaveLength(0);
      w.f.advance(3_600_000);
      expect(await w.pass()).toEqual([]);
      await w.retry("pm", w.review.seq, refused.seq);
      expect(queued(w)).toHaveLength(1);
      expect(await w.pass()).toEqual([]);
      expect(w.posts).toHaveLength(0);
      w.f.close();
    });
  }
});
