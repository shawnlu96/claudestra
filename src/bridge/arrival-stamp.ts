/**
 * 请求一进 bridge 就领到达号，挂在请求对象上往下传。领号点（第一个 await 之前）：HTTP 在 bridge.ts 的 fetch 第一行、
 * 中继路径模式在 bridge.ts 注入的 handleApi 第一行；Discord 在 messageCreate / interactionCreate 回调里、鉴权之后第一个 await 之前。
 * 之后鉴权、读正文、下载附件、查 registry 都有 await：谁先处理完谁领号的话，先到的「继续」会排到后到的「停」后面（tests/arrival-stamp.test.ts）。
 * 同一个请求只认第一次领的号；没领过的（单测、peer 解密后的内层请求）到用时现领。
 */
import type { Order } from "../lib/arrival-order.js";
import { turnCuts } from "./turn-cuts.js";

const stamps = new WeakMap<object, number>();

/** 给这个请求领号（领过就返回原来那个） */
export function stampArrival(req: object): number {
  let seq = stamps.get(req);
  if (seq === undefined) stamps.set(req, (seq = turnCuts.arrivals.take()));
  return seq;
}

/** 这个请求到达时的位置 */
export const arrivalOf = (req: object): Order => ({ seq: stampArrival(req) });
