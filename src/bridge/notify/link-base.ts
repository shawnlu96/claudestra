/** 通知里「点开」的默认地址：配了中继就是中继首页（网页按 ?fp= 切到这台机器），没配返回 null（不带链接，除非设置里填了 openUrl） */
import { relayEntryUrl } from "../../lib/setup-remote-access.js";
import { relayInfo } from "../relay-link.js";

export function notifyLinkBase(): string | null {
  const r = relayInfo();
  return r.relayUrl ? relayEntryUrl(r, r.relayUrl) : null;
}
