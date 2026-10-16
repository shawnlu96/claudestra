/**
 * inbound-route status|off|observe|on：入站路由开关（config.json inboundRoute.mode，缺省 off）。
 * 只改配置，bridge 最多 2 秒后跟上（bridge/inbound-route.ts routeMode），不用重启；判定日志在状态目录的 inbound-route.jsonl。
 */
import { output } from "./core.js";

const MODES = ["off", "observe", "on"] as const;
const SAY: Record<(typeof MODES)[number], string> = {
  off: "入站路由：关（缺省）。目标忙时照旧——人类消息打断，agent 消息押到回合结束",
  observe: "入站路由：只观察。投递照旧，每条忙时消息记一行「Jev 会怎么判 / 实际怎么做」到 inbound-route.jsonl",
  on: "入站路由：开。目标忙时由 Jev 判打断 / 排队 / 合并（只有 owner 能打断；Jev 不可用或拿不准按原规则）",
};

export async function cmdInboundRoute(args: string[]): Promise<void> {
  const { readConfig, setInboundRouteMode } = await import("../lib/config-store.js");
  const { parseRouteMode } = await import("../lib/inbound-route.js");
  const sub = (args[0] ?? "status").toLowerCase();
  if (!(MODES as readonly string[]).includes(sub) && sub !== "status" && sub !== "get") {
    output({ ok: false, error: "usage: inbound-route status|off|observe|on" });
    return;
  }
  const cfg = sub === "status" || sub === "get" ? await readConfig() : await setInboundRouteMode(sub as (typeof MODES)[number]);
  const mode = parseRouteMode(cfg.inboundRoute?.mode);
  output({ ok: true, mode, message: SAY[mode] });
}
