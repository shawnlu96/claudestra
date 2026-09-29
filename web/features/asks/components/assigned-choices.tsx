"use client";
/**
 * 指派给人的事项（bridge/human-node.ts 开的 kind assigned）的作答区：「完成」可写说明、附图；「做不了」要写原因。
 * 图先传到 talk 附件库，作答带 [{kind:"talk", ref:sha, mime}]（「待你处理」只收 kind / ref / name / mime）；bridge 只把作答人自己
 * 能用的图挂到这条 ask 上。说明和图只进台账，PM 收到的只有任务号和结果。按钮 id 与 src/lib/human-node.ts 的 ASSIGN_DONE / ASSIGN_CANT 一致。
 */
import { useRef, useState } from "react";
import { AuthImg } from "@/features/chat/components/auth-img";
import { IMAGE_ACCEPT, PendingStrip, usePendingImages } from "@/features/talk/pending-images";
import { ImageIcon } from "@/features/talk/talk-icons";
import { attUrl } from "@/lib/api/talk";
import type { WebComponentRow } from "@/lib/chat/events";
import { useT } from "@/lib/i18n";
import type { WebAsk, WebAskAtt } from "../asks-model";

const ASSIGN_DONE = "assign_done";
const ASSIGN_CANT = "assign_cant";
const MAX_IMAGES = 9;

/** human 节点开的指派（带「完成」按钮）才用这块；手工开的指派照普通卡片答 */
export const isHumanNodeAsk = (a: Pick<WebAsk, "kind" | "options">): boolean =>
  a.kind === "assigned" && (a.options as WebComponentRow[]).some((r) => r.type === "buttons" && r.buttons.some((b) => b.id === ASSIGN_DONE));

/** bridge 的指派门拒掉的（整笔没记，src/bridge/human-node.ts 的 AskRejected code）：给一句人话；别的返回 null，照卡片原来的说法 */
export function assignedRejectText(code: string | undefined, t: ReturnType<typeof useT>): string | null {
  if (code === "assign_stale" || code === "assign_conflict") return t("这条指派已过时（改派了、阶段变了或重开过），已撤下");
  if (code === "assign_forbidden") return t("只有被指派的人或 owner 能作答");
  if (code === "reason_required") return t("做不了要写一下原因");
  return code === "answerer_unknown" || code === "ledger_unavailable" ? t("这次没记下，稍后再试") : null;
}

export function AssignedChoices({ busy, onAnswer }: { busy: boolean; onAnswer: (wire: string, text: string, atts: WebAskAtt[]) => void }) {
  const t = useT();
  const [text, setText] = useState("");
  const [needReason, setNeedReason] = useState(false);
  const imgs = usePendingImages(MAX_IMAGES);
  const fileRef = useRef<HTMLInputElement>(null);
  const atts = imgs.uploaded.map((a): WebAskAtt => ({ kind: "talk", ref: a.sha256, mime: a.mime }));
  const note = text.trim();
  const cant = () => (note ? onAnswer(`[button:${ASSIGN_CANT}]`, note, atts) : setNeedReason(true));
  return (
    <div className="flex flex-col gap-2">
      <textarea
        value={text}
        onChange={(e) => (setText(e.target.value), setNeedReason(false))}
        rows={3}
        maxLength={4000}
        placeholder={t("做完了写几句说明；做不了写原因")}
        className="textarea textarea-sm w-full resize-none bg-base-200/60 text-[13px]"
      />
      {needReason && <p className="text-[12px] text-warning">{t("做不了要写一下原因")}</p>}
      <PendingStrip atts={imgs.atts} onRemove={imgs.remove} />
      <div className="flex flex-wrap items-center gap-2">
        <button type="button" disabled={busy || !imgs.ready} className="btn btn-success btn-sm" onClick={() => onAnswer(`[button:${ASSIGN_DONE}]`, note, atts)}>
          {t("完成")}
        </button>
        <button type="button" disabled={busy || !imgs.ready} className="btn btn-ghost btn-sm border border-base-content/15" onClick={cant}>
          {t("做不了")}
        </button>
        <button
          type="button"
          className="btn btn-ghost btn-sm btn-square ml-auto"
          aria-label={t("附图")}
          title={t("附图")}
          disabled={busy || imgs.atts.length >= MAX_IMAGES}
          onClick={() => fileRef.current?.click()}
        >
          <ImageIcon size={16} />
        </button>
        <input ref={fileRef} type="file" accept={IMAGE_ACCEPT} multiple hidden onChange={(e) => (imgs.add(e.target.files), (e.target.value = ""))} />
      </div>
    </div>
  );
}

/** 作答附的图（已结案的卡片也显示）：只认 talk 附件库的；bridge 按「上传者本人 / 看得见这条 ask」放行 */
export function AnswerImages({ atts }: { atts?: WebAskAtt[] }) {
  const refs = (atts ?? []).filter((a) => a.kind === "talk").map((a) => a.ref);
  if (!refs.length) return null;
  return (
    <div className="mt-2 flex flex-wrap gap-2">
      {refs.map((ref) => (
        <AuthImg key={ref} src={attUrl(ref)} alt="" className="h-16 w-16 rounded-lg border border-base-300 object-cover" />
      ))}
    </div>
  );
}
