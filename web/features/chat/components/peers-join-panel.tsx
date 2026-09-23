"use client";
import { useState } from "react";
import { useT } from "@/lib/i18n";
import { ForceRow, peersAction, ScopePicker, type ActionResult, type LocalAgent } from "./peers-shared";

/**
 * 粘贴对方的邀请串，一步接入。
 *
 * 默认单向（对方只开放给我）；勾「同时向对方开放我的 agent」就在同一次加入里把我方的 agent
 * 也开放给对方（后端 peer-join-auto --agents，兑换时把我方地址和 token 一并交给对方）——
 * 以前要对称访问得再反向发一张邀请。失败时显示服务端给的下一步（超时 / 被拒 / 邀请失效
 * 各说各的，见 src/lib/peer-join-hints.ts），而不是一句「timed out」。
 */
export function JoinPanel({ localAgents, onChanged }: { localAgents: LocalAgent[]; onChanged: () => void }) {
  const t = useT();
  const [paste, setPaste] = useState("");
  const [busy, setBusy] = useState(false);
  const [fail, setFail] = useState<{ error: string; hint?: string } | null>(null);
  const [result, setResult] = useState<ActionResult | null>(null);
  const [twoWay, setTwoWay] = useState(false);
  const [sel, setSel] = useState<string[]>([]);

  // 反向开放没标 external 的 agent 时服务端要 --force（R1 共享上下文守卫），与生成邀请同一套二次确认
  const submit = async (force = false) => {
    setBusy(true);
    setFail(null);
    const r = await peersAction({ action: "join-auto", invite: paste.trim(), ...(twoWay && sel.length ? { agents: sel, force } : {}) });
    setBusy(false);
    if (r.ok) {
      setResult(r);
      setPaste("");
      onChanged();
    } else {
      setFail({ error: r.error || t("操作失败"), hint: r.hint });
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
        {!result?.ok && (
          <label className="flex cursor-pointer items-center gap-2 text-xs">
            <input type="checkbox" className="checkbox checkbox-xs" checked={twoWay} onChange={(e) => setTwoWay(e.target.checked)} />
            <span>{t("同时向对方开放我的 agent（双向）")}</span>
          </label>
        )}
        {twoWay && !result?.ok && (
          <div>
            <ScopePicker localAgents={localAgents} sel={sel} onChange={setSel} />
            <div className="mt-1 text-[11px] leading-relaxed text-base-content/50">
              {t("对方要能连到你的 bridge 才用得上：你的机器要共享给对方，bridge 端口要对 tailnet 开放。")}
            </div>
          </div>
        )}
        {fail?.error.includes("--force") ? (
          <ForceRow msg={fail.error} busy={busy} onForce={() => void submit(true)} forceLabel="确认风险，强制执行" />
        ) : fail && (
          <div className="space-y-1 text-xs">
            <div className="text-error">{fail.error}</div>
            {fail.hint && <div className="leading-relaxed text-base-content/70">{fail.hint}</div>}
          </div>
        )}
        {result?.ok && <JoinSuccess result={result} />}
        {!!paste.trim() && !result?.ok && (
          <div className="flex justify-end">
            <button className="btn btn-primary btn-sm" disabled={busy || (twoWay && sel.length === 0)} onClick={() => void submit()}>
              {busy ? <span className="loading loading-spinner loading-xs" /> : t("加入")}
            </button>
          </div>
        )}
      </div>
    </section>
  );
}

function JoinSuccess({ result }: { result: ActionResult }) {
  const t = useT();
  const exposed = result.exposedAgents ?? [];
  return (
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
        {exposed.length
          ? `${t("已向对方开放：")}${exposed.join(", ")}`
          : t("默认未向对方开放你的 agent；需要对称访问就生成一张自己的邀请发回去。")}
      </div>
      {!!result.warnings?.length && <div className="mt-0.5 text-[11px] text-warning">{result.warnings.join(" · ")}</div>}
    </div>
  );
}
