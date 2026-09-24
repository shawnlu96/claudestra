"use client";
/**
 * Peer 弹窗顶部的「整理」提示：同一个对方散成了好几条旧记录（有实例 id 之前加入 / 被加入各记一条，
 * 撞名加 -2、-3），或者两个方向都已失效的空记录。计划由 bridge 算好（src/lib/peer-tidy.ts），
 * 这里只展示每组要做什么，点两次才执行——会吊销被取代的旧 token。
 */
import { useState } from "react";
import { useT } from "@/lib/i18n";
import { useArmedConfirm } from "../use-armed-confirm";
import { peersAction } from "./peers-shared";

export interface TidyGroupInfo {
  finalName: string;
  desc: string;
  skip?: string;
}

export function PeersTidyBanner({ groups, onDone }: { groups: TidyGroupInfo[]; onDone: () => void }) {
  const t = useT();
  const { armed, arm } = useArmedConfirm(4000);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState("");
  const todo = groups.filter((g) => !g.skip);
  if (!todo.length) return null;
  const run = async () => {
    if (!armed) return arm();
    setBusy(true);
    setMsg("");
    const r = await peersAction({ action: "tidy" });
    setBusy(false);
    if (r.ok) onDone();
    else setMsg(r.error || t("整理失败"));
  };
  return (
    <section className="rounded-xl border border-warning/40 bg-warning/10 p-3 text-[12px] leading-relaxed">
      <div className="flex items-center gap-2">
        <span className="font-semibold">{t("有重复或已失效的 peer 记录")}</span>
        <button className={`btn btn-xs ml-auto ${armed ? "btn-error" : "btn-warning"}`} disabled={busy} onClick={() => void run()}>
          {busy ? <span className="loading loading-spinner loading-xs" /> : armed ? t("确认整理?") : t("整理")}
        </button>
      </div>
      <ul className="mt-1.5 list-disc space-y-0.5 pl-4 text-base-content/70">
        {todo.map((g) => (
          <li key={g.finalName}>{g.desc}</li>
        ))}
      </ul>
      {msg && <div className="mt-1 text-error">{msg}</div>}
    </section>
  );
}
