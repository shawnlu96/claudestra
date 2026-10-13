/**
 * 「推送不带正文」（docs/relay/e2e-design.md §5.2 的 P1 开关）：打开后，Web Push 与 APNs 不管经中继还是直发，一律改写成通用通知。
 * 标题 Claudestra，正文「有新消息」，只留角标和时间（Web Push 的 fp 由派发器另加）；agent 名、设备名、guest 名、ask id、
 * 消息内容一样不带，tag / url / thread-id 里也不带。中继和推送服务都看得见这些字段，所以必须在出本机之前改，不能靠 SW 藏起来。
 * 点开只回 /chat，由页面自己拉未读。开关是 config.json 的 pushNoContent（lib/config-store.ts），派发器每条现读。
 */
import type { ApnsMessage } from "./apns.js";
import { t } from "./i18n.js";

const GENERIC_TITLE = "Claudestra";
const genericBody = () => t("有新消息", "New message");

/** Web Push 的 payload：通知 → 通用通知；dismiss → 只留 ts 和 badge（SW 按 fp 关掉这台机器 ts 之前的通用通知） */
export function redactWebPush(p: Record<string, unknown>): Record<string, unknown> {
  const ts = typeof p.ts === "number" ? p.ts : Date.now();
  const badge = typeof p.badge === "number" ? { badge: p.badge } : {};
  if (p.type === "dismiss") return { type: "dismiss", ts, ...badge, ...(p.all === true ? { all: true } : {}) };
  return { title: GENERIC_TITLE, body: genericBody(), url: "/chat", tag: `cstra-${ts}`, agent: "", ts, ...badge };
}

/** APNs：普通通知 → 通用通知；只同步角标的静默推送保持静默，只是去掉 agent（thread-id） */
export function redactApns(m: ApnsMessage): ApnsMessage {
  const base = { agent: "", url: "/chat", ts: m.ts, ...(m.badge !== undefined ? { badge: m.badge } : {}) };
  if (m.silent) return { ...base, silent: true, title: "", body: "", tag: `cstra-badge-${m.ts}` };
  return { ...base, title: GENERIC_TITLE, body: genericBody(), tag: `cstra-${m.ts}` };
}
