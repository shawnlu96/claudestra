"use client";
import { useCallback, useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { useT } from "@/lib/i18n";

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
}

interface PendingInviteInfo {
  id: string;
  agents: string[];
  createdAt: string;
  expiresAt: string;
  /** 完整邀请串（再复制用）;token 已被吊销时为 null */
  invite: string | null;
}

interface LocalAgent {
  name: string;
  external: boolean;
  status: string;
}

type ActionResult = {
  ok?: boolean;
  error?: string;
  invite?: string;
  receipt?: string;
  warnings?: string[];
  reachable?: boolean;
  remoteAgents?: { name: string; status: string }[];
  // v2.15+ 一键邀请
  expiresAt?: string;
  myUrl?: string;
  peer?: string;
  note?: string;
  exposedAgents?: string[];
};

async function peersAction(body: Record<string, unknown>): Promise<ActionResult> {
  try {
    const res = await fetch("/api/peers", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    return (await res.json()) as ActionResult;
  } catch {
    return { ok: false, error: "网络错误" };
  }
}

const MY_URL_KEY = "cstra_peer_url";

/** Bridge 探测出的本机对外地址候选（tailscale 优先） */
type SuggestedUrl = { url: string; kind: "tailscale" | "lan"; iface: string; address: string };

/** scope 勾选器：全部(*) + master + 每个本地 agent。external 未标的带 ⚠。 */
function ScopePicker({
  localAgents,
  sel,
  onChange,
}: {
  localAgents: LocalAgent[];
  sel: string[];
  onChange: (v: string[]) => void;
}) {
  const t = useT();
  const star = sel.includes("*");
  const toggle = (n: string) =>
    onChange(sel.includes(n) ? sel.filter((x) => x !== n) : [...sel, n]);
  // master 不提供勾选:服务端硬禁,peer 永远拿不到大总管(owner 2026-07-27)
  const toggleStar = () => onChange(star ? [] : ["*"]);
  return (
    <div className="max-h-44 space-y-1 overflow-y-auto rounded-lg border border-base-300 bg-base-100 p-2">
      <label className="flex cursor-pointer items-center gap-2 text-sm">
        <input type="checkbox" className="checkbox checkbox-xs" checked={star} onChange={toggleStar} />
        <span>{t("全部普通 agent（*）")}</span>
        <span className="text-[10px] text-warning">{t("⚠ 不含 master")}</span>
      </label>
      {localAgents.map((a) => (
        <label key={a.name} className="flex cursor-pointer items-center gap-2 text-sm">
          <input
            type="checkbox"
            className="checkbox checkbox-xs"
            checked={star || sel.includes(a.name)}
            disabled={star}
            onChange={() => toggle(a.name)}
          />
          <span className={a.status === "active" ? "" : "opacity-50"}>{a.name}</span>
          {a.external ? (
            <span className="badge badge-ghost badge-xs">external</span>
          ) : (
            <span className="text-[10px] text-warning">{t("⚠ 未标 external")}</span>
          )}
        </label>
      ))}
    </div>
  );
}

/** 错误/告警行 + 「强制执行」二次确认（服务端 --force / --rotate 提示驱动） */
function ForceRow({
  msg,
  busy,
  onForce,
  forceLabel,
}: {
  msg: string;
  busy: boolean;
  onForce: () => void;
  forceLabel: string;
}) {
  const t = useT();
  return (
    <div className="mt-2 rounded-lg bg-warning/10 p-2 text-xs">
      <div className="whitespace-pre-wrap break-all text-base-content/80">{msg}</div>
      <button className="btn btn-warning btn-xs mt-2" disabled={busy} onClick={onForce}>
        {t(forceLabel)}
      </button>
    </div>
  );
}

/** 握手串展示 + 复制 */
function HandshakeString({ label, value }: { label: string; value: string }) {
  const t = useT();
  const [copied, setCopied] = useState(false);
  return (
    <div className="mt-2 rounded-lg bg-base-100 p-2">
      <div className="flex items-center justify-between">
        <span className="text-xs font-medium">{label}</span>
        <button
          className="btn btn-ghost btn-xs"
          onClick={() => {
            void navigator.clipboard?.writeText(value).then(() => {
              setCopied(true);
              setTimeout(() => setCopied(false), 1500);
            });
          }}
        >
          {copied ? t("已复制") : t("复制")}
        </button>
      </div>
      <div className="mt-1 max-h-20 overflow-y-auto break-all font-mono text-[10px] leading-tight text-base-content/70">
        {value}
      </div>
    </div>
  );
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
  const [confirmRm, setConfirmRm] = useState(false);
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
      setConfirmRm(true);
      setTimeout(() => setConfirmRm(false), 4000);
      return;
    }
    setRemoving(true);
    const r = await peersAction({ action: "remove", name: peer.name });
    setRemoving(false);
    if (r.ok) onChanged();
    else setMsg(r.error || t("移除失败"));
  };

  return (
    <section className="rounded-xl bg-base-200/60 p-4">
      <div className="flex items-center gap-2">
        <span className="text-[13.5px] font-semibold">🤝 {peer.name}</span>
        {peer.disabled ? (
          <span className="badge badge-ghost badge-xs">{t("已禁用")}</span>
        ) : peer.handshakeDone ? (
          <span className="badge badge-success badge-xs">{t("握手完成")}</span>
        ) : peer.inTokenId ? (
          // v2.15+ 一键邀请的单向形态:对方能访问我,我没有对方的地址/token
          <span className="badge badge-info badge-xs">{t("单向（对方→我）")}</span>
        ) : (
          <span className="badge badge-warning badge-xs">{t("等待对方回执")}</span>
        )}
        <button
          className={`btn btn-ghost btn-xs ml-auto ${confirmRm ? "text-error" : "text-base-content/50"}`}
          disabled={removing}
          onClick={() => void remove()}
        >
          {removing ? "…" : confirmRm ? t("确认移除?") : t("移除")}
        </button>
      </div>
      {peer.baseUrl && (
        <div className="mt-0.5 truncate font-mono text-[11px] text-base-content/50">{peer.baseUrl}</div>
      )}

      {/* 入站:对方可访问我这边哪些 agent */}
      <div className="mt-3">
        <div className="flex items-center justify-between">
          <span className="text-xs text-base-content/60">{t("对方可访问我的")}</span>
          {!editing && (
            <button
              className="btn btn-ghost btn-xs"
              onClick={() => {
                setSel(peer.exposedAgents);
                setMsg("");
                setNeedForce(false);
                setEditing(true);
              }}
            >
              {t("编辑")}
            </button>
          )}
        </div>
        {editing ? (
          <div className="mt-1">
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
              <button
                className="btn btn-primary btn-xs"
                disabled={saving || sel.length === 0}
                onClick={() => void saveScope(false)}
              >
                {t("保存")}
              </button>
            </div>
          </div>
        ) : (
          <div className="mt-1 flex flex-wrap gap-1">
            {peer.exposedAgents.length ? (
              peer.exposedAgents.map((a) => (
                <span key={a} className="badge badge-outline badge-sm font-mono">
                  {a}
                </span>
              ))
            ) : (
              <span className="text-xs text-base-content/40">{t("（无有效 token）")}</span>
            )}
          </div>
        )}
      </div>

      {/* 出站:我在对方那边可访问哪些 agent(实时探测) */}
      <div className="mt-3">
        <div className="flex items-center justify-between">
          <span className="text-xs text-base-content/60">{t("我可访问对方的")}</span>
          <button className="btn btn-ghost btn-xs" disabled={testing || !peer.handshakeDone} onClick={() => void runTest()}>
            {testing ? <span className="loading loading-spinner loading-xs" /> : t("测试连通")}
          </button>
        </div>
        {testRes && (
          <div className="mt-1">
            {testRes.ok ? (
              <div className="flex flex-wrap items-center gap-1">
                <span className="badge badge-success badge-xs">{t("连通正常")}</span>
                {(testRes.remoteAgents || []).map((a) => (
                  <span key={a.name} className="badge badge-outline badge-sm font-mono">
                    {a.name}
                    <span className={`ml-1 size-1.5 rounded-full ${a.status === "active" ? "bg-success" : "bg-base-content/30"}`} />
                  </span>
                ))}
                {(testRes.remoteAgents || []).length === 0 && (
                  <span className="text-xs text-base-content/40">{t("（对方未开放任何 agent）")}</span>
                )}
              </div>
            ) : (
              <div className="text-xs text-error">{testRes.error}</div>
            )}
          </div>
        )}
        {!peer.handshakeDone && !testRes && (
          <div className="mt-1 text-xs text-base-content/40">{t("握手完成后可测试")}</div>
        )}
      </div>
    </section>
  );
}

/** 生成一键邀请：勾 agent → 出邀请串。对方粘贴即完成，24h 一次性。 */
function InvitePanel({
  localAgents,
  suggestedUrls,
  onChanged,
}: {
  localAgents: LocalAgent[];
  suggestedUrls: SuggestedUrl[];
  onChanged: () => void;
}) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const [sel, setSel] = useState<string[]>([]);
  const [url, setUrl] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState("");
  const [needForce, setNeedForce] = useState(false);
  const [result, setResult] = useState<ActionResult | null>(null);

  useEffect(() => {
    if (!open) return;
    setMsg("");
    setNeedForce(false);
    setResult(null);
    try {
      setUrl(localStorage.getItem(MY_URL_KEY) || suggestedUrls[0]?.url || "");
    } catch {}
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const submit = async (force = false) => {
    setBusy(true);
    setMsg("");
    try {
      localStorage.setItem(MY_URL_KEY, url.trim());
    } catch {}
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
          onClick={() => setOpen((v) => !v)}
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
              placeholder={t("我方 bridge 地址（http://100.x.y.z:3847）")}
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

/** 粘贴对方的邀请串,一步接入。默认不反向开放任何 agent。 */
function JoinPanel({ onChanged }: { onChanged: () => void }) {
  const t = useT();
  const [paste, setPaste] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState("");
  const [result, setResult] = useState<ActionResult | null>(null);

  const submit = async () => {
    setBusy(true);
    setMsg("");
    const r = await peersAction({ action: "join-auto", invite: paste.trim() });
    setBusy(false);
    if (r.ok) {
      setResult(r);
      setPaste("");
      onChanged();
    } else {
      setMsg(r.error || t("操作失败"));
    }
  };

  return (
    <section className="rounded-xl bg-base-200/60 p-4">
      <span className="text-[13.5px] font-semibold">{t("加入对方")}</span>
      <div className="mt-2 space-y-2">
        <textarea
          value={paste}
          onChange={(e) => {
            setPaste(e.target.value);
            setResult(null);
          }}
          placeholder={t("粘贴对方的邀请串，一步完成")}
          rows={2}
          className="textarea textarea-bordered w-full font-mono text-[10px] leading-tight"
        />
        {msg && <div className="text-xs text-error">{msg}</div>}
        {result?.ok && (
          <div className="text-xs text-success">
            {t("已接入")} 「{result.peer}」
            {Array.isArray(result.remoteAgents) && result.remoteAgents.length > 0 && (
              <span className="text-base-content/60">
                {" · "}
                {t("可访问：")}
                {/* join-auto 的 remoteAgents 是 string[]（redeem 响应的 scope 名单） */}
                {(result.remoteAgents as unknown as string[]).map((a) => String(a)).join(", ")}
              </span>
            )}
            <div className="mt-0.5 text-[11px] text-base-content/50">
              {t("默认未向对方开放你的 agent；需要对称访问就生成一张自己的邀请发回去。")}
            </div>
          </div>
        )}
        {!!paste.trim() && !result?.ok && (
          <div className="flex justify-end">
            <button className="btn btn-primary btn-sm" disabled={busy} onClick={() => void submit()}>
              {busy ? <span className="loading loading-spinner loading-xs" /> : t("加入")}
            </button>
          </div>
        )}
      </div>
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
  // 本机对外地址候选（Bridge 探测，Tailscale 优先）——握手时预填「我的地址」，
  // 免得手抄 IP 抄错、或者填成 127.0.0.1（对方永远连不上，且要到 test 才暴露）
  const [suggestedUrls, setSuggestedUrls] = useState<SuggestedUrl[]>([]);
  const [pendingInvites, setPendingInvites] = useState<PendingInviteInfo[]>([]);

  const reload = useCallback(async () => {
    setErr("");
    try {
      const res = await fetch("/api/peers");
      const j = (await res.json()) as { ok?: boolean; error?: string; peers?: PeerInfo[]; localAgents?: LocalAgent[]; suggestedUrls?: SuggestedUrl[]; pendingInvites?: PendingInviteInfo[] };
      if (j.ok) {
        setPeers(j.peers || []);
        setLocalAgents(j.localAgents || []);
        setSuggestedUrls(j.suggestedUrls || []);
        setPendingInvites(j.pendingInvites || []);
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
  }, [open, reload]);

  if (!open) return null;

  return createPortal(
    // stopPropagation:本弹窗从设置弹窗内 portal 出来,React 合成事件沿 React 树
    // 冒泡——不拦的话点遮罩会连设置弹窗一起关掉
    <div
      className="overlay-in fixed inset-0 z-[90] grid place-items-center bg-black/50 p-4"
      onClick={(e) => {
        e.stopPropagation();
        onClose();
      }}
    >
      <div
        className="panel-pop flex max-h-[88dvh] w-full max-w-md flex-col rounded-2xl bg-base-100 shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
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
              {peers.map((p) => (
                <PeerCard key={p.name} peer={p} localAgents={localAgents} onChanged={() => void reload()} />
              ))}
              {peers.length === 0 && !err && (
                <div className="py-2 text-center text-xs text-base-content/40">
                  {t("暂无 peer。生成邀请发给对方，或粘贴对方的邀请加入。")}
                </div>
              )}
              <PendingInvites invites={pendingInvites} onChanged={() => void reload()} />
              <InvitePanel localAgents={localAgents} suggestedUrls={suggestedUrls} onChanged={() => void reload()} />
              <JoinPanel onChanged={() => void reload()} />
            </>
          )}
        </div>
      </div>
    </div>,
    document.body
  );
}
