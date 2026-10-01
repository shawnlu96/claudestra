"use client";
/**
 * 出借方管理面（设置 → Peer 协作）：授权列表 + 授权表单 + 借出中的单。数据来自 bridge GET /lend/grants，
 * 403 / 404（非 owner 本人全权凭据、或 bridge 太旧）整个面板不渲染。
 * 一键收回点一下就发、不二次确认；只在 bridge 回成功后才淡出这条授权、把这个 peer 的在跑单转成「停止中」，失败界面不动。
 * 有停止中的单就每 2 秒拉一次，单子在 journal 进终态才显示已停（lend-model.mergeOrders / orderPhase）。渲染里不读时钟：now 由计时器推进。
 */
import { useCallback, useEffect, useState } from "react";
import { useChatStoreApi } from "../chat/chat-store";
import { GrantForm } from "./grant-form";
import { fetchLend, postRevoke } from "./lend-api";
import { useLendT, useRemainingText } from "./lend-i18n";
import { LendIcon, type LendIconName } from "./lend-icons";
import {
  formDefaults, grantStatus, markStopping, mergeOrders, needsFastPoll, remainingMs, splitRemaining, STOPPING_POLL_MS, withSnapshot,
  type GrantForm as Form, type GrantStatus, type GrantView, type LendData, type OrderView,
} from "./lend-model";
import { LentOrders } from "./lent-orders";
import css from "./lend.module.css";

const IDLE_POLL_MS = 30_000;
const FADE_MS = 300;
const STATUS_ICON: Partial<Record<GrantStatus, { icon: LendIconName; cls: string }>> = {
  paused: { icon: "pause", cls: "text-warning" },
  expired: { icon: "clockAlert", cls: "text-error" },
  invalid: { icon: "circleAlert", cls: "text-error" },
};

function GrantRow({ g, now, fresh, leaving, busy, err, onRevoke, onRegrant }: {
  g: GrantView; now: number; fresh: boolean; leaving: boolean; busy: boolean; err: { msg: string; n: number } | null; onRevoke: () => void; onRegrant: () => void;
}) {
  const t = useLendT();
  const remainingText = useRemainingText();
  const status = grantStatus(g, now);
  const mark = STATUS_ICON[status];
  const left = remainingMs(g, now);
  const slots = Object.entries(g.families).map(([f, n]) => `${f} ${n}`).join(" · ");
  // 失败一次 n 加一：内层按 n 重挂，抖动动画每次都重新播
  return (
    <div className={leaving ? css.fadeOut : fresh ? css.fadeIn : ""}>
    <div key={err?.n ?? 0} className={`rounded-lg bg-base-100 px-3 py-2 ${err ? css.shake : ""}`}>
      <div className="flex items-center gap-2">
        {mark && (
          <span className={`flex shrink-0 ${mark.cls}`} title={g.paused ?? g.problem ?? ""} aria-label={g.paused ?? g.problem ?? ""}>
            <LendIcon name={mark.icon} size={14} />
          </span>
        )}
        <span className="min-w-0 flex-1 truncate text-sm font-medium">{g.peer}</span>
        {status === "paused" && (
          <button type="button" className="btn btn-ghost btn-xs gap-1" onClick={onRegrant}>
            <LendIcon name="rotateCcw" size={12} />{t("重新授权")}
          </button>
        )}
        <button type="button" className="btn btn-ghost btn-xs gap-1 text-error" disabled={busy || leaving} onClick={onRevoke}>
          {busy ? <span className="loading loading-spinner loading-xs" /> : <LendIcon name="undo2" size={12} />}{t("收回")}
        </button>
      </div>
      <div className="mt-0.5 flex flex-wrap gap-x-3 gap-y-0.5 text-[11px] text-base-content/50">
        <span className="font-mono">{g.repos.join(", ")}</span>
        <span>{slots} · {g.ordersPerDay}/d</span>
        {left !== null && <span className="tabular-nums">{left > 0 ? remainingText(splitRemaining(left)) : t("已到期")}</span>}
      </div>
      {err && <p className="mt-1 break-words text-[11px] text-error">{err.msg}</p>}
    </div>
    </div>
  );
}

export function LendPanel() {
  const t = useLendT();
  const store = useChatStoreApi();
  const [data, setData] = useState<LendData | null | undefined>(undefined);
  const [loadErr, setLoadErr] = useState("");
  const [view, setView] = useState<{ orders: OrderView[]; stopping: Map<string, number> }>({ orders: [], stopping: new Map() });
  const { orders, stopping } = view;
  const [now, setNow] = useState(0);
  const [form, setForm] = useState<Form | null>(null);
  const [fresh, setFresh] = useState<string | null>(null);
  const [leaving, setLeaving] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState<string | null>(null);
  const [revokeErr, setRevokeErr] = useState<{ peer: string; msg: string; n: number } | null>(null);

  const load = useCallback(async () => {
    try {
      const d = await fetchLend();
      setData(d);
      setLoadErr("");
      if (!d) return;
      setView((v) => mergeOrders(v.orders, d.orders, v.stopping));
    } catch (e) {
      setLoadErr(e instanceof Error ? e.message : String(e)); // 拉失败保持上一份数据：停止中的单不会被误显示成已停
    }
  }, []);

  const fast = needsFastPoll(stopping);
  useEffect(() => {
    void load();
    const iv = setInterval(() => void load(), fast ? STOPPING_POLL_MS : IDLE_POLL_MS);
    return () => clearInterval(iv);
  }, [load, fast]);
  useEffect(() => {
    setNow(Date.now());
    const iv = setInterval(() => setNow(Date.now()), fast ? 1_000 : IDLE_POLL_MS);
    return () => clearInterval(iv);
  }, [fast]);

  const revoke = async (peer: string) => {
    setBusy(peer);
    try {
      const r = await postRevoke(peer);
      const at = Date.now();
      const snap = r.orders ?? [];
      setRevokeErr(null);
      setView((v) => ({ orders: withSnapshot(v.orders, snap), stopping: markStopping(v.stopping, peer, snap, v.orders, at) }));
      setNow(at);
      setLeaving((s) => new Set(s).add(peer));
      setTimeout(() => {
        setData((d) => (d ? { ...d, grants: d.grants.filter((g) => g.peer !== peer) } : d));
        setLeaving((s) => { const n = new Set(s); n.delete(peer); return n; });
        void load();
      }, FADE_MS);
    } catch (e) {
      setRevokeErr((x) => ({ peer, msg: e instanceof Error ? e.message : String(e), n: (x?.n ?? 0) + 1 })); // 收回没成：授权和单子都保持原样
      void load(); // 请求本身断了（网页超时）时 bridge 可能已收回：以重拉的列表为准
    } finally {
      setBusy(null);
    }
  };

  if (!data) return loadErr && data === undefined ? <div className="px-1 text-xs text-error">{t("加载失败")}</div> : null;
  const openForm = (from?: GrantView) => setForm(formDefaults(data.maxDays, data.peers, from));
  return (
    <section className="space-y-3 rounded-xl bg-base-200/60 p-4">
      <div className="flex min-h-8 items-center justify-between gap-3">
        <span className="text-[13.5px] font-semibold">{t("出借")}</span>
        {!form && (
          <button type="button" className="btn btn-sm gap-1" onClick={() => openForm()}>
            <LendIcon name="plus" />{t("授权")}
          </button>
        )}
      </div>
      {form && (
        <GrantForm key={JSON.stringify(form)} peers={data.peers} maxDays={data.maxDays} shellSentence={data.shellSentence} initial={form}
          onCancel={() => setForm(null)} onFail={() => void load()} onDone={(peer) => { setForm(null); setFresh(peer); void load(); }} />
      )}
      <div className="space-y-1.5">
        {data.grants.map((g) => (
          <GrantRow key={g.peer} g={g} now={now} fresh={fresh === g.peer} leaving={leaving.has(g.peer)} busy={busy === g.peer}
            err={revokeErr?.peer === g.peer ? revokeErr : null} onRevoke={() => void revoke(g.peer)} onRegrant={() => openForm(g)} />
        ))}
        {!data.grants.length && !form && <div className="py-1 text-center text-xs text-base-content/40">{t("还没有授权")}</div>}
      </div>
      <div className="pt-1 text-[11px] font-semibold uppercase tracking-wider text-base-content/40">{t("借出中的单")}</div>
      <LentOrders orders={orders} stopping={stopping} now={now} onOpen={(agent) => void store.openAgent(agent)} />
      {loadErr && <p className="text-[11px] text-error">{loadErr}</p>}
    </section>
  );
}
