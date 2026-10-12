import type { DigestMode } from "./pm-digest.js";

export type PmRouteClass = "auto" | "digest" | "judge" | "owner";
export interface PmRouteTag {
  route: PmRouteClass;
  rule: string;
  reason: string;
  /** 原巡检条目的序号和类型；不留正文、建议或卡号。 */
  item?: number;
  type?: string;
}
export interface PmRouteRecord {
  messageId: string;
  mode: DigestMode;
  tags: PmRouteTag[];
}
export interface PmRoutePlan {
  tags: PmRouteTag[];
  /** on 才使用的剩余正文；空字符串表示全部 auto。 */
  body?: string;
  /** 保护项立即送；普通 judge 保持原 PMDIG 选择。 */
  immediate?: boolean;
  digest?: boolean;
}
