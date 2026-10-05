/** codex-probe 的场景（scripts/codex-probe.ts 跑它们）。每个场景返回一个可 JSON 化的观察结果，写进 result.json */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { inputTexts, type RecordedRequest, type Reply, requestKind } from "../tests/helpers/fake-responses.ts";
import { type Msg, type Probe, type ProbeOptions, psSnapshot, rolloutText, timeline } from "./codex-probe.ts";

type Scenario = (p: Probe) => Promise<unknown>;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
/** 有上限的轮询：条件成立返回 true，超时返回 false（场景据此照常往下走并留痕，不会卡死整个探针） */
async function until(pred: () => boolean, ms = 10_000): Promise<boolean> {
  const end = Date.now() + ms;
  while (!pred()) {
    if (Date.now() > end) return false;
    await sleep(20);
  }
  return true;
}
const text = (t: string, chunks = 1, chunkDelayMs = 0): Reply => ({ type: "text", text: t, chunks, chunkDelayMs });
const isResponses = (r: RecordedRequest) => r.method === "POST" && r.path.endsWith("/responses");
const input = (t: string) => [{ type: "text", text: t, text_elements: [] }];
const turnIdOf = (m: Msg | null | undefined): string | undefined => m?.params?.turn?.id ?? m?.params?.turnId;

/** 请求 input 的最后一项是不是 function_call_output（工具跑完回来了） */
function afterTool(r: RecordedRequest): boolean {
  const items = (r.body as { input?: Array<{ type?: string }> } | null)?.input ?? [];
  return items.at(-1)?.type === "function_call_output";
}

function notFound(): Reply {
  return { type: "json", status: 404, body: { error: { message: "not found" } } };
}

/** 默认剧本：/responses 回一句话，其它路径 404（并照常记录） */
function quick(r: RecordedRequest): Reply {
  return isResponses(r) ? text(`ok ${r.seq}`) : notFound();
}

/** 发 turn/start 不等；等到 turn/completed 或超时 */
async function runTurn(p: Probe, threadId: string, prompt: string, extra: Record<string, unknown> = {}, timeoutMs = 30_000) {
  const since = p.now();
  const id = p.send("turn/start", { threadId, input: input(prompt), ...extra });
  const done = await p.waitFor((m) => m.method === "turn/completed", timeoutMs, since);
  return { id, since, turnId: p.responseOf(id)?.result?.turn?.id as string | undefined, done };
}

/** 一轮的关键先后：start 回包 / turn/started / status active；turn/completed / status idle（相对 turn/start 发出的 ms） */
function order(p: Probe, since: number, reqId: number) {
  const after = p.msgs.filter((m) => m.t >= since);
  const idx = (pred: (m: Msg) => boolean) => after.findIndex(pred);
  const at = (i: number) => (i >= 0 ? after[i]!.t - since : null);
  const resp = idx((m) => m.id === reqId && !m.method);
  const started = idx((m) => m.method === "turn/started");
  const active = idx((m) => m.method === "thread/status/changed" && m.params?.status?.type === "active");
  const completed = idx((m) => m.method === "turn/completed");
  const idle = idx((m) => m.method === "thread/status/changed" && m.params?.status?.type === "idle");
  const seq = [["resp", resp], ["started", started], ["active", active]].filter(([, i]) => (i as number) >= 0).sort((a, b) => (a[1] as number) - (b[1] as number));
  return {
    startOrder: seq.map(([k]) => k).join("<"),
    endOrder: idle >= 0 && completed >= 0 ? (idle < completed ? "idle<completed" : "completed<idle") : `idle=${idle} completed=${completed}`,
    completedBeforeResp: completed >= 0 && resp >= 0 && completed < resp,
    ms: { resp: at(resp), started: at(started), active: at(active), idle: at(idle), completed: at(completed) },
  };
}

function tally(xs: string[]): Record<string, number> {
  return xs.reduce<Record<string, number>>((acc, x) => ((acc[x] = (acc[x] ?? 0) + 1), acc), {});
}

/** Q0-3 / Q0-5 / Q0-8：同一线程连跑 N 轮快回合，统计先后；每轮 turn/completed 一到就立刻 thread/read */
async function ordering(p: Probe, sendInitialized: boolean, n = 20) {
  await p.start(quick);
  if (sendInitialized) p.notify("initialized");
  const threadId = await p.startThread();
  const rounds = [];
  for (let i = 0; i < n; i++) {
    const t = await runTurn(p, threadId, `round ${i}`);
    const read = await p.request("thread/read", { threadId, includeTurns: false });
    await sleep(150);
    rounds.push({ ...order(p, t.since, t.id), readAtCompleted: read.result?.thread?.status?.type ?? JSON.stringify(read.error) });
  }
  const methods = [...new Set(p.msgs.map((m) => m.method).filter(Boolean))].sort();
  return {
    startOrder: tally(rounds.map((r) => r.startOrder)),
    endOrder: tally(rounds.map((r) => r.endOrder)),
    completedBeforeResp: rounds.filter((r) => r.completedBeforeResp).length,
    readAtCompleted: tally(rounds.map((r) => r.readAtCompleted)),
    respMs: rounds.map((r) => r.ms.resp),
    methods,
    firstRound: timeline(p.msgs, 0).slice(0, 40),
  };
}

const order_initialized: Scenario = (p) => ordering(p, true);
const order_no_initialized: Scenario = (p) => ordering(p, false);

/** Q0-3 steer 确认延迟 + Q0-8 回合中 thread/read：一轮慢流式文字（约 12s），中途每 400ms steer 一次 */
const steer_latency: Scenario = async (p) => {
  await p.start((r) => (isResponses(r) ? (r.seq === 1 ? text("slow ".repeat(40), 40, 300) : text(`after steer ${r.seq}`)) : notFound()));
  p.notify("initialized");
  const threadId = await p.startThread();
  const since = p.now();
  const startId = p.send("turn/start", { threadId, input: input("long answer please") });
  const started = await p.waitFor((m) => m.method === "turn/started", 10_000, since);
  const turnId = turnIdOf(started)!;
  const lat: Array<number | string> = [];
  const reads: string[] = [];
  for (let i = 0; i < 10; i++) {
    const t = p.now();
    const r = await p.request("turn/steer", { threadId, expectedTurnId: turnId, input: input(`STEER-${i}`) }, 10_000);
    lat.push(r.error ? `err:${JSON.stringify(r.error)}` : r.t - t);
    const rd = await p.request("thread/read", { threadId, includeTurns: false });
    reads.push(rd.result?.thread?.status?.type ?? "err");
    await sleep(400);
  }
  const done = await p.waitFor((m) => m.method === "turn/completed", 60_000, since);
  await sleep(300);
  const after = await p.request("thread/read", { threadId, includeTurns: true });
  const steerReqs = p.fake.requests.filter(isResponses).map((r) => inputTexts(r.body).filter((s) => s.startsWith("STEER-")));
  return {
    steerAckMs: lat,
    readsDuringTurn: tally(reads),
    readAfter: after.result?.thread?.status?.type,
    turnStatus: done?.params?.turn?.status,
    sameTurn: turnIdOf(done) === turnId,
    responsesRequests: p.fake.requests.filter(isResponses).length,
    steersPerRequest: steerReqs,
    order: order(p, since, startId),
  };
};

/** Q0-1：steer 进去、还没被消费就 interrupt。mode=stream 时模型流挂住；mode=tool 时正在跑一条 sleep 命令 */
async function steerThenInterrupt(p: Probe, mode: "stream" | "tool") {
  let n = 0;
  await p.start((r) => {
    if (!isResponses(r)) return notFound();
    n++;
    if (n === 1) return mode === "stream" ? { type: "hang" } : { type: "tool", name: "exec_command", args: { cmd: "sleep 20", yield_time_ms: 30000 } };
    return text(`reply ${r.seq}`);
  });
  p.notify("initialized");
  const threadId = await p.startThread();
  const since = p.now();
  p.send("turn/start", { threadId, input: input("first prompt") });
  const turnId = turnIdOf(await p.waitFor((m) => m.method === "turn/started", 10_000, since))!;
  if (mode === "tool") await p.waitFor((m) => m.method === "item/started" && m.params?.item?.type === "commandExecution", 10_000, since);
  else await until(() => p.fake.requests.some(isResponses));
  await sleep(300);
  const steer = await p.request("turn/steer", { threadId, expectedTurnId: turnId, input: input("STEER-UNCONSUMED") });
  await sleep(200);
  const tInt = p.now();
  const intr = await p.request("turn/interrupt", { threadId, turnId });
  const done = await p.waitFor((m) => m.method === "turn/completed", 15_000, since);
  await sleep(500);
  const reqsBefore = p.fake.requests.filter(isResponses).length;
  const steerSeenBeforeNext = p.fake.requests.some((r) => inputTexts(r.body).includes("STEER-UNCONSUMED"));
  const readAfter = await p.request("thread/read", { threadId, includeTurns: true });
  const rolloutHas = rolloutText(p.codexHome).includes("STEER-UNCONSUMED");
  // 下一轮：看 steer 的内容有没有跟着进下一轮的模型请求
  const next = await runTurn(p, threadId, "second prompt");
  await sleep(300);
  const nextReq = p.fake.requests.filter(isResponses).at(-1);
  const steerItems = p.msgs.filter((m) => m.method?.startsWith("item/") && JSON.stringify(m.params).includes("STEER-UNCONSUMED")).map((m) => `${m.t}ms ${m.method} ${m.params?.item?.type}`);
  return {
    mode,
    steerResp: steer.result ?? steer.error,
    interruptResp: intr.result ?? intr.error,
    interruptToCompletedMs: done ? done.t - tInt : null,
    turnStatus: done?.params?.turn?.status,
    responsesRequestsBeforeNext: reqsBefore,
    steerSentToModelBeforeNext: steerSeenBeforeNext,
    steerInRollout: rolloutHas,
    steerInThreadRead: JSON.stringify(readAfter.result ?? {}).includes("STEER-UNCONSUMED"),
    steerInNextTurnRequest: nextReq ? inputTexts(nextReq.body).includes("STEER-UNCONSUMED") : null,
    nextTurnInputTail: nextReq ? inputTexts(nextReq.body).slice(-4).map((s) => s.slice(0, 60)) : null,
    steerItemEvents: steerItems,
    nextTurnStatus: next.done?.params?.turn?.status,
    timeline: timeline(p.msgs, since),
  };
}

const steer_interrupt_stream: Scenario = (p) => steerThenInterrupt(p, "stream");
const steer_interrupt_tool: Scenario = (p) => steerThenInterrupt(p, "tool");

/** Q0-4：A 已收尾、B 在跑，用 A 的 turnId（以及一个编造的 id）发 interrupt，看 B 会不会被打断 */
const stale_interrupt: Scenario = async (p) => {
  await p.start((r) => (isResponses(r) ? (r.seq === 1 ? text("A done") : { type: "hang" }) : notFound()));
  p.notify("initialized");
  const threadId = await p.startThread();
  const a = await runTurn(p, threadId, "turn A");
  await sleep(300);
  const sinceB = p.now();
  p.send("turn/start", { threadId, input: input("turn B") });
  const bId = turnIdOf(await p.waitFor((m) => m.method === "turn/started", 10_000, sinceB))!;
  await sleep(500);
  const staleResp = await p.request("turn/interrupt", { threadId, turnId: a.turnId });
  const bogusResp = await p.request("turn/interrupt", { threadId, turnId: "00000000-0000-0000-0000-000000000000" });
  const bEndedEarly = await p.waitFor((m) => m.method === "turn/completed" && turnIdOf(m) === bId, 3_000, sinceB);
  const readMid = await p.request("thread/read", { threadId, includeTurns: false });
  const staleSteer = await p.request("turn/steer", { threadId, expectedTurnId: a.turnId, input: input("stale steer"), clientUserMessageId: "cum-stale-steer" });
  const realResp = await p.request("turn/interrupt", { threadId, turnId: bId });
  const bEnd = await p.waitFor((m) => m.method === "turn/completed" && turnIdOf(m) === bId, 10_000, sinceB);
  await sleep(300);
  const readEnd = await p.request("thread/read", { threadId, includeTurns: false });
  const idleInterrupt = await p.request("turn/interrupt", { threadId, turnId: bId });
  const idleSteer = await p.request("turn/steer", { threadId, expectedTurnId: bId, input: input("idle steer") });
  return {
    staleSteerResp: staleSteer.result ?? staleSteer.error,
    idleInterruptResp: idleInterrupt.result ?? idleInterrupt.error,
    idleSteerResp: idleSteer.result ?? idleSteer.error,
    aTurnId: a.turnId,
    bTurnId: bId,
    staleInterruptResp: staleResp.result ?? staleResp.error,
    bogusInterruptResp: bogusResp.result ?? bogusResp.error,
    bInterruptedByStale: !!bEndedEarly,
    readWhileBRunning: readMid.result?.thread?.status,
    realInterruptResp: realResp.result ?? realResp.error,
    bFinalStatus: bEnd?.params?.turn?.status,
    readAfterInterrupt: readEnd.result?.thread?.status,
    timeline: timeline(p.msgs, sinceB),
  };
};

/** Q0-4 补充：空闲时（上一轮已收尾）发 interrupt 不回包——看它会不会挂着，等下一轮开始时落到新回合上 */
async function idleInterrupt(p: Probe, which: "previous" | "bogus" | "afterInterrupted") {
  const aReply: Reply = which === "afterInterrupted" ? { type: "hang" } : text("A done");
  await p.start((r) => (isResponses(r) ? (r.seq === 1 ? aReply : text("slow ".repeat(12), 12, 250)) : notFound()));
  p.notify("initialized");
  const threadId = await p.startThread();
  // afterInterrupted：A 是被 interrupt 掉的（stale_interrupt 里空闲 interrupt 30s 没回包就是这种情况）
  const a = which === "afterInterrupted" ? await interruptedTurn(p, threadId) : await runTurn(p, threadId, "turn A");
  await sleep(300);
  const tInt = p.now();
  const intId = p.send("turn/interrupt", { threadId, turnId: which === "bogus" ? "00000000-0000-0000-0000-000000000000" : a.turnId });
  await sleep(2000);
  const respBeforeNext = p.responseOf(intId);
  const sinceB = p.now();
  const b = await runTurn(p, threadId, "turn B");
  await sleep(1000);
  const resp = p.responseOf(intId);
  return {
    which,
    interruptRespWithin2s: respBeforeNext ? (respBeforeNext.result ?? respBeforeNext.error) : null,
    interruptRespEventually: resp ? { afterMs: resp.t - tInt, body: resp.result ?? resp.error, afterTurnBStarted: resp.t >= sinceB } : null,
    turnBStatus: b.done?.params?.turn?.status,
    turnBDurationMs: b.done ? b.done.t - sinceB : null,
    timeline: timeline(p.msgs, tInt).filter((l) => !l.includes("delta")),
  };
}

async function interruptedTurn(p: Probe, threadId: string) {
  const since = p.now();
  p.send("turn/start", { threadId, input: input("turn A") });
  const turnId = turnIdOf(await p.waitFor((m) => m.method === "turn/started", 10_000, since));
  await until(() => p.fake.requests.some(isResponses));
  await p.request("turn/interrupt", { threadId, turnId });
  await p.waitFor((m) => m.method === "turn/completed" && turnIdOf(m) === turnId, 10_000, since);
  return { turnId };
}

const idle_interrupt_previous: Scenario = (p) => idleInterrupt(p, "previous");
const idle_interrupt_after_interrupted: Scenario = (p) => idleInterrupt(p, "afterInterrupted");
const idle_interrupt_bogus: Scenario = (p) => idleInterrupt(p, "bogus");

/** Q0-2 手动压缩：两轮对话后 thread/compact/start；剧本对所有路径都先回 404，观察 Codex 走哪条、要什么形状 */
async function compactRun(p: Probe, compactReply: (r: RecordedRequest) => Reply, opts: ProbeOptions = {}) {
  await p.start((r) => {
    if (r.path.includes("/responses/compact")) return compactReply(r);
    if (!isResponses(r)) return notFound();
    return requestKind(r) === "compaction" ? compactReply(r) : text(`answer ${r.seq}`);
  }, opts);
  p.notify("initialized");
  const threadId = await p.startThread();
  await runTurn(p, threadId, "first question");
  await runTurn(p, threadId, "second question");
  await sleep(300);
  const since = p.now();
  const resp = await p.request("thread/compact/start", { threadId });
  // since 可能和上一轮 turn/completed 同一毫秒：按压缩回合自己的 turnId 等，别把上一轮的收尾当成压缩的
  const cTurn = turnIdOf(await p.waitFor((m) => m.method === "turn/started", 10_000, since));
  const done = await p.waitFor((m) => (m.method === "turn/completed" && turnIdOf(m) === cTurn) || m.method === "thread/compacted", 30_000, since);
  await sleep(1500);
  const after = await runTurn(p, threadId, "after compact");
  const reqs = p.fake.requests.filter((r) => r.at - p.t0 >= since);
  return {
    compactResp: resp.result ?? resp.error,
    firstTerminal: done?.method,
    timeline: timeline(p.msgs, since).filter((l) => !l.includes("delta")),
    httpDuringCompact: reqs.map((r) => ({
      path: r.path,
      kind: requestKind(r),
      ntools: (r.body as { tools?: unknown[] }).tools?.length,
      inputTail: inputTexts(r.body).slice(-1).map((x) => x.slice(0, 120)),
    })),
    afterCompactInput: inputTexts(p.fake.requests.filter(isResponses).at(-1)?.body).map((s) => s.slice(0, 80)),
    afterTurnStatus: after.done?.params?.turn?.status,
  };
}

/** 本地压缩请求回摘要；/responses/compact（远端压缩）回一个 compaction item——两条路都备好，看 Codex 实际走哪条 */
const SUMMARY = (r: RecordedRequest): Reply =>
  r.path.includes("/responses/compact") ? { type: "json", body: { output: [{ type: "compaction", encrypted_content: "FAKE-SUMMARY" }] } } : text("SUMMARY-OF-CONVERSATION");
const compact_manual: Scenario = (p) => compactRun(p, SUMMARY);
const compact_fail: Scenario = (p) => compactRun(p, () => ({ type: "fail", message: "compaction exploded", status: 500 }));

/** Q0-2 自动压缩：上下文窗口压到很小，每次回包报大 token 用量，看下一轮开始前 / 中途怎么压 */
const compact_auto: Scenario = async (p) => {
  const usage = { input_tokens: 9000, output_tokens: 100, total_tokens: 9100 };
  await p.start(
    (r) => {
      if (r.path.includes("/responses/compact") || requestKind(r) === "compaction") return SUMMARY(r);
      return isResponses(r) ? { type: "text", text: `answer ${r.seq}`, usage } : notFound();
    },
    { topToml: "model_context_window = 10000\nmodel_auto_compact_token_limit = 5000" },
  );
  p.notify("initialized");
  const threadId = await p.startThread();
  const rounds = [];
  for (let i = 0; i < 3; i++) {
    const t = await runTurn(p, threadId, `question ${i}`);
    rounds.push({ turnId: t.turnId, status: t.done?.params?.turn?.status, events: timeline(p.msgs, t.since).filter((l) => !l.includes("delta")) });
    await sleep(300);
  }
  return { rounds, http: p.fake.requests.map((r) => ({ path: r.path, kind: requestKind(r), inputTail: inputTexts(r.body).slice(-1).map((x) => x.slice(0, 60)) })) };
};

/** 最小 stdio MCP server：回 initialize / tools/list；记收到的信号。STUB_STUBBORN=1 时 stdin EOF 不退，STUB_IGNORE_TERM=1 时 SIGTERM 也不退 */
const MCP_STUB = `
const fs = require("node:fs");
const log = (s) => fs.appendFileSync(process.env.STUB_LOG, Date.now() + " " + s + "\\n");
log("start ppid=" + process.ppid);
for (const sig of ["SIGTERM", "SIGINT", "SIGHUP"]) process.on(sig, () => { log("signal " + sig); if (process.env.STUB_IGNORE_TERM !== "1") process.exit(0); });
let buf = "";
process.stdin.on("data", (c) => {
  buf += c;
  let i;
  while ((i = buf.indexOf("\\n")) >= 0) {
    const line = buf.slice(0, i); buf = buf.slice(i + 1);
    let m; try { m = JSON.parse(line); } catch { continue; }
    const reply = (result) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: m.id, result }) + "\\n");
    if (m.method === "initialize") reply({ protocolVersion: m.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: "stub", version: "0" } });
    else if (m.method === "tools/list") reply({ tools: [] });
    else if (m.id !== undefined) reply({});
  }
});
process.stdin.on("end", () => { log("stdin-eof"); if (process.env.STUB_STUBBORN !== "1") process.exit(0); });
setInterval(() => {}, 1000);
`;

interface EofCase {
  stubborn: boolean;
  ignoreTerm?: boolean;
  busy: "none" | "model" | "command";
  stop: "eof" | "sigkill-group" | "sigterm-group";
}

/** Q0-6：EOF（或整组 SIGKILL）后多久退出、MCP 子进程与正在跑的命令是否被清理、各自在哪个进程组 */
async function eofRun(p: Probe, c: EofCase) {
  const root = resolve(p.codexHome, "..");
  const stubPath = join(root, "mcp-stub.cjs");
  const stubLog = join(root, "mcp-stub.log");
  writeFileSync(stubPath, MCP_STUB);
  const env = `STUB_LOG = "${stubLog}", STUB_STUBBORN = "${c.stubborn ? 1 : 0}", STUB_IGNORE_TERM = "${c.ignoreTerm ? 1 : 0}"`;
  const toml = `[mcp_servers.stub]\ncommand = "${process.execPath}"\nargs = ["${stubPath}"]\nenv = { ${env} }\n`;
  const busyReply: Reply = c.busy === "command" ? { type: "tool", name: "exec_command", args: { cmd: "sleep 60", yield_time_ms: 30000 } } : { type: "hang" };
  await p.start((r) => (isResponses(r) ? busyReply : notFound()), { tablesToml: toml });
  p.notify("initialized");
  const threadId = await p.startThread();
  await until(() => existsSync(stubLog), 5_000);
  if (c.busy !== "none") {
    p.send("turn/start", { threadId, input: input("busy turn"), sandboxPolicy: { type: "dangerFullAccess" }, approvalPolicy: "never" });
    if (c.busy === "command") await p.waitFor((m) => m.method === "item/started" && m.params?.item?.type === "commandExecution", 10_000);
    else await p.waitFor((m) => m.method === "turn/started", 10_000);
    await sleep(500);
  }
  const before = psSnapshot();
  const desc = (pid: number): typeof before => before.filter((x) => x.ppid === pid).flatMap((ch) => [ch, ...desc(ch.pid)]);
  const tree = desc(p.proc.pid);
  const stopAt = Date.now();
  let exitMs: number | null;
  if (c.stop === "eof") exitMs = await p.closeAndWait(10_000);
  else {
    const t = p.killGroup(c.stop === "sigkill-group" ? "SIGKILL" : "SIGTERM");
    await until(() => p.exitedAt !== null, 5_000);
    exitMs = p.exitedAt === null ? null : p.exitedAt - t;
  }
  const alive = (pid: number) => psSnapshot().some((x) => x.pid === pid);
  const survivors: Record<string, string[]> = {};
  for (const wait of [0, 500, 2000, 3000]) {
    await sleep(wait);
    survivors[`+${wait}ms`] = tree.filter((x) => alive(x.pid)).map((x) => `${x.pid}:${x.comm.split("/").pop()}`);
  }
  const self = before.find((x) => x.pid === p.proc.pid);
  return {
    ...c,
    appServer: { pid: p.proc.pid, pgid: self?.pgid, ownGroup: self?.pgid === p.proc.pid },
    tree: tree.map((x) => ({ pid: x.pid, ppid: x.ppid, pgid: x.pgid, comm: x.comm.split("/").pop() })),
    exitAfterStopMs: exitMs,
    exitCode: p.exitCode,
    survivors,
    stubLog: existsSync(stubLog) ? readFileSync(stubLog, "utf8").trim().split("\n").map((l) => l.replace(/^(\d+)/, (ts) => `${Number(ts) - stopAt}ms`)) : [],
  };
}

const eof_idle: Scenario = (p) => eofRun(p, { stubborn: false, busy: "none", stop: "eof" });
const eof_idle_stubborn: Scenario = (p) => eofRun(p, { stubborn: true, busy: "none", stop: "eof" });
const eof_idle_ignore_term: Scenario = (p) => eofRun(p, { stubborn: true, ignoreTerm: true, busy: "none", stop: "eof" });
const eof_busy_model: Scenario = (p) => eofRun(p, { stubborn: true, busy: "model", stop: "eof" });
const eof_busy_command: Scenario = (p) => eofRun(p, { stubborn: true, busy: "command", stop: "eof" });
const sigkill_group_command: Scenario = (p) => eofRun(p, { stubborn: true, busy: "command", stop: "sigkill-group" });
const sigterm_group_command: Scenario = (p) => eofRun(p, { stubborn: true, ignoreTerm: true, busy: "command", stop: "sigterm-group" });

/** Q0-6 对照：信号路径（SIGTERM 整组）退出耗时 */
const sigterm_busy: Scenario = async (p) => {
  await p.start((r) => (isResponses(r) ? { type: "hang" } : notFound()));
  p.notify("initialized");
  const threadId = await p.startThread();
  p.send("turn/start", { threadId, input: input("busy turn") });
  await p.waitFor((m) => m.method === "turn/started", 10_000);
  await sleep(300);
  const at = p.signalServer("SIGTERM");
  for (let i = 0; i < 500 && p.exitedAt === null; i++) await sleep(20);
  return { exitAfterSigtermMs: p.exitedAt === null ? null : p.exitedAt - at, exitCode: p.exitCode };
};

/** Q0-7：审批请求的形状。模型先要一条越出沙箱的命令，审批一律 decline，工具结果回来后回一句话收尾 */
interface ApprovalCase {
  sandbox: "workspaceWrite" | "readOnly";
  cmd: Record<string, unknown>;
  policy?: string;
  experimentalApi?: boolean;
  /** 回给审批请求的 decision；holdMs>0 时先压着不答，期间 thread/read 一次（Q0-8：等审批时的 status） */
  decision?: string;
  holdMs?: number;
}

async function approvalRun(p: Probe, c: ApprovalCase) {
  const { sandbox, cmd, policy = "on-request", experimentalApi = true, decision = "decline", holdMs = 0 } = c;
  const requests: Msg[] = [];
  const readsWhileHolding: unknown[] = [];
  p.onServerRequest(async (m) => {
    requests.push(m);
    if (holdMs > 0) {
      const rd = await p.request("thread/read", { threadId: m.params?.threadId, includeTurns: false });
      readsWhileHolding.push(rd.result?.thread?.status ?? rd.error);
      await sleep(holdMs);
    }
    return m.method === "item/fileChange/requestApproval" || m.method === "item/commandExecution/requestApproval" ? { decision } : {};
  });
  await p.start((r) => (isResponses(r) ? (afterTool(r) ? text("done") : { type: "tool", name: "exec_command", args: cmd }) : notFound()), { experimentalApi });
  p.notify("initialized");
  const threadId = await p.startThread();
  const sandboxPolicy =
    sandbox === "readOnly"
      ? { type: "readOnly", networkAccess: false }
      : { type: "workspaceWrite", writableRoots: [], networkAccess: false, excludeTmpdirEnvVar: false, excludeSlashTmp: false };
  const t = await runTurn(p, threadId, "run the command", { approvalPolicy: policy, approvalsReviewer: "user", sandboxPolicy });
  await sleep(300);
  const toolOut = p.fake.requests
    .filter(isResponses)
    .flatMap((r) => ((r.body as { input?: Array<{ type?: string; output?: string }> }).input ?? []).filter((i) => i.type === "function_call_output"))
    .map((i) => String(i.output).slice(0, 160));
  return {
    sandbox,
    policy,
    experimentalApi,
    cmd,
    decision,
    readsWhileHolding,
    approvalRequests: requests.map((m) => ({ method: m.method, params: m.params, availableDecisionsNull: m.params?.availableDecisions == null })),
    toolOutputSeenByModel: [...new Set(toolOut)],
    turnStatus: t.done?.params?.turn?.status,
    timeline: timeline(p.msgs, t.since).filter((l) => !l.includes("delta")),
  };
}

const ESCALATE = (target: string) => ({ cmd: `echo probe > ${target}`, sandbox_permissions: "require_escalated", justification: "probe needs to write outside the workspace" });
const ww = "workspaceWrite" as const;
const ro = "readOnly" as const;
const approval_ww_escalated: Scenario = (p) => approvalRun(p, { sandbox: ww, cmd: ESCALATE("../outside.txt") });
const approval_ro_escalated: Scenario = (p) => approvalRun(p, { sandbox: ro, cmd: ESCALATE("../outside.txt") });
const approval_ro_plain_write: Scenario = (p) => approvalRun(p, { sandbox: ro, cmd: { cmd: "echo probe > inside.txt" } });
const approval_ww_untrusted: Scenario = (p) => approvalRun(p, { sandbox: ww, cmd: { cmd: "echo probe > inside.txt" }, policy: "untrusted" });
const approval_ww_escalated_noexp: Scenario = (p) => approvalRun(p, { sandbox: ww, cmd: ESCALATE("../outside.txt"), experimentalApi: false });
const approval_ww_cancel_held: Scenario = (p) => approvalRun(p, { sandbox: ww, cmd: ESCALATE("../outside.txt"), decision: "cancel", holdMs: 1500 });

/** Q0-2 压缩被打断：压缩请求挂住，对压缩回合发 turn/interrupt */
const compact_interrupt: Scenario = async (p) => {
  await p.start((r) => (!isResponses(r) ? notFound() : requestKind(r) === "compaction" ? { type: "hang" } : text(`answer ${r.seq}`)));
  p.notify("initialized");
  const threadId = await p.startThread();
  await runTurn(p, threadId, "first question");
  const since = p.now();
  const resp = await p.request("thread/compact/start", { threadId });
  const started = await p.waitFor((m) => m.method === "turn/started", 10_000, since);
  const sent = await until(() => p.fake.requests.some((r) => requestKind(r) === "compaction"));
  await sleep(300);
  const intr = await p.request("turn/interrupt", { threadId, turnId: turnIdOf(started) });
  const done = await p.waitFor((m) => m.method === "turn/completed" && turnIdOf(m) === turnIdOf(started), 10_000, since);
  await sleep(500);
  const after = await runTurn(p, threadId, "after interrupted compact");
  return {
    compactResp: resp.result ?? resp.error,
    compactionRequestSent: sent,
    interruptResp: intr.result ?? intr.error,
    turnStatus: done?.params?.turn?.status,
    timeline: timeline(p.msgs, since).filter((l) => !l.includes("delta")),
    afterTurnStatus: after.done?.params?.turn?.status,
    afterInputHasSummaryPreamble: inputTexts(p.fake.requests.filter(isResponses).at(-1)?.body).some((x) => x.startsWith("Another language model")),
  };
};

/** items/list 里所有 userMessage 的 clientId（asc）；没有 clientId 的记成 <null:正文开头> */
async function listClientIds(p: Probe, threadId: string): Promise<string[] | string> {
  const r = await p.request("thread/items/list", { threadId, sortDirection: "asc", limit: 200 }, 10_000);
  if (r.error) return `err:${JSON.stringify(r.error)}`;
  // 0.159.3 的 data 每项是 {turnId, item: ThreadItem, startedAtMs, completedAtMs}，不是裸 ThreadItem
  const items = ((r.result?.data ?? []) as Array<{ item: { type: string; clientId?: string | null; content?: Array<{ text?: string }> } }>).map((d) => d.item);
  return items.filter((i) => i.type === "userMessage").map((i) => i.clientId ?? `<null:${(i.content?.[0]?.text ?? "").slice(0, 20)}>`);
}

/** 按到达先后排一组请求 id 的回包 */
function arrivalOrder(p: Probe, ids: Array<[string, number]>): string[] {
  const pos = (id: number) => p.msgs.findIndex((m) => m.id === id && !m.method);
  return ids.filter(([, id]) => pos(id) >= 0).sort((a, b) => pos(a[1]) - pos(b[1])).map(([k]) => k);
}

/** Q0-9 前半：turn/start 和 steer 带 clientUserMessageId，回合前、中、后、压缩后、重启后各查一次 items/list */
const clientid_track: Scenario = async (p) => {
  await p.start((r) => (!isResponses(r) ? notFound() : requestKind(r) === "compaction" ? SUMMARY(r) : r.seq === 1 ? text("slow ".repeat(20), 20, 250) : text(`reply ${r.seq}`)));
  p.notify("initialized");
  const threadId = await p.startThread();
  const since = p.now();
  const startId = p.send("turn/start", { threadId, input: input("prompt with id"), clientUserMessageId: "cum-start" });
  const pipelinedList = p.send("thread/items/list", { threadId, sortDirection: "asc", limit: 200 });
  const listResp = await p.waitFor((m) => m.id === pipelinedList && !m.method, 10_000);
  const startResp = await p.waitFor((m) => m.id === startId && !m.method, 10_000);
  const turnId = startResp?.result?.turn?.id as string;
  let appearMs: number | null = null;
  for (let i = 0; i < 200 && appearMs === null; i++) {
    const ids = await listClientIds(p, threadId);
    if (Array.isArray(ids) && ids.includes("cum-start")) appearMs = p.now() - (startResp?.t ?? since);
    else await sleep(5);
  }
  // 连发 8 条 steer，第 4 条后面插一个 items/list：看回包顺序是否等于发送顺序（正文不带 clientId，免得误判「发给了 provider」）
  const steer = (cid: string): [string, number] => [cid, p.send("turn/steer", { threadId, expectedTurnId: turnId, input: input(`steer ${cid.slice(-1)}`), clientUserMessageId: cid })];
  const steers = ["a", "b", "c", "d"].map((k) => steer(`cum-steer-${k}`));
  const listAfterSteers = p.send("thread/items/list", { threadId, sortDirection: "asc", limit: 200 });
  steers.push(...["e", "f", "g", "h"].map((k) => steer(`cum-steer-${k}`)));
  await until(() => steers.every(([, id]) => p.responseOf(id)));
  await p.waitFor((m) => m.id === listAfterSteers && !m.method, 10_000);
  await sleep(300);
  const midTurn = await listClientIds(p, threadId);
  await p.waitFor((m) => m.method === "turn/completed" && turnIdOf(m) === turnId, 30_000, since);
  await sleep(300);
  const afterTurn = await listClientIds(p, threadId);
  const notifIds = p.msgs.filter((m) => m.method === "item/started" && m.params?.item?.type === "userMessage").map((m) => m.params.item.clientId ?? null);
  const compact = await p.request("thread/compact/start", { threadId });
  await p.waitFor((m) => m.method === "turn/completed", 20_000, compact.t);
  await sleep(500);
  const afterCompact = await listClientIds(p, threadId);
  await p.restart();
  const resume = await p.request("thread/resume", { threadId, cwd: p.work, excludeTurns: true }, 100_000);
  const afterRestart = await listClientIds(p, threadId);
  return {
    pipelined: { order: arrivalOrder(p, [["turn/start", startId], ["items/list", pipelinedList]]), listSawStart: JSON.stringify(listResp?.result ?? {}).includes("cum-start") },
    userMessageVisibleAfterStartRespMs: appearMs,
    steerRespOrder: arrivalOrder(p, [...steers, ["items/list", listAfterSteers]]),
    steerResps: steers.map(([cid, id]) => [cid, p.responseOf(id)?.result ?? p.responseOf(id)?.error]),
    listRightAfterSteers: JSON.stringify(p.responseOf(listAfterSteers)?.result ?? {}).match(/cum-[a-z-]+/g) ?? [],
    midTurn,
    afterTurn,
    clientIdInItemStartedNotifications: notifIds,
    clientIdSentToProvider: p.fake.requests.some((r) => JSON.stringify(r.body).includes("cum-")),
    clientIdInRollout: rolloutText(p.codexHome).includes("cum-start"),
    afterCompact,
    resumeOk: !resume.error,
    afterRestart,
  };
};

/** 某段文字作为 user 消息发给模型的次数（每个 /responses 请求各计一个数） */
function timesSentToModel(p: Probe, needle: string): number[] {
  return p.fake.requests.filter(isResponses).map((r) => inputTexts(r.body).filter((x) => x === needle).length);
}

/** Q0-9 后半：同一个 clientUserMessageId 重发（模拟宿主没收到确认后重试），app-server 会不会去重；失败的回合 items 里还在不在 */
const clientid_dup: Scenario = async (p) => {
  await p.start((r) => {
    if (!isResponses(r)) return notFound();
    const last = inputTexts(r.body).at(-1);
    if (last === "slow turn") return text("slow ".repeat(12), 12, 250);
    if (last === "failing turn") return { type: "fail", message: "boom", status: 500 };
    return text(`reply ${r.seq}`);
  });
  p.notify("initialized");
  const threadId = await p.startThread();
  const first = await runTurn(p, threadId, "dup prompt", { clientUserMessageId: "cum-dup" });
  await sleep(300);
  const second = await runTurn(p, threadId, "dup prompt", { clientUserMessageId: "cum-dup" });
  await sleep(300);
  const slow = p.now();
  p.send("turn/start", { threadId, input: input("slow turn"), clientUserMessageId: "cum-slow" });
  const turnId = turnIdOf(await p.waitFor((m) => m.method === "turn/started", 10_000, slow));
  const s1 = await p.request("turn/steer", { threadId, expectedTurnId: turnId, input: input("dup steer"), clientUserMessageId: "cum-dup-steer" });
  const s2 = await p.request("turn/steer", { threadId, expectedTurnId: turnId, input: input("dup steer"), clientUserMessageId: "cum-dup-steer" });
  await p.waitFor((m) => m.method === "turn/completed" && turnIdOf(m) === turnId, 30_000, slow);
  await sleep(300);
  const failing = await runTurn(p, threadId, "failing turn", { clientUserMessageId: "cum-fail" });
  const readAtFailed = await p.request("thread/read", { threadId, includeTurns: false });
  await sleep(300);
  const readAfterFailed = await p.request("thread/read", { threadId, includeTurns: false });
  return {
    dupStart: {
      turns: [first.turnId, second.turnId],
      secondResp: p.responseOf(second.id)?.result ?? p.responseOf(second.id)?.error,
      statuses: [first.done?.params?.turn?.status, second.done?.params?.turn?.status],
    },
    dupStartSentToModel: timesSentToModel(p, "dup prompt"),
    dupSteerResps: [s1.result ?? s1.error, s2.result ?? s2.error],
    dupSteerSentToModel: timesSentToModel(p, "dup steer"),
    failingTurn: {
      reads: [readAtFailed.result?.thread?.status, readAfterFailed.result?.thread?.status],
      statusEvents: p.msgs.filter((m) => m.method === "thread/status/changed" && m.t >= failing.since).map((m) => m.params.status.type),
      status: failing.done?.params?.turn?.status,
      error: failing.done?.params?.turn?.error,
      errorEvents: p.msgs.filter((m) => m.method === "error" && m.t >= failing.since).map((m) => m.params),
    },
    items: await listClientIds(p, threadId),
  };
};

export const SCENARIOS: Record<string, Scenario> = {
  order_initialized,
  order_no_initialized,
  steer_latency,
  steer_interrupt_stream,
  steer_interrupt_tool,
  stale_interrupt,
  idle_interrupt_previous,
  idle_interrupt_bogus,
  idle_interrupt_after_interrupted,
  compact_manual,
  compact_fail,
  compact_interrupt,
  compact_auto,
  eof_idle,
  eof_idle_stubborn,
  eof_idle_ignore_term,
  eof_busy_model,
  eof_busy_command,
  sigkill_group_command,
  sigterm_group_command,
  sigterm_busy,
  approval_ww_escalated,
  approval_ro_escalated,
  approval_ro_plain_write,
  approval_ww_untrusted,
  approval_ww_escalated_noexp,
  approval_ww_cancel_held,
  clientid_track,
  clientid_dup,
};
