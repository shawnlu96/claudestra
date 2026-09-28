"use client";
/**
 * peer 联系人的只读小件（数据是 ../contacts-data.ts 的 GET /api/v1/peers/contacts，不新增探测）：
 * Peer 按钮上的在线摘要、Peer 面板每个 peer 下「他开放给你的」逐行忙闲、@ 候选的状态点。
 * 忙闲只有对方返回了才显示，其余一律「—」：离线、目录过期、对方老版本都不猜。
 */
import { useT } from "@/lib/i18n";
import type { ContactAgent, PeerContact } from "../contact-types";
import { useContacts } from "../contacts-data";

/** 在线点颜色：连得上是绿，已知在忙是黄（与会话列表同一套）；连不上 / 不知道是灰。忙闲不知道时仍按连通性给绿，文字另写「—」 */
export function presenceTone(online: boolean | null, busy?: boolean): string {
  if (online === true) return busy ? "bg-warning" : "bg-success";
  return online === false ? "bg-base-content/25" : "bg-base-content/15";
}

/** 按钮上的摘要：非全权设备（403）/ 没有 peer → null，按钮保持原样 */
export function usePeerOnline(): { online: number; total: number } | null {
  const { allowed, contacts } = useContacts();
  if (!allowed || !contacts.length) return null;
  return { online: contacts.filter((c) => c.online === true).length, total: contacts.length };
}

/** 这个 peer 的联系人数据（带忙闲）；非全权设备 / 老 bridge 拿不到 → undefined */
export const useContact = (peer: string): PeerContact | undefined => useContacts().contacts.find((x) => x.name === peer);

/** Peer 面板「我 → 他」下面：对方开放给我的 agent，一行一个，带忙闲 */
export function ContactAgentLines({ contact: c }: { contact: PeerContact }) {
  const t = useT();
  const busyText = (a: ContactAgent) => (a.stopped ? t("已停止") : a.busy === true ? t("忙") : a.busy === false ? t("空闲") : "—");
  return (
    <ul className="pl-3 text-base-content/60">
      <li className="text-base-content/45">{t("他开放给你的")}:</li>
      {c.agents.map((a) => (
        <li key={a.name} className="flex items-center gap-1.5 py-0.5">
          <span className={`size-1.5 shrink-0 rounded-full ${presenceTone(a.stopped ? false : c.online, a.busy)}`} />
          <span className="min-w-0 flex-1 truncate">{a.name.replace(/^agent-/, "")}</span>
          <span className="shrink-0 text-base-content/45">{busyText(a)}</span>
        </li>
      ))}
    </ul>
  );
}
