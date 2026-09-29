"use client";
import { useEffect, useState } from "react";
import { fleetAccess, requestCompact } from "@/lib/api/fleet";
import { useT } from "@/lib/i18n";
import type { AgentSession } from "../type";

type Req = { at: number; ok?: boolean; text?: string };

/** 这台设备能不能直接压缩（GET /fleet/access）：guest、部分 scope 的设备没有这个权限，按钮不显示；问到之前、问不到都不显示 */
export function useFleetAccess(): boolean {
  const [ok, setOk] = useState(false);
  useEffect(() => {
    let live = true;
    void fleetAccess().then((v) => live && setOk(v));
    return () => {
      live = false;
    };
  }, []);
  return ok;
}

/**
 * 输入框上方的上下文超标警示条（阈值对齐 ctx-level 深红档：1M 窗的 75%；只给 Claude Code，Codex 快满时自己压）。
 * 「请求压缩」走批量管理接口只压这一个 agent（执行者由 bridge 改成 compact）：成功就收起，10 分钟后仍超标再亮；
 * 失败把原因留在条上、可以再点；请求中不给点第二下（owner 2026-07-14 连点两下发了两条）。按 agent 记，✕ = 本会话不再提示。
 */
export function CtxWarnBanner({ agent }: { agent: AgentSession | undefined }) {
  const t = useT();
  const [dismissed, setDismissed] = useState("");
  const [reqs, setReqs] = useState<Record<string, Req>>({});
  const canCompact = useFleetAccess();
  if (!agent) return null;
  const name = agent.name;
  const ctx = typeof agent.contextTokens === "number" ? agent.contextTokens : 0;
  const r = reqs[name];
  // 读当前时间决定要不要提示。改成定时 tick 驱动才算"纯"，但那是为一个提示横幅常驻一个定时器；最坏就是横幅晚一轮渲染才出现/消失
  // eslint-disable-next-line react-hooks/purity
  const recentOk = r?.ok === true && Date.now() - r.at < 10 * 60_000;
  if ((agent.runtime ?? "claude-code") !== "claude-code" || ctx < 750_000 || dismissed === name || recentOk) return null;
  const pending = !!r && r.ok === undefined;
  const onCompact = () => {
    if (pending) return;
    setReqs((m) => ({ ...m, [name]: { at: Date.now() } }));
    void requestCompact(name).then((x) => setReqs((m) => ({ ...m, [name]: { at: Date.now(), ...x } })));
  };
  return (
    <div className="mb-1.5 flex items-center gap-2 rounded-xl border border-warning/30 bg-warning/10 px-3 py-1.5 text-xs">
      <span className="min-w-0 truncate">
        ⚠️ {r?.ok === false ? `${t("没压成")}：${t(r.text ?? "")}` : t("上下文已 {n}k——别等了,找个句号就存记忆 + Compact", { n: Math.round(ctx / 1000) })}
      </span>
      {canCompact && (
        <button className="btn btn-warning btn-xs ml-auto shrink-0" disabled={pending} onClick={onCompact}>
          {pending ? t("请求中…") : t("请求压缩")}
        </button>
      )}
      <button className={`shrink-0 px-1 opacity-40 hover:opacity-80 ${canCompact ? "" : "ml-auto"}`} aria-label={t("本会话不再提示")} onClick={() => setDismissed(name)}>
        ✕
      </button>
    </div>
  );
}
