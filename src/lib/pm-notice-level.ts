/**
 * 推给 PM 的系统通知由发送方在代码里标级别（docs/architecture/pm-digest.md「通知级别」）：action = 要 PM 当场动手，立即叫醒；
 * info = 常规，只记卡片、不送 PM（PM 用 `ledger pm-todo` 按需拉）。分流只认这个结构化字段，不看正文文字，换语言、改文案都不影响。
 * 本项目的通知入口（notifyProjectPm / sendLedgerNotice / sendToPm / notifyTaskPm / 各模块的 notifyPm 端口）级别参数都必填，不标编译不过（agents-NOTICETYPE1）。
 */
import { AsyncLocalStorage } from "node:async_hooks";

export type PmNoticeLevel = "action" | "info";
/** 兼容旧写法：外面包一层 asInfo，notifyProjectPm 在调用方没给级别时（没过类型检查的 JS）从这里取出带上；入口签名本身的级别仍必填 */
export const pmNoticeLevel = new AsyncLocalStorage<PmNoticeLevel>();
export const asInfo = <T>(f: () => T): T => pmNoticeLevel.run("info", f);

const isLevel = (v: unknown): v is PmNoticeLevel => v === "action" || v === "info";
/**
 * route_to_agent 帧带的级别放不放进信封 meta.pmLevel（bridge.ts 一行调它）：没注册频道的系统进程（调度器）照旧放行；本机 agent
 * 的帧只在 oneShot 时放行（send_to_agent 的 level，agents-NOTICETYPE1）；非法值一律丢。只影响 PM 侧立即送 / 摘要的分流，不碰身份和信任。
 */
export function frameLevel(msg: { pmLevel?: unknown; oneShot?: unknown }, fromAgent: boolean): PmNoticeLevel | undefined {
  if (!isLevel(msg.pmLevel)) return undefined;
  return !fromAgent || msg.oneShot === true ? msg.pmLevel : undefined;
}
