/**
 * `rename.ledgerReceive` / `rename.ledgerSend`（rename-floka-LEDGER1）：共享台账与回执票据四个用途
 * （shared-ledger、invite-pop、lend-receipt、lend-review-ticket）的接收、发送两档，两端各读各的。
 *   接收 off     只认旧族，与没有兼容层时逐项相同；
 *   接收 observe 接受范围不变（新族照旧拒），只把「开到 on 会不会认」报给调用方；
 *   接收 on      两族都认，一份签名只属于一族、一个用途；
 *   发送 on      只在对端有效能力证明在手时发新族，否则发旧族；observe 照旧发旧族，只报告 on 会发哪一族。
 * 缺省两档 off；读不懂的值按 off；发送 on 而接收不是 on 时发送按 observe（发了新族却不认回来的新族）。
 */
import type { RenameSignatureMode } from "../floka-compat/signature/families.js";

/** 与中继档位同值；不从 relay/gear.ts 引，免得协议核心（shared-ledger-auth.ts）的 import 闭包带进本机状态 */
export type LedgerGear = RenameSignatureMode;
export interface LedgerRename { receive: LedgerGear; send: LedgerGear }

const GEARS: readonly unknown[] = ["off", "observe", "on"];

/** 入参是配置里的 `rename` 这一节 */
export function parseLedgerRename(raw: unknown): { rename: LedgerRename; problems: string[] } {
  const problems: string[] = [];
  const o = raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  if (raw !== undefined && raw !== null && o !== raw) problems.push("rename: 要是对象，按 off 处理");
  const gear = (key: "ledgerReceive" | "ledgerSend"): LedgerGear => {
    const v = o[key];
    if (v === undefined || v === null) return "off";
    if (GEARS.includes(v)) return v as LedgerGear;
    problems.push(`rename.${key}: ${JSON.stringify(v)} 不是 off / observe / on，按 off 处理`);
    return "off";
  };
  const receive = gear("ledgerReceive");
  let send = gear("ledgerSend");
  if (send === "on" && receive !== "on") {
    problems.push("rename.ledgerSend: on 需要 ledgerReceive 也是 on，按 observe 处理");
    send = "observe";
  }
  return { rename: { receive, send }, problems };
}
