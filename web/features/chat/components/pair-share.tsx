"use client";
/**
 * 在网页里把这台电脑分享给一台新设备（设置 · 设备「添加设备」与 Peer 面板中继卡共用）：
 *   PairCodeCard  二维码 + 短码 + 链接（复制 / 系统分享），码有效期内每 3 秒看一次：有人手输了这个短码就就地「允许 / 拒绝」，
 *                 码被扫码用掉了就显示「已配好」——不用再去电脑终端里确认
 *   ApprovalRow   一条待确认的配对请求（全局横幅 pair-approval-banner.tsx 也用）
 * 数据：POST /api/v1/relay/pair 签码，GET/POST /api/v1/devices/approvals 看与批（都要 manage）。
 */
import { useEffect, useRef, useState } from "react";
import { renderSVG } from "uqr";
import { getLang, useT } from "@/lib/i18n";
import { decideApproval, grantsAllAgents, GUEST_ALL_WARNING, listApprovals, listDevices, type PendingApproval, type ShareCode } from "@/lib/api/devices";
import { fmtRemaining, remainingSeconds } from "../relay-card-logic";
import { CopyButton } from "./peers-shared";

const POLL_MS = 3000;
/** 一处批了 / 拒了，另一处（侧栏横幅 ↔ 添加设备卡片）立刻重查，不等下一拍 */
export const APPROVALS_CHANGED = "cstra:pair-approvals";

/** 「全部会话、终端、管理」/「给 Alex：gc-car、relay」：让批准的人知道自己在给什么 */
export function grantSummary(t: (k: string, params?: Record<string, string | number>) => string, grant: PendingApproval["grant"], guest?: string): string {
  const agents = grant.agents === "*" || grant.agents.includes("*") ? t("全部会话") : grant.agents.filter((a) => a !== "master").join("、");
  const extras = [grant.terminal ? t("终端") : "", grant.manage ? t("管理") : ""].filter(Boolean).join("、");
  const scope = extras ? `${agents}、${extras}` : agents;
  return guest ? t("给 {guest}：{scope}", { guest, scope }) : scope;
}

export function ApprovalRow({ a, onDone }: { a: PendingApproval; onDone: (approved: boolean) => void }) {
  const t = useT();
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const decide = async (approve: boolean) => {
    setBusy(true);
    setErr("");
    try {
      await decideApproval(a.id, approve);
      onDone(approve);
      window.dispatchEvent(new Event(APPROVALS_CHANGED));
    } catch (e) {
      setErr((e as Error).message);
      setBusy(false);
    }
  };
  return (
    <div className="flex flex-wrap items-center gap-2 rounded-lg bg-warning/10 px-2.5 py-2 text-xs">
      <span className="min-w-0 flex-1">
        <span className="block font-medium">
          {a.deviceName} {t("输入了短码")} <span className="font-mono">{a.code.slice(0, 4)}-{a.code.slice(4)}</span>
        </span>
        <span className="block truncate text-base-content/55">
          {grantSummary(t, a.grant, a.guest)}
          {a.clientIp ? ` · ${a.clientIp}` : ""}
        </span>
        {a.guest && grantsAllAgents(a.grant) && <span className="block font-medium text-warning">{t(GUEST_ALL_WARNING)}</span>}
        <span className="block text-[10.5px] text-base-content/45">{t("设备名是对方自己填的；短码对得上再允许")}</span>
        {err && <span className="block text-error">{err}</span>}
      </span>
      <span className="flex shrink-0 gap-1">
        <button className="btn btn-ghost btn-xs" disabled={busy} onClick={() => void decide(false)}>
          {t("拒绝")}
        </button>
        <button className="btn btn-primary btn-xs" disabled={busy} onClick={() => void decide(true)}>
          {busy ? <span className="loading loading-spinner loading-xs" /> : t("允许")}
        </button>
      </span>
    </div>
  );
}

/**
 * paired   新设备已经出现在设备列表里（扫码 / 点链接那条路：领凭据和配对是同一个请求）
 * approved 在这张卡上批准了手输短码的请求（凭据已签，对方页面下一次轮询才领走）
 * denied   在这张卡上拒绝了
 * gone     码已经不在了、也没人等批准、设备列表里又没找到新设备：可能被用掉、过期、或 bridge 重启丢了——不猜结果
 */
type Phase = "waiting" | "paired" | "approved" | "denied" | "gone";
/** 设备的 createdAt 是 Mac 的时钟、发码时刻是这台的：留两分钟余量，免得手机和电脑差几秒就认不出 */
const CLOCK_SLACK_MS = 120_000;

/**
 * 码有效期内每 3 秒看一次待确认与「没用掉的码」：手输了这个码的请求放进 pending；码不在了就去设备列表找发码之后
 * 新出现的设备，找到才说配好了，找不到只说码不在了（codex 复核：「码没了」不能当「配好了」）。onPaired 走 ref。
 */
function usePairWatch(code: string, expiresAt: string, onPaired?: () => void) {
  const [now, setNow] = useState(() => Date.now());
  const [issuedAt] = useState(() => Date.now());
  const [pending, setPending] = useState<PendingApproval[]>([]);
  const [phase, setPhase] = useState<Phase>("waiting");
  const [who, setWho] = useState("");
  const paired = useRef(onPaired);
  useEffect(() => {
    paired.current = onPaired; // 轮询闭包里用最新的回调，又不因父组件重渲染而重启轮询
  });
  const left = remainingSeconds(expiresAt, now);
  const expired = left === 0 && phase === "waiting";
  useEffect(() => {
    const iv = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(iv);
  }, []);
  useEffect(() => {
    if (phase !== "waiting" || expired) return;
    let stop = false;
    const settleGone = async () => {
      const fresh = (await listDevices()).filter((d) => Date.parse(d.createdAt) >= issuedAt - CLOCK_SLACK_MS && !d.current);
      if (stop) return;
      const newest = fresh.sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))[0];
      setWho(newest?.deviceName ?? "");
      setPhase(newest ? "paired" : "gone");
      paired.current?.();
    };
    const tick = () =>
      void listApprovals()
        .then(async ({ approvals, activeCodes }) => {
          if (stop) return;
          const mine = approvals.filter((a) => a.code === code);
          setPending(mine);
          if (activeCodes && !activeCodes.includes(code) && mine.length === 0) await settleGone();
        })
        .catch((e: Error) => console.warn("[pair] 查待确认失败，下一拍再试:", e.message));
    tick();
    const iv = setInterval(tick, POLL_MS);
    return () => {
      stop = true;
      clearInterval(iv);
    };
  }, [code, phase, expired, issuedAt]);
  const settle = (a: PendingApproval, ok: boolean) => {
    setPending((xs) => xs.filter((x) => x.id !== a.id));
    setWho(a.deviceName);
    setPhase(ok ? "approved" : "denied");
    if (ok) paired.current?.();
  };
  return { left, expired, pending, phase, who, settle };
}

function PairDone({ phase, who, busy, onAgain }: { phase: Phase; who: string; busy: boolean; onAgain: () => void }) {
  const t = useT();
  const text =
    phase === "paired" ? `${t("已配好：")}${who}`
      : phase === "approved" ? `${t("已批准：")}${who}`
        : phase === "denied" ? t("已拒绝这次配对")
          : t("这个码已经用不了了（被用掉或已失效），看下面的设备列表确认");
  return (
    <div className="mt-3 flex items-center justify-between gap-2 rounded-lg bg-base-100 p-3 text-xs">
      <span className={phase === "paired" || phase === "approved" ? "text-success" : "text-base-content/60"}>{text}</span>
      <button className="btn btn-ghost btn-xs" disabled={busy} onClick={onAgain}>
        {t("再配一台")}
      </button>
    </div>
  );
}

export function PairCodeCard({ pair, full, onAgain, busy, onPaired }: {
  pair: ShareCode;
  /** 全权码：提示「只发给自己」 */
  full: boolean;
  onAgain: () => void;
  busy: boolean;
  onPaired?: () => void;
}) {
  const t = useT();
  const { left, expired, pending, phase, who, settle } = usePairWatch(pair.code, pair.expiresAt, onPaired);
  if (phase !== "waiting") return <PairDone phase={phase} who={who} busy={busy} onAgain={onAgain} />;
  const canShare = typeof navigator !== "undefined" && typeof navigator.share === "function";
  const share = () =>
    void navigator.share({ title: t("配对 Claudestra"), text: t("10 分钟内打开这个链接，就能用这台电脑上的 Claudestra"), url: pair.link }).catch((e: Error) => {
      if (e.name !== "AbortError") console.warn("[pair] 系统分享失败:", e.message); // 用户关掉分享面板 = AbortError，不算错
    });
  return (
    <div className={`mt-3 rounded-lg bg-base-100 p-3 ${expired ? "opacity-60" : ""}`}>
      <div className="flex flex-col items-center gap-2 sm:flex-row sm:items-start sm:gap-4">
        <div className="w-36 shrink-0 rounded bg-white p-1 [&>svg]:h-auto [&>svg]:w-full" dangerouslySetInnerHTML={{ __html: renderSVG(pair.link) }} />
        <div className="min-w-0 flex-1 space-y-1.5 text-center sm:text-left">
          <div className="font-mono text-2xl tracking-[0.15em]">{pair.display}</div>
          <div className={`text-xs ${expired ? "text-error" : "text-base-content/60"}`}>
            {expired ? t("已过期，再生成一个") : `${t("剩余")} ${fmtRemaining(left, getLang())}`}
          </div>
          <div className="break-all font-mono text-[10.5px] leading-tight text-base-content/45">{pair.link}</div>
          <div className="flex flex-wrap justify-center gap-1 sm:justify-start">
            {canShare && !expired && (
              <button className="btn btn-primary btn-xs" onClick={share}>
                {t("分享…")}
              </button>
            )}
            <CopyButton text={pair.link} label="复制链接" />
            <button className="btn btn-ghost btn-xs" disabled={busy} onClick={onAgain}>
              {busy ? <span className="loading loading-spinner loading-xs" /> : t("再来一个")}
            </button>
          </div>
        </div>
      </div>
      {pending.length > 0 && (
        <div className="mt-2 flex flex-col gap-1.5">
          {pending.map((a) => (
            <ApprovalRow key={a.id} a={a} onDone={(ok) => settle(a, ok)} />
          ))}
        </div>
      )}
      <p className="mt-2 text-[11px] leading-relaxed text-base-content/50">
        {t("新设备扫码或打开链接就配好了；在配对页手输短码的，会在这里等你允许。10 分钟内有效，只能用一次。")}
        {full && ` ${t("拿到它的人就有这台电脑的全部权限，只发给你自己。")}`}
      </p>
    </div>
  );
}
