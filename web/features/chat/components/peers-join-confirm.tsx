"use client";
/**
 * 加入确认卡（/join 页和 Peer 面板的「加入」共用）：拿到邀请码先检查一遍（peer-invite-inspect：能不能连到
 * 对方、加入后能找哪些 agent），连得上才让点「加入」；连不上直接给出下一步，不用点了才看到 timed out。
 * 「也让对方找我的 agent」= 同一次加入里反向开放（peer-join-auto --agents），不再要对方另发一张邀请。
 */
import { useEffect, useState } from "react";
import { useT } from "@/lib/i18n";
import { ForceRow, peersAction, ScopePicker, type LocalAgent } from "./peers-shared";

type Inspect = { ok?: boolean; error?: string; name?: string; reachable?: boolean; agents?: string[]; hint?: string; existing?: string };
type Joined = { ok?: boolean; peer?: string; error?: string; hint?: string; warnings?: string[] };

export function JoinConfirm({ code, onJoined }: { code: string; onJoined?: (peer: string) => void }) {
  const t = useT();
  const [info, setInfo] = useState<Inspect | null>(null);
  const [round, setRound] = useState(0);
  const [twoWay, setTwoWay] = useState(false);
  const [localAgents, setLocalAgents] = useState<LocalAgent[]>([]);
  const [sel, setSel] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<Joined | null>(null);

  useEffect(() => {
    let live = true;
    void peersAction({ action: "inspect", invite: code }).then((r) => live && setInfo(r as Inspect));
    return () => {
      live = false;
    };
  }, [code, round]);

  // 反向开放要勾本机 agent：勾选框第一次打开时才拉本机 agent 列表
  useEffect(() => {
    if (!twoWay || localAgents.length) return;
    void fetch("/api/peers")
      .then((r) => r.json())
      .then((j: { localAgents?: LocalAgent[] }) => setLocalAgents(j.localAgents || []))
      .catch(() => setLocalAgents([])); // 拉不到就是空列表，勾选器显示「无」，不影响单向加入
  }, [twoWay, localAgents.length]);

  const join = async (force = false) => {
    setBusy(true);
    const r = (await peersAction({ action: "join-auto", invite: code, ...(twoWay && sel.length ? { agents: sel, force } : {}) })) as Joined;
    setBusy(false);
    setDone(r);
    if (r.ok && r.peer) onJoined?.(r.peer);
  };

  const name = info?.name || t("对方");
  if (done?.ok) return <JoinedView done={done} />;
  return (
    <div className="space-y-2.5 text-[13px]">
      <div className="text-[15px] font-semibold">{`${name} ${t("邀请你一起协作")}`}</div>
      <InspectStatus info={info} onRetry={() => { setInfo(null); setRound((n) => n + 1); }} />
      {info?.reachable && (
        <>
          <label className="flex cursor-pointer items-center gap-2 text-xs">
            <input type="checkbox" className="checkbox checkbox-xs" checked={twoWay} onChange={(e) => setTwoWay(e.target.checked)} />
            <span>{`${t("也让")} ${name} ${t("找我的 agent")}`}</span>
          </label>
          {twoWay && <ScopePicker localAgents={localAgents} sel={sel} onChange={setSel} />}
          {done && !done.ok && (done.error || "").includes("--force") ? (
            <ForceRow msg={done.error || ""} busy={busy} onForce={() => void join(true)} forceLabel="确认风险，强制执行" />
          ) : done && !done.ok ? (
            <div className="space-y-1 text-xs">
              <div className="text-error">{done.error}</div>
              {done.hint && <div className="leading-relaxed text-base-content/70">{done.hint}</div>}
            </div>
          ) : null}
          <button className="btn btn-primary btn-sm w-full" disabled={busy || (twoWay && sel.length === 0)} onClick={() => void join()}>
            {busy ? <span className="loading loading-spinner loading-xs" /> : t("加入")}
          </button>
        </>
      )}
    </div>
  );
}

function JoinedView({ done }: { done: Joined }) {
  const t = useT();
  return (
    <div className="space-y-1 text-[13px]">
      <div className="font-semibold text-success">✓ {t("已加入")}「{done.peer}」</div>
      <div className="text-xs text-base-content/60">{t("现在你的 agent 可以直接找对方开放给你的 agent 了。")}</div>
      {!!done.warnings?.length && <div className="text-[11px] text-warning">{done.warnings.join(" · ")}</div>}
    </div>
  );
}

/** 加入前的检查结果：检查中 / 邀请无效 / 能连上（能找谁）/ 连不上（原因 + 复制说明 + 再测） */
function InspectStatus({ info, onRetry }: { info: Inspect | null; onRetry: () => void }) {
  const t = useT();
  const [copied, setCopied] = useState(false);
  return (
    <>
    {!info ? (
      <div className="flex items-center gap-2 text-xs text-base-content/60">
        <span className="loading loading-spinner loading-xs" />
        {t("正在检查能不能连到对方…")}
      </div>
    ) : !info.ok ? (
      <div className="text-xs text-error">{info.error}</div>
    ) : info.reachable ? (
      <div className="space-y-0.5 text-xs">
        <div className="text-success">✓ {t("能连到对方")}</div>
        <div className="text-base-content/70">
          {info.agents?.length ? `${t("加入后你可以找")}: ${info.agents.join(", ")}` : t("对方还没开放任何 agent 给你")}
        </div>
        {info.existing && <div className="text-base-content/50">{`${t("你已经连着")}「${info.existing}」${t("，加入会刷新这条连接")}`}</div>}
      </div>
    ) : (
      <div className="space-y-1 text-xs">
        <div className="text-error">✗ {t("连不上对方")}</div>
        {info.hint && <div className="leading-relaxed text-base-content/70">{info.hint}</div>}
        <div className="flex gap-2">
          <button className="btn btn-ghost btn-xs" onClick={onRetry}>{t("再测一次")}</button>
          {info.hint && (
            <button
              className="btn btn-ghost btn-xs"
              onClick={() => void navigator.clipboard?.writeText(info.hint!).then(() => setCopied(true))}
            >
              {copied ? t("已复制") : t("复制这段说明")}
            </button>
          )}
        </div>
      </div>
    )}
    </>
  );
}
