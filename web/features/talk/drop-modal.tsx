"use client";
/**
 * 丢进工作台：选一个 agent → bridge 生成预览（就是 agent 会收到的原文，含 Web 用户抬头，逐字一致）→ 确认。
 * dropId 在打开弹窗时生成一次：连点、网络重试都用同一个，bridge 只投一次。内容在预览之后变了（有人删了消息、改了名字）
 * bridge 回 409，这里自动重新预览，让人再确认一次。目标忙或不在线时进押后队列，空闲后送达，不会丢。
 */
import { useEffect, useRef, useState } from "react";
import { useT } from "@/lib/i18n";
import { commitDrop, dropTargets, previewDrop, type TalkDrop, type TalkRoom } from "@/lib/api/talk";
import { ResponsiveShell } from "@/features/chat/components/responsive-shell";
import { CloseIcon, DropIcon } from "./talk-icons";

type Preview = { content: string; sha: string; agent: string };

export function DropModal({ room, msgs, onClose }: { room: TalkRoom; msgs: string[]; onClose: (done: boolean) => void }) {
  const t = useT();
  const [targets, setTargets] = useState<{ name: string; label: string }[] | null>(null);
  const [agent, setAgent] = useState<string>("");
  const [preview, setPreview] = useState<Preview | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<TalkDrop | null>(null);
  const dropId = useRef(`td_${crypto.randomUUID()}`);

  useEffect(() => {
    dropTargets().then(setTargets, (e) => setNote((e as Error).message));
  }, []);

  const load = async (name: string) => {
    setAgent(name);
    setPreview(null);
    setNote(null);
    try {
      setPreview(await previewDrop({ room: room.key, msgs, agent: name }));
    } catch (e) {
      setNote((e as Error).message);
    }
  };

  const confirm = async () => {
    if (!preview || busy) return;
    setBusy(true);
    try {
      const r = await commitDrop({ room: room.key, msgs, agent: preview.agent, dropId: dropId.current, sha: preview.sha });
      setResult(r.drop);
    } catch (e) {
      if ((e as { status?: number }).status === 409 && /stale/.test((e as Error).message)) {
        setNote(t("内容在预览之后变了，已重新生成预览，请再确认一次。"));
        await load(preview.agent);
      } else setNote((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const retry = () => {
    dropId.current = `td_${crypto.randomUUID()}`;
    setResult(null);
    void load(agent);
  };

  const label = targets?.find((x) => x.name === agent)?.label ?? agent;
  return (
    <ResponsiveShell onClose={() => onClose(!!result && result.state !== "failed")} panelClass="sm:max-w-2xl">
      <header className="flex shrink-0 items-center gap-2 border-b border-base-300 px-4 pb-3" style={{ paddingTop: "calc(env(safe-area-inset-top) + 0.75rem)" }}>
        <DropIcon size={18} />
        <h2 className="flex-1 font-semibold">{t("丢进工作台 · {n} 条消息", { n: msgs.length })}</h2>
        <button className="btn btn-ghost btn-sm btn-square" aria-label={t("关闭")} onClick={() => onClose(!!result && result.state !== "failed")}>
          <CloseIcon size={18} />
        </button>
      </header>
      <div className="min-h-0 flex-1 space-y-3 overflow-y-auto p-4">
        {result ? (
          <DropResult result={result} label={label} onRetry={retry} />
        ) : (
          <DropForm targets={targets} agent={agent} label={label} note={note} preview={preview} onPick={(name) => void load(name)} />
        )}
      </div>
      {!result && (
        <footer className="flex shrink-0 justify-end gap-2 border-t border-base-300 px-4 pt-3" style={{ paddingBottom: "max(env(safe-area-inset-bottom), 0.75rem)" }}>
          <button className="btn btn-ghost btn-sm" onClick={() => onClose(false)}>{t("取消")}</button>
          <button className="btn btn-primary btn-sm" disabled={!preview || busy} onClick={() => void confirm()}>
            {busy ? t("正在交…") : t("确认丢进工作台")}
          </button>
        </footer>
      )}
    </ResponsiveShell>
  );
}

function DropResult({ result, label, onRetry }: { result: TalkDrop; label: string; onRetry: () => void }) {
  const t = useT();
  return (
    <div className={`rounded-xl p-4 ${result.state === "failed" ? "bg-error/10" : "bg-success/10"}`}>
      {result.state === "sent" && <p>{t("已交给 {a}。它会以你的身份看到这几条消息。", { a: label })}</p>}
      {result.state === "held" && <p>{t("{a} 正在忙或不在线，已进押后队列，空闲后送达，不会丢。", { a: label })}</p>}
      {result.state === "failed" && (
        <>
          <p>{t("没送到：{e}", { e: result.error ?? "" })}</p>
          <button className="btn btn-sm mt-2" onClick={onRetry}>{t("重发")}</button>
        </>
      )}
    </div>
  );
}

function DropForm({ targets, agent, label, note, preview, onPick }: {
  targets: { name: string; label: string }[] | null; agent: string; label: string; note: string | null; preview: Preview | null; onPick: (name: string) => void;
}) {
  const t = useT();
  return (
    <>
      <label className="block text-sm text-base-content/70">{t("交给哪个 agent（只列你能用的）")}</label>
      {targets === null ? (
        <p className="text-sm text-base-content/50">{t("加载中…")}</p>
      ) : targets.length === 0 ? (
        <p className="text-sm text-base-content/60">{t("这台设备没有可用的 agent。")}</p>
      ) : (
        <select className="select select-bordered select-sm w-full" value={agent} onChange={(e) => onPick(e.target.value)}>
          <option value="" disabled>{t("选择 agent")}</option>
          {targets.map((a) => <option key={a.name} value={a.name}>{a.label}</option>)}
        </select>
      )}
      {note && <p className="text-sm text-warning">{note}</p>}
      {preview && (
        <>
          <p className="text-sm text-base-content/70">{t("{a} 会收到下面这段原文（只有勾选的几条，没有其余聊天记录）：", { a: label })}</p>
          <pre className="max-h-[45dvh] overflow-auto whitespace-pre-wrap break-words rounded-xl bg-base-200 p-3 font-mono text-xs leading-relaxed" data-drop-preview>
            {preview.content}
          </pre>
        </>
      )}
    </>
  );
}
