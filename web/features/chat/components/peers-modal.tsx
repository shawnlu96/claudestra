"use client";
import { useCallback, useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { useT } from "@/lib/i18n";

/**
 * HTTP peer 管理弹窗（设置 → Peer 协作 → 管理）：
 * - 列表:每个 peer 的握手状态 / 对方可访问我哪些 agent(入站 scope,可编辑) /
 *   我在对方那边可访问哪些 agent(出站,测试连通实时拉)
 * - 三步握手(邀请 / 加入 / 回执)全部可在 UI 完成,串走任意私聊渠道
 * - 移除 = 立即吊销对方 token
 * R1 校验(未标 external / master / "*")在 manager 侧,UI 收到 --force 提示后
 * 弹「强制执行」二次确认——服务端是唯一裁判,前端不复刻规则。
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
  const toggleStar = () =>
    onChange(star ? sel.filter((x) => x !== "*") : ["*", ...sel.filter((x) => x === "master")]);
  return (
    <div className="max-h-44 space-y-1 overflow-y-auto rounded-lg border border-base-300 bg-base-100 p-2">
      <label className="flex cursor-pointer items-center gap-2 text-sm">
        <input type="checkbox" className="checkbox checkbox-xs" checked={star} onChange={toggleStar} />
        <span>{t("全部普通 agent（*）")}</span>
        <span className="text-[10px] text-warning">{t("⚠ 不含 master")}</span>
      </label>
      <label className="flex cursor-pointer items-center gap-2 text-sm">
        <input
          type="checkbox"
          className="checkbox checkbox-xs"
          checked={sel.includes("master")}
          onChange={() => toggle("master")}
        />
        <span>master</span>
        <span className="text-[10px] text-error">{t("⚠ 大总管，风险极高")}</span>
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

/** 新增 peer：三步握手（邀请方 invite → 对方 join → 邀请方 accept 回执） */
function AddPeerPanel({
  localAgents,
  suggestedUrls,
  awaitingPeers,
  onChanged,
}: {
  localAgents: LocalAgent[];
  suggestedUrls: SuggestedUrl[];
  awaitingPeers: string[];
  onChanged: () => void;
}) {
  const t = useT();
  const [mode, setMode] = useState<"invite" | "join" | "accept" | null>(null);
  const [name, setName] = useState("");
  const [url, setUrl] = useState("");
  const [sel, setSel] = useState<string[]>([]);
  const [paste, setPaste] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState("");
  const [forceKind, setForceKind] = useState<"" | "force" | "rotate">("");
  const [result, setResult] = useState<ActionResult | null>(null);

  useEffect(() => {
    if (mode) {
      setMsg("");
      setForceKind("");
      setResult(null);
      setPaste("");
      try {
        // 上次填过就沿用；第一次用就拿 Bridge 探测到的地址预填（Tailscale 优先）
        setUrl(localStorage.getItem(MY_URL_KEY) || suggestedUrls[0]?.url || "");
      } catch {}
      if (mode === "accept" && awaitingPeers.length && !name) setName(awaitingPeers[0]);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode]);

  const submit = async (extra: { force?: boolean; rotate?: boolean } = {}) => {
    setBusy(true);
    setMsg("");
    try {
      localStorage.setItem(MY_URL_KEY, url.trim());
    } catch {}
    const base: Record<string, unknown> = { action: mode, name: name.trim(), ...extra };
    if (mode === "invite") Object.assign(base, { agents: sel, url: url.trim() });
    if (mode === "join") Object.assign(base, { agents: sel, url: url.trim(), invite: paste.trim() });
    if (mode === "accept") Object.assign(base, { receipt: paste.trim() });
    const r = await peersAction(base);
    setBusy(false);
    if (r.ok) {
      setResult(r);
      setForceKind("");
      setMsg("");
      onChanged();
    } else if ((r.error || "").includes("--force")) {
      setForceKind("force");
      setMsg(r.error || "");
    } else if ((r.error || "").includes("--rotate")) {
      setForceKind("rotate");
      setMsg(r.error || "");
    } else {
      setMsg(r.error || t("操作失败"));
    }
  };

  const inputCls = "input input-bordered input-sm w-full font-mono text-xs";
  const needScope = mode === "invite" || mode === "join";
  const canSubmit =
    !!name.trim() &&
    (mode === "accept" ? !!paste.trim() : sel.length > 0 && !!url.trim()) &&
    (mode !== "join" || !!paste.trim());

  return (
    <section className="rounded-xl bg-base-200/60 p-4">
      <div className="flex items-center justify-between">
        <span className="text-[13.5px] font-semibold">{t("添加 peer")}</span>
        <div className="join">
          {(
            [
              ["invite", t("邀请")],
              ["join", t("加入")],
              ["accept", t("回执")],
            ] as const
          ).map(([v, label]) => (
            <button
              key={v}
              className={`btn btn-xs join-item ${mode === v ? "btn-primary" : "btn-ghost border-base-300"}`}
              onClick={() => setMode(mode === v ? null : v)}
            >
              {label}
            </button>
          ))}
        </div>
      </div>
      {!mode && (
        <p className="mt-0.5 text-xs leading-relaxed text-base-content/50">
          {t("我方发起选「邀请」；拿到对方邀请串选「加入」；对方回执串回来后选「回执」完成。")}
        </p>
      )}
      {mode && (
        <div className="mt-3 space-y-2">
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder={t("peer 名（字母/数字/-/_）")}
            maxLength={32}
            autoComplete="off"
            className={inputCls}
            list={mode === "accept" ? "cstra-awaiting-peers" : undefined}
          />
          {mode === "accept" && (
            <datalist id="cstra-awaiting-peers">
              {awaitingPeers.map((p) => (
                <option key={p} value={p} />
              ))}
            </datalist>
          )}
          {mode !== "accept" && (
            <input
              type="text"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              placeholder={t("我方 bridge 地址（http://100.x.y.z:3847）")}
              autoComplete="off"
              className={inputCls}
            />
          )}
          {(mode === "join" || mode === "accept") && (
            <textarea
              value={paste}
              onChange={(e) => setPaste(e.target.value)}
              placeholder={mode === "join" ? t("粘贴对方的邀请串") : t("粘贴对方的回执串")}
              rows={3}
              className="textarea textarea-bordered w-full font-mono text-[10px] leading-tight"
            />
          )}
          {needScope && (
            <div>
              <div className="mb-1 text-xs text-base-content/60">{t("向对方开放的 agent")}</div>
              <ScopePicker localAgents={localAgents} sel={sel} onChange={setSel} />
            </div>
          )}
          {forceKind && msg ? (
            <ForceRow
              msg={msg}
              busy={busy}
              onForce={() => void submit(forceKind === "force" ? { force: true } : { rotate: true })}
              forceLabel={forceKind === "force" ? "确认风险，强制执行" : "确认轮换 token"}
            />
          ) : (
            msg && <div className="text-xs text-error">{msg}</div>
          )}
          {result?.invite && <HandshakeString label={t("邀请串（发给对方）")} value={result.invite} />}
          {result?.receipt && <HandshakeString label={t("回执串（发回对方）")} value={result.receipt} />}
          {result && mode === "accept" && (
            <div className="text-xs text-success">{t("握手完成，可在上方卡片测试连通。")}</div>
          )}
          {!!result?.warnings?.length && (
            <div className="text-[11px] text-warning">{result.warnings.join(" · ")}</div>
          )}
          {!result && (
            <div className="flex justify-end">
              <button className="btn btn-primary btn-sm" disabled={busy || !canSubmit} onClick={() => void submit()}>
                {busy ? (
                  <span className="loading loading-spinner loading-xs" />
                ) : mode === "invite" ? (
                  t("生成邀请串")
                ) : mode === "join" ? (
                  t("生成回执串")
                ) : (
                  t("完成握手")
                )}
              </button>
            </div>
          )}
        </div>
      )}
    </section>
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

  const reload = useCallback(async () => {
    setErr("");
    try {
      const res = await fetch("/api/peers");
      const j = (await res.json()) as { ok?: boolean; error?: string; peers?: PeerInfo[]; localAgents?: LocalAgent[]; suggestedUrls?: SuggestedUrl[] };
      if (j.ok) {
        setPeers(j.peers || []);
        setLocalAgents(j.localAgents || []);
        setSuggestedUrls(j.suggestedUrls || []);
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
                  {t("暂无 peer。用下方「邀请」或「加入」发起握手。")}
                </div>
              )}
              <AddPeerPanel
                localAgents={localAgents}
                suggestedUrls={suggestedUrls}
                awaitingPeers={peers.filter((p) => !p.handshakeDone).map((p) => p.name)}
                onChanged={() => void reload()}
              />
            </>
          )}
        </div>
      </div>
    </div>,
    document.body
  );
}
