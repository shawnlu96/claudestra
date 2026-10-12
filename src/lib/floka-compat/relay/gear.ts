/**
 * `rename.relay` 的档位与分档执行。接收与发送各一档，互不牵连：
 *   off     只认 / 只发旧族，结果与没有兼容层时逐项相同；
 *   observe 结果仍与 off 相同，另外报告「开到 on 会判成哪一族 / 会不会拒」；
 *   on      接收两族都认（一条消息里只许一族），发送在对端能力已认证时才用新族。
 * 配置读不懂一律退回 off：写错一个字不能让实例开始认新族的来源头。
 */
import type { RelayFamilyId } from "./families.js";

export const RELAY_RENAME_KEY = "rename.relay";

const GEARS = ["off", "observe", "on"] as const;
export type RelayGear = (typeof GEARS)[number];
export interface RelayRename { receive: RelayGear; send: RelayGear }

type RelayReject =
  | "subprotocol_required" | "family_conflict" | "family_mismatch" | "family_not_enabled" | "forged_marker" | "illegal_combination"
  | "auth_failed" | "auth_family_mismatch" | "unauthenticated_capability" | "capability_invalid";

/** observe 档的报告：on 档会定成哪一族（null = 没有带品牌的东西），或者会以什么理由拒 */
interface RelayObservation { candidate: RelayFamilyId | null; wouldReject: RelayReject | null }
export interface RelayFail { ok: false; reason: RelayReject }
export type Staged<T> = (({ ok: true } & T) | RelayFail) & { observed?: RelayObservation };

const isGear = (v: unknown): v is RelayGear => (GEARS as readonly unknown[]).includes(v);

/**
 * 配置值 → 两个档位。只写一个字符串 = 只动接收档，发送档要单独写：发送切新是另一次批准。
 * 发送 on 而接收不是 on 是非法组合（发了新族却不认对方回的新族），发送降到 observe 并报问题。
 */
export function parseRelayRename(raw: unknown): { rename: RelayRename; problems: string[] } {
  const problems: string[] = [];
  const gear = (v: unknown, field: string): RelayGear => {
    if (v === undefined || v === null) return "off";
    if (isGear(v)) return v;
    problems.push(`${RELAY_RENAME_KEY}.${field}: ${JSON.stringify(v)} 不是 off / observe / on，按 off 处理`);
    return "off";
  };
  let rename: RelayRename = { receive: "off", send: "off" };
  if (typeof raw === "string") rename = { receive: gear(raw, "receive"), send: "off" };
  else if (raw && typeof raw === "object" && !Array.isArray(raw)) {
    const o = raw as Record<string, unknown>;
    rename = { receive: gear(o.receive, "receive"), send: gear(o.send, "send") };
  } else if (raw !== undefined && raw !== null) problems.push(`${RELAY_RENAME_KEY}: 要是档位字符串或 { receive, send }，按 off 处理`);
  if (rename.send === "on" && rename.receive !== "on") {
    problems.push(`${RELAY_RENAME_KEY}: 发送 on 需要接收也是 on，发送按 observe 处理`);
    rename = { ...rename, send: "observe" };
  }
  return { rename, problems };
}

/**
 * 分档执行：off 只跑旧逻辑；observe 跑旧逻辑并把新逻辑的结论挂在 observed 上；on 只跑新逻辑。
 * 两个回调都必须是纯的——observe 档两个都会跑，谁改了入参另一个看到的就不是原请求。
 */
export function staged<T extends { family: RelayFamilyId | null }>(
  gear: RelayGear, off: () => ({ ok: true } & T) | RelayFail, on: () => ({ ok: true } & T) | RelayFail,
): Staged<T> {
  if (gear === "on") return on();
  const base = off();
  if (gear === "off") return base;
  const shadow = on();
  return { ...base, observed: shadow.ok ? { candidate: shadow.family, wouldReject: null } : { candidate: null, wouldReject: shadow.reason } };
}
