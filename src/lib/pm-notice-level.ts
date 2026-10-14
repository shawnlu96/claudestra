/**
 * 推给 PM 的系统通知由发送方在代码里标级别（docs/architecture/pm-digest.md「通知级别」）：action = 要 PM 当场动手，立即叫醒；
 * info = 常规，只进摘要、不单独叫醒。分流只认这个结构化字段，不看正文文字，换语言、改文案都不影响。没标的按旧规则走（宁可多叫醒）。
 */
import { AsyncLocalStorage } from "node:async_hooks";

export type PmNoticeLevel = "action" | "info";
/** 调用链深的发送点（deps.notifyPm(task, text)）不改签名：外面包一层 asInfo，notifyProjectPm 从这里取出带上 */
export const pmNoticeLevel = new AsyncLocalStorage<PmNoticeLevel>();
export const asInfo = <T>(f: () => T): T => pmNoticeLevel.run("info", f);
