/**
 * `manager restart --expect <json>` 的线格式（i28-S1c）：监护拉起 manager 时把「为什么要重启」带过去，子进程拿到该 agent 的重启锁之后按
 * 同一套条件再核一次（manager/restart-expect.ts），消掉「调度服务最后一次核过 → 子进程拿到锁」之间约 1 秒的窗口。
 * 字段只拿来比对，不拼进路径或命令；多一个字段、类型不对、agent 不是重启目标都整条拒（拒 = 不重启）。tests/restart-expect.test.ts。
 */
import type { Down } from "./agent-supervisor-judge.js";

export interface RestartExpectWire {
  v: 1;
  /** 必须等于 restart 的目标名：拿别人的 expect 去动另一个 agent 一律拒 */
  agent: string;
  /** 监护时 registry 里的会话 */
  sessionId: string;
  /** 监护确认的否定：子进程再探一次必须还是它 */
  down: Down;
  /** 在途那件活的键（agent-supervisor-policy.ts workKeyOf）：活交了、退回人工、换了单都会变 */
  workKey: string;
}

const KEYS = ["agent", "down", "sessionId", "v", "workKey"];
const DOWNS: readonly Down[] = ["no_window", "no_host", "stuck"];
/** 整条 JSON 的上限：正常一条不到 300 字节 */
const EXPECT_MAX_BYTES = 2048;

/** 非空、不长、没有控制 / 格式字符 */
const plain = (x: unknown, max: number): x is string => typeof x === "string" && x.length > 0 && x.length <= max && !/[\p{Cc}\p{Cf}]/u.test(x);

export const encodeExpect = (w: Omit<RestartExpectWire, "v">): string =>
  JSON.stringify({ v: 1, agent: w.agent, sessionId: w.sessionId, down: w.down, workKey: w.workKey });

/** 解析并核对；target = manager 这一轮要重启的那个名字 */
export function parseExpect(raw: string, target: string): { ok: true; expect: RestartExpectWire } | { ok: false; reason: string } {
  if (Buffer.byteLength(raw, "utf8") > EXPECT_MAX_BYTES) return { ok: false, reason: "--expect 太长" };
  let d: unknown;
  try { d = JSON.parse(raw); } catch { return { ok: false, reason: "--expect 不是 JSON" }; /* 拒掉就是不重启，原因已经写在返回值里 */ }
  if (!d || typeof d !== "object" || Array.isArray(d)) return { ok: false, reason: "--expect 不是对象" };
  const r = d as Record<string, unknown>;
  if (Object.keys(r).sort().join(",") !== KEYS.join(",")) return { ok: false, reason: `--expect 字段必须正好是 ${KEYS.join(" / ")}` };
  if (r.v !== 1) return { ok: false, reason: "--expect 版本不认识" };
  if (!plain(r.agent, 120) || !plain(r.sessionId, 200) || !plain(r.workKey, 400)) return { ok: false, reason: "--expect 的 agent / sessionId / workKey 不合法" };
  if (!DOWNS.includes(r.down as Down)) return { ok: false, reason: "--expect 的 down 不认识" };
  if (r.agent !== target) return { ok: false, reason: `--expect 是给 ${r.agent} 的，不能用来重启 ${target}` };
  return { ok: true, expect: r as unknown as RestartExpectWire };
}
