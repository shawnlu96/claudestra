/**
 * 出借 offer 的纯协议入口（cloud-PP2）：A 推给 B 的 offer 正文的构造与严格解析。只依赖 lend-wire-types / lend-wire-v2-schema，
 * 不经本机路径、配置、台账、git、order-wire；中心可直接用 parseOfferRequest。原 lend-wire-v2 的 parseV2Request("offer") /
 * offerBody 委托这里，结果逐字一致。权限、订单绑定由调用方原层负责。tests/cloud-protocol-lend-offer.test.ts。
 */
import { LEND_FAMILIES, LEND_STEPS, type OfferSummary } from "./lend-wire-types.js";
import {
  arrayOf, BODY_V, fields, guard, LEND_PROTO, MAX_TS, no, OFFER_MAX, ORDER_ID, pattern, pick, REPO, SHA40, TASK_ID, version, whole, type Parsed,
} from "./lend-wire-v2-schema.js";

export interface OfferRequest { v: 1; proto: number; orders: OfferSummary[] }

function summaryOf(v: unknown, path: string): OfferSummary {
  const s = fields(v, path, ["orderId", "taskId", "step", "family", "repo", "pr", "head", "round", "specRev", "offeredAt"]);
  return { orderId: pattern(s.orderId, `${path}.orderId`, ORDER_ID), taskId: pattern(s.taskId, `${path}.taskId`, TASK_ID),
    step: pick(s.step, `${path}.step`, LEND_STEPS), family: pick(s.family, `${path}.family`, LEND_FAMILIES),
    repo: pattern(s.repo, `${path}.repo`, REPO), pr: s.pr === null ? null : whole(s.pr, `${path}.pr`, 1, 1e9), head: pattern(s.head, `${path}.head`, SHA40),
    round: whole(s.round, `${path}.round`, 0, 1e6), specRev: whole(s.specRev, `${path}.specRev`, 0, 1e6), offeredAt: whole(s.offeredAt, `${path}.offeredAt`, 0, MAX_TS) };
}

/** 抛 V2Error 的解析核心；lend-wire-v2 的 REQUESTS.offer 就是它 */
export function parseOffer(raw: unknown): OfferRequest {
  const r = fields(raw, "$", ["v", "proto", "orders"]);
  const orders = arrayOf(r.orders, "orders", OFFER_MAX, summaryOf);
  if (!orders.length) no("orders", "不能是空的");
  if (new Set(orders.map((o) => o.orderId)).size !== orders.length) no("orders", "同一单出现两次");
  return { v: version(r), proto: whole(r.proto, "proto", 2, 99), orders };
}

/** 与 parseV2Request("offer", body) 同一 {ok, value / error} 语义 */
export const parseOfferRequest = (body: unknown): Parsed<OfferRequest> => guard(() => parseOffer(body));

export const offerBody = (orders: OfferSummary[]): OfferRequest => ({ v: BODY_V, proto: LEND_PROTO, orders: orders.slice(0, OFFER_MAX) });
