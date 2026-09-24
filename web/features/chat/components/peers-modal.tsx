"use client";
import { useCallback, useEffect, useState } from "react";
import { CenteredModal } from "./centered-modal";
import { useT } from "@/lib/i18n";
import { useArmedConfirm } from "../use-armed-confirm";
import { peersAction, ScopePicker, ForceRow, HandshakeString, type ActionResult, type LocalAgent } from "./peers-shared";
import { JoinPanel } from "./peers-join-panel";
import { InviteChecklist } from "./peers-invite-checklist";
import { LastVisit, PresenceLine, PresenceSummary, sortByPresence, type PeerPresenceInfo } from "./peers-presence";
import { PeersTidyBanner, type TidyGroupInfo } from "./peers-tidy-banner";

/**
 * HTTP peer 管理弹窗（设置 → Peer 协作 → 管理）：
 * - 列表:每个 peer 的握手状态 / 对方可访问我哪些 agent(入站 scope,可编辑) /
 *   我在对方那边可访问哪些 agent(出站,测试连通实时拉)
 * - v2.15+ 一键邀请(owner 2026-07-27「简化」):生成邀请 → 对方粘贴 → 自动完成,
 *   免掉旧三步握手的回执/accept。旧三步只剩 CLI(跨版本兼容),UI 不再展示。
 * - 移除 = 立即吊销对方 token;待兑换邀请可撤销(连带吊销内嵌 token)
 * R1 校验(未标 external / "*")在 manager 侧,UI 收到 --force 提示后
 * 弹「强制执行」二次确认——服务端是唯一裁判,前端不复刻规则。
 * master 不出现在勾选器:服务端硬禁(--force 也不放行),前端连选项都不给。
 */

interface PeerInfo {
  name: string;
  baseUrl: string | null;
  handshakeDone: boolean;
  disabled: boolean;
  addedAt: string;
  inTokenId: string | null;
  exposedAgents: string[];
  presence?: PeerPresenceInfo;
}

interface PendingInviteInfo {
  id: string;
  agents: string[];
  createdAt: string;
  expiresAt: string;
  /** 完整邀请串（再复制用）;token 已被吊销时为 null */
  invite: string | null;
}

function PeerCard({
  peer,
  localAgents,
  onChanged,
}: {
  peer: PeerInfo;
  localAgents: LocalAgent[];
  onChanged: () => void;
}) {
  const t = useT();
  const [editing, setEditing] = useState(false);
  const [sel, setSel] = useState<string[]>(peer.exposedAgents);
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState("");
  const [needForce, setNeedForce] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testRes, setTestRes] = useState<ActionResult | null>(null);
  // 两段式确认：第二下直接执行、不复原，「确认移除?」保持到 4 秒计时结束（原样）
  const { armed: confirmRm, arm: armRm } = useArmedConfirm(4000);
  const [removing, setRemoving] = useState(false);

  const saveScope = async (force: boolean) => {
    setSaving(true);
    setMsg("");
    const r = await peersAction({ action: "scope", name: peer.name, agents: sel, force });
    setSaving(false);
    if (r.ok) {
      setNeedForce(false);
      setEditing(false);
      onChanged();
    } else if ((r.error || "").includes("--force")) {
      setNeedForce(true);
      setMsg(r.error || "");
    } else {
      setMsg(r.error || t("保存失败"));
    }
  };

  const runTest = async () => {
    setTesting(true);
    setTestRes(null);
    const r = await peersAction({ action: "test", name: peer.name });
    setTestRes(r);
    setTesting(false);
  };

  const remove = async () => {
    if (!confirmRm) {
      armRm();
      return;
    }
    setRemoving(true);
    const r = await peersAction({ action: "remove", name: peer.name });
    setRemoving(false);
    if (r.ok) onChanged();
    else setMsg(r.error || t("移除失败"));
  };

  // 一个对方一张卡：两个方向各一行。他→我 = 我签给他的有效 token（exposedAgents 为空 = 没有 / 已吊销）；
  // 我→他 = 我存着他的地址 + token（handshakeDone）。不再用「握手 / 单向」这类说法。
  const inbound = peer.exposedAgents.length > 0;
  const row = "mt-3 flex items-start gap-3";
  const label = "w-12 shrink-0 pt-0.5 text-[11.5px] font-medium text-base-content/50";
  return (
    <section className="rounded-xl bg-base-200/60 p-4">
      <div className="flex items-center gap-2">
        <span className="text-[13.5px] font-semibold">{peer.name}</span>
        {peer.disabled && <span className="badge badge-ghost badge-xs">{t("已禁用")}</span>}
        <button
          className={`btn btn-ghost btn-xs ml-auto ${confirmRm ? "text-error" : "text-base-content/50"}`}
          disabled={removing}
          onClick={() => void remove()}
        >
          {removing ? "…" : confirmRm ? t("确认移除?") : t("移除")}
        </button>
      </div>

      <div className={row}>
        <span className={label}>{t("他 → 我")}</span>
        <div className="min-w-0 flex-1">
          {editing ? (
            <div>
              <ScopePicker localAgents={localAgents} sel={sel} onChange={setSel} />
              {needForce && msg ? (
                <ForceRow msg={msg} busy={saving} onForce={() => void saveScope(true)} forceLabel="确认风险，强制保存" />
              ) : (
                msg && <div className="mt-1 text-xs text-error">{msg}</div>
              )}
              <div className="mt-2 flex justify-end gap-2">
                <button className="btn btn-ghost btn-xs" disabled={saving} onClick={() => setEditing(false)}>
                  {t("取消")}
                </button>
                <button className="btn btn-primary btn-xs" disabled={saving || sel.length === 0} onClick={() => void saveScope(false)}>
                  {t("保存")}
                </button>
              </div>
            </div>
          ) : inbound ? (
            <>
              <div className="flex flex-wrap items-center gap-1 text-[11.5px] text-base-content/60">
                {t("可以找你的")}:
                {peer.exposedAgents.map((a) => (
                  <span key={a} className="badge badge-outline badge-sm font-mono">{a}</span>
                ))}
                <button
                  className="btn btn-ghost btn-xs"
                  onClick={() => {
                    setSel(peer.exposedAgents);
                    setMsg("");
                    setNeedForce(false);
                    setEditing(true);
                  }}
                >
                  {t("修改")}
                </button>
              </div>
              <LastVisit presence={peer.presence} />
            </>
          ) : (
            <div className="text-[11.5px] text-base-content/45">{t("他还连不上你——生成一张邀请发给他")}</div>
          )}
        </div>
      </div>

      <div className={row}>
        <span className={label}>{t("我 → 他")}</span>
        <div className="min-w-0 flex-1">
          {peer.handshakeDone ? (
            <>
              <div className="flex items-start gap-1">
                <div className="min-w-0 flex-1 [&>div]:mt-0">
                  <PresenceLine presence={peer.presence} />
                </div>
                <button className="btn btn-ghost btn-xs" disabled={testing} onClick={() => void runTest()}>
                  {testing ? <span className="loading loading-spinner loading-xs" /> : t("测试")}
                </button>
              </div>
              <div className="mt-0.5 truncate font-mono text-[10.5px] text-base-content/40">{peer.baseUrl}</div>
              {testRes && (
                <div className={`mt-1 text-[11.5px] ${testRes.ok ? "text-success" : "text-error"}`}>
                  {testRes.ok
                    ? `${t("连通正常")}${(testRes.remoteAgents || []).length ? ` · ${(testRes.remoteAgents || []).map((a) => a.name.replace(/^agent-/, "")).join(", ")}` : ` · ${t("（对方未开放任何 agent）")}`}`
                    : testRes.error}
                </div>
              )}
            </>
          ) : (
            <div className="text-[11.5px] text-base-content/45">{t("你还连不上他——让他发邀请给你，在下面「加入」里粘贴")}</div>
          )}
        </div>
      </div>
    </section>
  );
}

/** 生成一键邀请：勾 agent → 出邀请串。对方粘贴即完成，24h 一次性。 */
function InvitePanel({ localAgents, onChanged }: { localAgents: LocalAgent[]; onChanged: () => void }) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const [sel, setSel] = useState<string[]>([]);
  const [url, setUrl] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState("");
  const [needForce, setNeedForce] = useState(false);
  const [result, setResult] = useState<ActionResult | null>(null);

  const toggle = () => {
    if (!open) {
      setMsg("");
      setNeedForce(false);
      setResult(null);
      // 地址默认留空 = 交给 manager 自动选（实测通的 HTTPS 入口优先，其次 Tailscale IP）。
      // 预填 bridge 端口地址会被原样写进邀请、跳过 HTTPS——对方被防火墙拒，只报 Unable to connect。
      setUrl("");
    }
    setOpen(!open);
  };

  const submit = async (force = false) => {
    setBusy(true);
    setMsg("");
    const r = await peersAction({ action: "invite-new", agents: sel, url: url.trim() || undefined, force });
    setBusy(false);
    if (r.ok) {
      setResult(r);
      setNeedForce(false);
      onChanged();
    } else if ((r.error || "").includes("--force")) {
      setNeedForce(true);
      setMsg(r.error || "");
    } else {
      setMsg(r.error || t("操作失败"));
    }
  };

  return (
    <section className="rounded-xl bg-base-200/60 p-4">
      <div className="flex items-center justify-between">
        <span className="text-[13.5px] font-semibold">{t("生成邀请")}</span>
        <button
          className={`btn btn-xs ${open ? "btn-ghost border-base-300" : "btn-primary"}`}
          onClick={toggle}
        >
          {open ? t("收起") : t("邀请对方")}
        </button>
      </div>
      {!open && (
        <p className="mt-0.5 text-xs leading-relaxed text-base-content/50">
          {t("勾选要开放的 agent → 生成邀请串发给对方 → 对方粘贴即完成。24h 有效、一次性。")}
        </p>
      )}
      {open && (
        <div className="mt-3 space-y-2">
          <div>
            <div className="mb-1 text-xs text-base-content/60">{t("向对方开放的 agent")}</div>
            <ScopePicker localAgents={localAgents} sel={sel} onChange={setSel} />
          </div>
          <details className="text-xs">
            <summary className="cursor-pointer text-base-content/50">{t("高级：自定义我方地址（默认自动探测）")}</summary>
            <input
              type="text"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              placeholder={t("留空 = 自动（优先 HTTPS 入口）")}
              autoComplete="off"
              className="input input-bordered input-sm mt-1 w-full font-mono text-xs"
            />
          </details>
          {needForce && msg ? (
            <ForceRow msg={msg} busy={busy} onForce={() => void submit(true)} forceLabel="确认风险，强制执行" />
          ) : (
            msg && <div className="text-xs text-error">{msg}</div>
          )}
          {result?.invite && (
            <>
              <HandshakeString label={t("邀请串（发给对方，粘贴即完成）")} value={result.invite} />
              <InviteChecklist myUrl={result.myUrl} />
              <div className="text-[11px] text-base-content/50">
                {t("24h 内有效、只能用一次。对方接入后你会收到通知。")}
              </div>
            </>
          )}
          {!!result?.warnings?.length && (
            <div className="text-[11px] text-warning">{result.warnings.join(" · ")}</div>
          )}
          {!result?.invite && (
            <div className="flex justify-end">
              <button className="btn btn-primary btn-sm" disabled={busy || sel.length === 0} onClick={() => void submit()}>
                {busy ? <span className="loading loading-spinner loading-xs" /> : t("生成邀请串")}
              </button>
            </div>
          )}
        </div>
      )}
    </section>
  );
}

/** 待兑换邀请：可再复制、可撤销（撤销连带吊销内嵌 token） */
function PendingInvites({ invites, onChanged }: { invites: PendingInviteInfo[]; onChanged: () => void }) {
  const t = useT();
  const [busyId, setBusyId] = useState("");
  if (invites.length === 0) return null;
  const revoke = async (id: string) => {
    setBusyId(id);
    await peersAction({ action: "invite-revoke", id });
    setBusyId("");
    onChanged();
  };
  return (
    <section className="rounded-xl bg-base-200/60 p-4">
      <span className="text-[13.5px] font-semibold">{t("待兑换的邀请")}</span>
      <div className="mt-2 space-y-2">
        {invites.map((inv) => (
          <div key={inv.id} className="rounded-lg bg-base-100 p-2">
            <div className="flex items-center gap-2">
              <span className="font-mono text-[11px] text-base-content/60">{inv.id}</span>
              <div className="flex flex-wrap gap-1">
                {inv.agents.map((a) => (
                  <span key={a} className="badge badge-outline badge-xs font-mono">
                    {a}
                  </span>
                ))}
              </div>
              <button
                className="btn btn-ghost btn-xs ml-auto text-error"
                disabled={busyId === inv.id}
                onClick={() => void revoke(inv.id)}
              >
                {busyId === inv.id ? "…" : t("撤销")}
              </button>
            </div>
            <div className="mt-1 flex items-center justify-between">
              <span className="text-[10px] text-base-content/40">
                {t("有效期至")} {new Date(inv.expiresAt).toLocaleString()}
              </span>
              {inv.invite && (
                <CopyInviteButton value={inv.invite} />
              )}
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}

function CopyInviteButton({ value }: { value: string }) {
  const t = useT();
  const [copied, setCopied] = useState(false);
  return (
    <button
      className="btn btn-ghost btn-xs"
      onClick={() => {
        void navigator.clipboard?.writeText(value).then(() => {
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        });
      }}
    >
      {copied ? t("已复制") : t("复制邀请串")}
    </button>
  );
}

export function PeersModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const t = useT();
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState("");
  const [peers, setPeers] = useState<PeerInfo[]>([]);
  const [localAgents, setLocalAgents] = useState<LocalAgent[]>([]);
  const [pendingInvites, setPendingInvites] = useState<PendingInviteInfo[]>([]);
  const [tidy, setTidy] = useState<TidyGroupInfo[]>([]);

  const reload = useCallback(async () => {
    setErr("");
    try {
      const res = await fetch("/api/peers");
      const j = (await res.json()) as { ok?: boolean; error?: string; peers?: PeerInfo[]; localAgents?: LocalAgent[]; pendingInvites?: PendingInviteInfo[]; tidy?: TidyGroupInfo[] };
      if (j.ok) {
        setPeers(j.peers || []);
        setLocalAgents(j.localAgents || []);
        setPendingInvites(j.pendingInvites || []);
        setTidy(j.tidy || []);
      } else {
        setErr(j.error || t("加载失败"));
      }
    } catch {
      setErr(t("加载失败"));
    }
    setLoading(false);
  }, [t]);

  useEffect(() => {
    if (!open) return;
    setLoading(true);
    void reload();
    // 开着时跟上 bridge 每分钟一次的在线检测
    const iv = setInterval(() => void reload(), 30_000);
    return () => clearInterval(iv);
  }, [open, reload]);

  if (!open) return null;

  // 本弹窗从设置弹窗内打开：遮罩点击的 stopPropagation 由外壳负责，不拦会连设置弹窗一起关
  return (
    <CenteredModal onClose={onClose}>
        <div className="flex items-center justify-between px-5 pb-2 pt-4">
          <span className="text-base font-semibold">{t("Peer 协作")}</span>
          <button className="btn btn-ghost btn-sm" aria-label={t("关闭")} onClick={onClose}>
            ✕
          </button>
        </div>
        <div className="min-h-0 flex-1 space-y-3 overflow-y-auto overscroll-contain px-5 pb-5 pt-1">
          <p className="text-xs leading-relaxed text-base-content/50">
            {t("跨 Claudestra 实例互访：双方互签 token，send_to_agent(\"<agent>@<peer>\") 直达对方。移除即吊销。")}
          </p>
          {err && <div className="alert alert-error px-3 py-2 text-xs">{err}</div>}
          {loading ? (
            <div className="grid place-items-center py-8">
              <span className="loading loading-spinner loading-md" />
            </div>
          ) : (
            <>
              <PeersTidyBanner groups={tidy} onDone={() => void reload()} />
              <PresenceSummary peers={peers} />
              {sortByPresence(peers).map((p) => (
                <PeerCard key={p.name} peer={p} localAgents={localAgents} onChanged={() => void reload()} />
              ))}
              {peers.length === 0 && !err && (
                <div className="py-2 text-center text-xs text-base-content/40">
                  {t("暂无 peer。生成邀请发给对方，或粘贴对方的邀请加入。")}
                </div>
              )}
              <PendingInvites invites={pendingInvites} onChanged={() => void reload()} />
              <InvitePanel localAgents={localAgents} onChanged={() => void reload()} />
              <JoinPanel localAgents={localAgents} onChanged={() => void reload()} />
            </>
          )}
        </div>
    </CenteredModal>
  );
}
