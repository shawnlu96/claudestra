/**
 * `rename.centerReceive` / `rename.centerSend`：实例与中继中心之间这一段的两个档位，两端各读各的。
 *   接收 off     只认旧族，与没有兼容层时逐项相同；
 *   接收 observe 接受范围不变，只报告「开到 on 会认成哪一族」；
 *   接收 on      两族都认（一条连接只属于一族）；
 *   发送 on      中心：在 welcome 里发能力；客户端：手里有中心的有效能力时才提议新族。observe 只报告。
 * 缺省两档都是 off；读不懂的值按 off；发送 on 而接收不是 on 时发送按 observe（发了新族却不认回来的新族）。
 */
import type { RelayGear } from "../floka-compat/relay/gear.js";

export interface CenterRename { receive: RelayGear; send: RelayGear }
/** 配置里 `rename` 这一节与本卡相关的两项 */
export interface CenterRenameConfig { centerReceive?: unknown; centerSend?: unknown }

const GEARS: readonly unknown[] = ["off", "observe", "on"];

export function parseCenterRename(raw: unknown): { rename: CenterRename; problems: string[] } {
  const problems: string[] = [];
  const o = raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as CenterRenameConfig) : {};
  if (raw !== undefined && raw !== null && o !== raw) problems.push("rename: 要是对象，按 off 处理");
  const gear = (v: unknown, key: string): RelayGear => {
    if (v === undefined || v === null) return "off";
    if (GEARS.includes(v)) return v as RelayGear;
    problems.push(`rename.${key}: ${JSON.stringify(v)} 不是 off / observe / on，按 off 处理`);
    return "off";
  };
  const receive = gear(o.centerReceive, "centerReceive");
  let send = gear(o.centerSend, "centerSend");
  if (send === "on" && receive !== "on") {
    problems.push("rename.centerSend: on 需要 centerReceive 也是 on，按 observe 处理");
    send = "observe";
  }
  return { rename: { receive, send }, problems };
}
