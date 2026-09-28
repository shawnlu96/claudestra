"use client";
/**
 * 侧栏「联系人」分组（只读，像 QQ 好友列表）：每个 peer 一行在线状态，下面是对方开放给我的 agent 与忙闲。
 * 数据是 bridge 现有的 peer presence（../contacts-data.ts），不新增探测；非全权设备（403）整组不出。
 * 忙闲只有对方返回了才显示，其余一律「—」：离线、目录过期、对方老版本都不猜。点行不做事——跨机会话不在这一期。
 */
import { useT } from "@/lib/i18n";
import { fmtAgo } from "../fmt-time";
import { useContacts } from "../contacts-data";
import type { ContactAgent, PeerContact } from "../contact-types";
import { usePersistedSet } from "../use-persisted-set";
import { Chevron } from "./project-group";
import { UsersIcon } from "./external-badge";

const ALL = "__all__";

/** 在线点颜色：连得上是绿，已知在忙是黄（与会话列表同一套）；连不上 / 不知道是灰。忙闲不知道时仍按连通性给绿，文字另写「—」 */
export function presenceTone(online: boolean | null, busy?: boolean): string {
  if (online === true) return busy ? "bg-warning" : "bg-success";
  return online === false ? "bg-base-content/25" : "bg-base-content/15";
}

/** 列表为空的原因：凭据被拒 / 单向看不到 / 对方确实没开放，三种说法不同，别让人以为是对方收回了授权 */
function emptyReason(c: PeerContact, t: ReturnType<typeof useT>): string {
  if (c.rejected) return t("对方拒绝了我们的凭据（可能已被移除），需要重新加入");
  return c.online === null ? t("单向连接：看不到对方开放了哪些 agent") : t("对方没有开放 agent 给你");
}

const rank = (c: PeerContact) => (c.online === true ? 0 : c.online === false ? 1 : 2);

function PeerStatus({ c }: { c: PeerContact }) {
  const t = useT();
  const at = (iso?: string) => (iso ? Date.parse(iso) : null);
  let text: string;
  if (c.online === true) text = t("在线");
  else if (c.online === false) text = at(c.lastOnlineAt) ? t("{ago}在线", { ago: fmtAgo(at(c.lastOnlineAt)) }) : t("离线");
  else text = at(c.lastInboundAt) ? t("{ago}来过", { ago: fmtAgo(at(c.lastInboundAt)) }) : t("单向");
  return <span className="ml-auto shrink-0 text-[11px] font-normal text-base-content/45">{text}</span>;
}

function AgentLine({ a, online }: { a: ContactAgent; online: boolean | null }) {
  const t = useT();
  const busyText = a.stopped ? t("已停止") : a.busy === true ? t("忙") : a.busy === false ? t("空闲") : "—";
  return (
    <li className="flex items-center gap-2 py-1 pl-7 pr-1.5 text-[12.5px]">
      <span className={`size-1.5 shrink-0 rounded-full ${presenceTone(a.stopped ? false : online, a.busy)}`} />
      <span className="min-w-0 flex-1 truncate">{a.name.replace(/^agent-/, "")}</span>
      <span className="shrink-0 text-[11px] text-base-content/45">{busyText}</span>
    </li>
  );
}

function PeerBlock({ c, collapsed, onToggle }: { c: PeerContact; collapsed: boolean; onToggle: () => void }) {
  const t = useT();
  return (
    <li>
      <button type="button" className="flex w-full items-center gap-2 rounded-lg px-1.5 py-1.5 text-left text-[13px]" onClick={onToggle}>
        <Chevron open={!collapsed} className="text-base-content/30" />
        <span className={`size-2 shrink-0 rounded-full ${presenceTone(c.online)}`} />
        <span className="min-w-0 truncate font-medium">{c.name}</span>
        <PeerStatus c={c} />
      </button>
      {!collapsed && (
        <ul>
          {c.agents.map((a) => <AgentLine key={a.name} a={a} online={c.online} />)}
          {!c.agents.length && (
            <li className="py-1 pl-[42px] pr-1.5 text-[11.5px] text-base-content/40">
              {emptyReason(c, t)}
            </li>
          )}
        </ul>
      )}
    </li>
  );
}

export function ContactsGroup() {
  const t = useT();
  const { allowed, contacts } = useContacts();
  const [collapsed, toggle] = usePersistedSet("cstra_contacts_collapsed");
  if (!allowed || !contacts.length) return null;
  const list = [...contacts].sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name));
  const online = contacts.filter((c) => c.online === true).length;
  const open = !collapsed.has(ALL);
  return (
    <li className="mx-2 mt-1 list-none rounded-xl bg-base-300/25 p-1">
      <button type="button" className="flex w-full items-center gap-2 rounded-lg px-1.5 py-1.5 text-left text-sm font-medium" onClick={() => toggle(ALL)}>
        <Chevron open={open} className="text-base-content/40" />
        <span className="shrink-0 text-base-content/60"><UsersIcon size={13} /></span>
        <span className="truncate">{t("联系人")}</span>
        <span className="ml-auto shrink-0 text-[11px] font-normal text-base-content/40">{t("{n}/{total} 在线", { n: online, total: contacts.length })}</span>
      </button>
      {open && <ul className="max-h-72 overflow-y-auto pb-1">{list.map((c) => <PeerBlock key={c.name} c={c} collapsed={collapsed.has(c.name)} onToggle={() => toggle(c.name)} />)}</ul>}
    </li>
  );
}
