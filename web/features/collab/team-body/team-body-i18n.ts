/**
 * 团队正文区块（TEAMVIS7）的英文：只在协作视图详情里用，叠在 useCollabT 之上（本表没有的词照旧走协作视图词表 / 全局字典）。
 * 放在这里而不是 collab-i18n.ts：这几句只有团队正文用，和协作视图的短词表分开维护。
 */
import { fillParams } from "@/lib/i18n-fill";
import type { Lang } from "@/lib/i18n";
import type { Tr } from "../collab-model";

const EN: Record<string, string> = {
  "同步时间 {t}": "Synced {t}",
  "规格全文": "Full spec",
  "审查全文": "Full review",
  "本机": "This machine",
  "其他成员的机器": "Another member's machine",
  "中心暂未同步该角色身份": "Not synced by the center yet",
  "正文同步中": "Syncing text",
  "你不在该项目成员里": "You are not a member of this project",
  "中心暂未开放": "Not available on the center yet",
  "正文暂时读不到": "Text temporarily unavailable",
  "参与者同步中": "Syncing participants",
  "中心暂未同步阶段明细": "Stage details not synced by the center yet",
  "对它说只在主场机器上可用": "Talking to it only works on the home machine",
};

export function teamBodyTr(tr: Tr, lang: Lang): Tr {
  return (s, p) => (lang !== "zh" && Object.hasOwn(EN, s) ? fillParams(EN[s]!, p) : tr(s, p));
}
