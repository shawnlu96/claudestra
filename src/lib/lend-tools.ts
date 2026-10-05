/**
 * 出借 worker 的派单工具（i28-W4，B 侧纯逻辑；IO 由 bridge/lend-tools.ts 注入）。bridge/order-tools.ts 看到 agent-lend-* 身份就整条进这里，
 * 本机的 HANDLERS（台账派单 / 审查 / DAG / PM 工具）一个都摸不到。固定流程：
 * 1. T85 已验证、没被代理降级（requireVerified）；工具在 lend 档白名单里；
 * 2. 一单一绑定：按身份里的 agent 名查 journal 里活着的单（agent = 该名），恰好一行；会话也得是这一行记的会话；
 * 3. 参数带了 orderId 而且对不上 → 拒；单子没起 worker / 已结束 → 拒；
 * 4. 工具对步骤：审查单只有 take_review / submit_verdict，开工 / 修复单只有 take_order / deliver（一律明确拒：写单的派单全文已在会话里、交付走 lend submit），ask 都可以。
 * 原生频道帧（reply / project_info / route_to_agent …）不走 order-tools：bridge.ts 入口先过 lendFrameGate。
 * 转发给 A 的 peer / orderId / gen 只取自这一行（结论正文由 lend-submit.ts 按这一行拼），请求参数里的一概不用；出站只走 E2E（注入的 call）。
 * tests/lend-tools.test.ts（含拿代理 token 直连的反例）。
 */
import type { Database } from "bun:sqlite";
import { readJsonCapped } from "./body-reader.js";
import { IDENTITY_UNVERIFIED, requireVerified, type CallerIdentity } from "./caller-identity.js";
import { roleOfStep } from "./lend-git.js";
import { notV2, peerProto } from "./lend-hello.js";
import { getOrder, liveOrders, orderOf, WORKER_STATES, type LendRow } from "./lend-journal.js";
import { LEND_ORDER_TOOLS } from "./lend-mcp-profile.js";
import { signedFor } from "./instance-key.js";
import { lendRequest, peerLendProblem, proxyVarsIn, type LendCall } from "./lend-remote.js";
import { commitLendResult, payloadSha, readReportIn } from "./lend-submit.js";
import { refuse, type OrderToolResult } from "./order-tool-route.js";
import { askScopeExtra, parseAskWire, parseVerdictWire } from "./order-wire.js";
import { isE2eResponse } from "./peer-e2e-client.js";
import type { HttpPeer } from "./peers.js";
import { isLendWorkerName } from "./runtimes/clean-env.js";

export interface LendToolDeps {
  /** 本机出借 journal；这台机器没在出借 = null */
  db: Database | null;
  /** 对 A 的出站（result / ask）：只走 E2E，peer 不合格或应答不是 E2E 就抛错（= 不知道到没到） */
  call: LendCall<"result" | "ask">;
  log(msg: string): void;
  now(): number;
}

export interface LendCallPorts {
  peers(): Promise<HttpPeer[]>;
  /** 只走 E2E 的 POST（bridge：relay-link peerFetch 的 e2eOnly，此刻不是 E2E peer 就抛错不发） */
  post(url: string, init: { method: "POST"; headers: Record<string, string>; body: string; signal: AbortSignal }): Promise<Response>;
  env: Record<string, string | undefined>;
  timeoutMs: number;
}

/** 对 A 的出站，三道都过才发、才认：没有代理变量；peer 记录钉钥 + 有 E2E（peerLendProblem）；应答是 E2E 回来的。不满足就抛错 = 没到 */
export function e2eLendCall(p: LendCallPorts): LendCall<"result" | "ask"> {
  return async (name, op, body) => {
    const proxies = proxyVarsIn(p.env);
    if (proxies.length) throw new Error(`环境里有代理变量 ${proxies.join(", ")}，不发出借请求`);
    const peer = (await p.peers()).find((x) => x.name === name);
    const problem = peerLendProblem(peer, name);
    if (problem || !peer?.baseUrl || !peer.outToken) throw new Error(problem ?? `peer ${name} 握手不完整`);
    const url = `${peer.baseUrl.replace(/\/+$/, "")}/api/v1/lend/${op}`;
    const raw = JSON.stringify(body);
    const headers = { Authorization: `Bearer ${peer.outToken}`, "Content-Type": "application/json", ...signedFor("POST", url, raw) };
    const res = await p.post(url, { method: "POST", headers, body: raw, signal: AbortSignal.timeout(p.timeoutMs) });
    if (!isE2eResponse(res)) throw new Error("对方的应答不是端到端加密回来的，不认");
    return { status: res.status, body: await readJsonCapped(res) };
  };
}

/** bridge/order-tools.ts 的分流条件：出借 worker 的身份（不看是否已验证——没验证的也进这里被拒，不落回本机 HANDLERS） */
export const isLendCaller = (identity: Pick<CallerIdentity, "agent">): boolean => isLendWorkerName(identity.agent ?? undefined);

/**
 * 出借身份的连接在 bridge 原生帧入口只放这些：ping / whoami / order_tool（之后照旧过 routeLendTool 白名单），加宿主自己的帧——
 * 宿主那条连接就注册在 agent-lend-* 的频道上，register / response / acp_* / codex_* / abort_ack 拦了 worker 就跑不起来。
 * 白名单而不是黑名单：频道类、ask_codex、建删频道、peer_pr_push 以及以后新加的帧缺省都拒。
 */
const LEND_FRAMES = new Set(["ping", "whoami", "order_tool", "register", "response", "abort_ack", "codex_undelivered", "codex_typein_failed",
  "acp_entries", "acp_config", "acp_failure", "acp_permission", "acp_call_result", "acp_rebind"]);

/**
 * bridge.ts handleClientMessage 进 switch 之前调（bridge/lend-tools.ts lendFrameDenied）：连接认出是出借 worker（注册在 agent-lend-* 的频道上，
 * 不论凭据是否有效），reply / project_info / route_to_agent / fleet_* 等频道与管理类原生帧回 error「lend_forbidden:<type>」后丢弃。
 * 放行的类型不查身份（ping、acp_* 是热路径）；新加的帧类型缺省就拒。没注册的匿名本机连接认不出身份，不归这里——同一 OS 用户的限制，W8 收。
 */
export function lendFrameGate(msg: Record<string, unknown>, identityOf: () => Pick<CallerIdentity, "agent">, reply: (frame: object) => void, log: (m: string) => void): boolean {
  if (LEND_FRAMES.has(String(msg.type)) || !isLendCaller(identityOf())) return false;
  const type = String(msg.type).slice(0, 40);
  log(`出借 worker 发了原生帧 ${type}，拒绝（只开派单工具与 whoami）`);
  reply({ type: "response", requestId: msg.requestId, error: `lend_forbidden:${type}` });
  return true;
}

const REVIEW_TOOLS = ["take_review", "submit_verdict", "ask"];
const WRITE_TOOLS = ["take_order", "deliver", "ask"];
const WRITE_CLOSED = "写代码的单不用 take_order / deliver：派单全文已在会话里，提交后按派单末尾的 lend submit 命令交付";

type Bound = { ok: true; row: LendRow; write: boolean } | { ok: false; result: OrderToolResult };

/** 一单一绑定：身份 → journal 里唯一一行活着的单；参数里的 orderId 只用来核对，不用来找单 */
function boundOrder(db: Database | null, identity: CallerIdentity, tool: string, args: unknown): Bound {
  const no = (code: string, error: string): Bound => ({ ok: false, result: refuse(code, error) });
  if (!requireVerified(identity).ok || !identity.agent) return no(IDENTITY_UNVERIFIED, "调用方身份未验证（不是 Claudestra 用新凭据启动的会话，或经代理降级），出借 worker 的派单工具一律拒绝");
  if (!isLendWorkerName(identity.agent)) return no("lend_forbidden", "不是出借 worker");
  if (!LEND_ORDER_TOOLS.includes(tool)) return no("lend_forbidden", `出借 worker 只能用 ${LEND_ORDER_TOOLS.join(" / ")}，不提供 ${tool.slice(0, 40)}`);
  if (args !== undefined && args !== null && (typeof args !== "object" || Array.isArray(args))) return no("invalid_args", "参数要是对象");
  const rows = db ? liveOrders(db).filter((r) => r.agent === identity.agent) : [];
  if (rows.length === 0) return no("no_order", `${identity.agent} 在本机出借 journal 里没有活着的单`);
  if (rows.length > 1) return no("binding_conflict", `${identity.agent} 对上了 ${rows.length} 张单（一个 worker 只该有一张），一律不收`);
  const row = rows[0];
  if (!row.sessionId || row.sessionId !== identity.sessionId) return no("session_mismatch", `${identity.agent} 的当前会话不是这张单记的会话，不收`);
  const given = (args as { orderId?: unknown } | null | undefined)?.orderId;
  if (given !== undefined && given !== row.orderId) return no("order_mismatch", `参数里的 orderId 不是你这张单（${row.orderId}）`);
  if (!WORKER_STATES.includes(row.state)) return no("not_started", `${row.orderId} 当前是 ${row.state}，不收派单工具调用`);
  const role = roleOfStep(String(orderOf(row)?.step ?? ""));
  if (!role) return no("invalid_order", `${row.orderId} 的步骤认不出，不收`);
  const write = role === "write";
  if (!(write ? WRITE_TOOLS : REVIEW_TOOLS).includes(tool)) return no("wrong_step", `${row.orderId} 是${write ? "开工 / 修复单" : "审查单"}，不能用 ${tool}`);
  if (write && tool !== "ask") return no("write_closed", WRITE_CLOSED);
  return { ok: true, row, write };
}

/** take_review：claim 时拿到、sha256 已核的订单原文（不向 A 再要）；brief 是 A 渲染的派单全文 */
function takeReview(row: LendRow): OrderToolResult {
  if (!row.wire) return refuse("invalid_order", `${row.orderId} 的 journal 里没有订单原文`);
  return { ok: true, orders: [row.wire.order], errors: [], brief: row.wire.text };
}

type Forward = { forwarded: true; receipt: { eventSeq: number; sha256: string } } | { forwarded: false; why: string };

/** 把这一行记下的结论原字节转给 A（同 lend-drive forwardResult 的请求体）；不改 journal：回执的验签、收尾由调度服务重发时做 */
async function forwardResult(row: LendRow, d: LendToolDeps): Promise<Forward> {
  if (!row.payload || payloadSha(JSON.stringify(row.payload)) !== row.payloadSha) return { forwarded: false, why: "journal 里的结论和记下的 sha256 对不上，交给调度服务处理" };
  const { v: _v, ...body } = row.payload;
  const r = await lendRequest(d.call, row.peer, "result", body);
  if (!r.ok) return { forwarded: false, why: `${r.code}：${r.error}`.slice(0, 300) };
  if (r.value.orderId !== row.orderId || r.value.sha256 !== row.payloadSha) return { forwarded: false, why: "A 的回执和这份结论对不上，调度服务会原样重发再核" };
  return { forwarded: true, receipt: { eventSeq: r.value.eventSeq, sha256: r.value.sha256 } };
}

/** submit_verdict：严格校验 → head 对单 → 读副本里的报告 → 公共提交核心落 result_pending → 同步转给 A，回执交还 worker */
async function submitVerdict(row: LendRow, args: unknown, d: LendToolDeps): Promise<OrderToolResult> {
  const w = parseVerdictWire(args);
  if (!w.ok) return refuse("invalid_verdict", w.error);
  if (w.value.head !== orderOf(row)?.head) return refuse("head_mismatch", "head 不是这张审查单的 head");
  const report = readReportIn(row.dir ?? "", w.value.reportPath);
  if (!report.ok) return refuse("bad_report", report.error);
  const done = commitLendResult(d.db!, row, { verdict: w.value.verdict, findings: w.value.findings, report: report.text }, d.now());
  if (!done.ok) return refuse("submit_refused", done.error);
  const cur = getOrder(d.db!, row.orderId);
  const fwd = cur ? await forwardResult(cur, d) : { forwarded: false as const, why: "journal 里这一行不见了" };
  if (!fwd.forwarded) d.log(`${row.orderId} 的结论已记下，同步转给 ${row.peer} 没成（${fwd.why}），调度服务会原样重发`);
  return { ok: true, orderId: row.orderId, duplicate: done.duplicate, sha256: done.sha, ...fwd,
    message: fwd.forwarded ? "结论已交给对方并拿到回执" : "结论已记下，调度服务会原样转给对方" };
}

/** ask：A 讲 v2 才转 lend/ask（问的是这张卡的 PM）；v1 / 没协商过 / 对方没这个接口都明确回「不支持」，不静默 */
async function askPeer(row: LendRow, args: unknown, d: LendToolDeps): Promise<OrderToolResult> {
  const w = parseAskWire(args);
  if (!w.ok) return refuse("invalid_ask", w.error);
  const noAsk = refuse("peer_no_ask", "对方（发起方）的版本不支持 ask，问题没有发出去：把疑问写进报告，或按规格自行判断");
  if (peerProto(d.db!, row.peer) !== 2) return noAsk;
  if (row.leaseGen === null) return refuse("not_started", `${row.orderId} 还没有租约代数，不能提问`);
  const r = await lendRequest(d.call, row.peer, "ask", { orderId: row.orderId, gen: row.leaseGen, question: w.value.question, options: w.value.options,
    ...askScopeExtra(w.value) }); // files / reason 只在有值时发（旧版发起方不认）
  if (notV2(r)) return noAsk;
  if (r.ok) return { ok: true, askId: r.value.askId };
  const unknown = r.code === "transport" || r.code === "bad_response";
  return refuse("ask_failed", `${unknown ? "不知道对方收没收到（别马上重问）" : "对方不收这个问题"}：${r.code} ${r.error}`.slice(0, 400));
}

/** 出借 worker 的派单工具入口：绑定不过一律拒；过了按工具分派（写单的两个在绑定里已拒） */
export async function routeLendTool(tool: unknown, identity: CallerIdentity, args: unknown, d: LendToolDeps): Promise<OrderToolResult> {
  const b = boundOrder(d.db, identity, typeof tool === "string" ? tool : "", args);
  if (!b.ok) return b.result;
  if (tool === "take_review") return takeReview(b.row);
  if (tool === "submit_verdict") return submitVerdict(b.row, args, d);
  if (tool === "ask") return askPeer(b.row, args, d);
  return refuse("write_closed", WRITE_CLOSED);
}
