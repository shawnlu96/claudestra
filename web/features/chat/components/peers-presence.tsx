"use client";
/**
 * Peer 面板里的在线状态（数据来自 bridge 每分钟一次的探测，src/bridge/peer-presence.ts）：
 * 在线 = 我们能连上对方；离线给出原因；单向（只有对方连我们）不算离线——我们本来就没法主动探。
 * 另附对方最近一次来访时间：单向 peer 只能靠它判断「对方最近还在用」。
 */
import { useT } from "@/lib/i18n";
import { fmtAgo } from "../fmt-time";

export interface PeerPresenceInfo {
  online: boolean | null;
  checkedAt?: string;
  lastOnlineAt?: string;
  latencyMs?: number;
  remoteAgents?: { name: string; status?: string }[];
  error?: string;
  lastInboundAt?: string;
}

const ms = (iso?: string) => (iso ? Date.parse(iso) : null);

/** 离线原因 → 人话（中文 key，渲染时过 t()） */
function reasonOf(error?: string): string {
  if (error === "timeout") return "连接超时：对方机器可能关机，或没在 Tailscale 里共享给你";
  if (error === "refused") return "连接被拒：对方 bridge 没对外开放这个端口";
  if (error === "http 401" || error === "http 403") return "对方拒绝了我们的 token：可能已被移除，需要重新加入";
  return error || "连不上";
}

/** 在线的排前面，其次最近在线过的，最后单向 / 从没连上的 */
export function sortByPresence<T extends { name: string; presence?: PeerPresenceInfo }>(peers: T[]): T[] {
  const rank = (p: T) => (p.presence?.online === true ? 0 : p.presence?.online === false ? 1 : 2);
  return [...peers].sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name));
}

export function PresenceSummary({ peers }: { peers: { presence?: PeerPresenceInfo }[] }) {
  const t = useT();
  const online = peers.filter((p) => p.presence?.online === true).length;
  const probed = peers.filter((p) => p.presence?.online !== null && p.presence?.online !== undefined).length;
  if (!peers.length) return null;
  return (
    <div className="text-xs text-base-content/60">
      {t("在线")} <span className="font-semibold text-success">{online}</span> / {probed}
      <span className="text-base-content/40"> · {t("每分钟检测一次")}</span>
    </div>
  );
}

export function PresenceLine({ presence }: { presence?: PeerPresenceInfo }) {
  const t = useT();
  const p = presence ?? { online: null };
  const inbound = ms(p.lastInboundAt);
  const dot = p.online === true ? "bg-success" : p.online === false ? "bg-error" : "bg-base-content/25";
  let head: string;
  if (p.online === true) head = `${t("在线")}${p.latencyMs !== undefined ? ` · ${p.latencyMs}ms` : ""}`;
  else if (p.online === false) head = `${t("离线")} · ${t(reasonOf(p.error))}`;
  else head = p.checkedAt ? t("单向：只有对方能连你，这边没法主动检测") : t("检测中…");
  const lastOnline = p.online === false ? ms(p.lastOnlineAt) : null;
  return (
    <div className="mt-1.5 space-y-0.5 text-[11.5px] leading-snug text-base-content/60">
      <div className="flex items-start gap-1.5">
        <span className={`mt-[5px] size-1.5 shrink-0 rounded-full ${dot}`} />
        <span>{head}</span>
      </div>
      {p.online === false && (
        <div className="pl-3 text-base-content/45">{lastOnline ? `${t("上次在线")} ${fmtAgo(lastOnline)}` : t("还没连上过")}</div>
      )}
      {!!p.remoteAgents?.length && (
        <div className="pl-3 text-base-content/45">
          {t("对方开放给我")}: {p.remoteAgents.map((a) => a.name.replace(/^agent-/, "")).join(", ")}
        </div>
      )}
      {inbound && <div className="pl-3 text-base-content/45">{`${t("对方最近来访")} ${fmtAgo(inbound)}`}</div>}
    </div>
  );
}
