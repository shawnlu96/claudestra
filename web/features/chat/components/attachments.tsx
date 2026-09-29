"use client";
import { useRef, useState } from "react";
import type { ChatAttachmentView, ChatMessage } from "../type";
import type { MediaItem } from "@/lib/api/media";
import { useT } from "@/lib/i18n";
import { ATTACHMENT_API, isApiUrl } from "@/lib/chat/attachments";
import { useChatStoreApi } from "../chat-store";
import { openMediaViewer, openStaticViewer } from "../../media/media-viewer";
import { AuthImg } from "./auth-img";
import { AttachmentPreview, openAttachment, type PreviewState } from "./attachment-preview";
import { PaperclipIcon } from "./line-icons";

/* 气泡里的附件回显：图片缩略图（点开进大图查看器）/ 文件 chip（文本预览、手机分享、桌面下载）。
   附件在 bridge 的 /api/v1/attachments/<name>，要带设备凭据取（AuthImg 先 fetch 成 blob 再渲染；下载同理），token 永不进 URL。 */

/** 附件文件 chip（非图片 / 图片加载失败的降级）。有 url 可点开：怎么打开见 ./attachment-preview.tsx */
function FileChip({ a }: { a: ChatAttachmentView }) {
  const [layer, setLayer] = useState<PreviewState | null>(null);
  const [busy, setBusy] = useState(false);
  const seq = useRef(0); // 每次点开 / 关闭 +1：关掉之后才到的结果不再把层弹回来
  const cls =
    "flex max-w-[220px] items-center gap-2 rounded-[12px] border border-base-content/10 bg-base-300 px-3 py-2 text-[12.5px] text-base-content/80";
  if (!a.url) {
    return (
      <span title={a.name} className={cls}>
        <PaperclipIcon size={14} className="shrink-0 opacity-70" /> <span className="truncate">{a.name}</span>
      </span>
    );
  }
  const url = a.url;
  const open = (e: React.MouseEvent) => {
    if (!isApiUrl(url)) return; // blob: / data: 的让浏览器自己下
    e.preventDefault();
    if (busy) return;
    const mine = ++seq.current;
    setBusy(true);
    void openAttachment(url, a.name, (s) => {
      if (seq.current === mine) setLayer(s);
    }).finally(() => setBusy(false));
  };
  const close = () => {
    seq.current++;
    setLayer(null);
  };
  return (
    <>
      <a href={url} download={a.name} title={a.name} aria-busy={busy} className={`${cls} ${busy ? "opacity-60" : ""}`} onClick={open}>
        <PaperclipIcon size={14} className="shrink-0 opacity-70" /> <span className="truncate">{a.name}</span>
      </a>
      {layer && <AttachmentPreview name={a.name} state={layer} onClose={close} />}
    </>
  );
}

/** 图片附件：内联缩略图,点击全屏预览;加载失败(旧文件被清)降级为文件 chip。 */
function AttachedImage({ a, onPreview }: { a: ChatAttachmentView; onPreview: () => void }) {
  const [err, setErr] = useState(false);
  if (err || !a.url) return <FileChip a={a} />;
  return (
    <AuthImg
      src={a.url}
      alt={a.name}
      onClick={onPreview}
      onError={() => setErr(true)}
      className="max-h-52 max-w-[220px] cursor-zoom-in rounded-[12px] border border-base-content/10 object-cover"
    />
  );
}

/** 气泡里的附件地址 → 文件名（/api/v1/attachments/<name>?d=…）；媒体索引按它找到这张图 */
function fileNameOf(url: string): string | undefined {
  if (!url.startsWith(ATTACHMENT_API)) return undefined;
  try {
    return decodeURIComponent(url.slice(ATTACHMENT_API.length).split("?")[0]);
  } catch {
    return undefined; // 编码坏了：退回只看气泡里这几张
  }
}

/** msg：所在气泡（有 sid 的历史气泡能精确到那一条；直播气泡按名字找最新的一张）；align：聊天里的用户气泡靠右（默认），「待你处理」卡片里靠左 */
export function AttachmentStrip({ items, msg, align = "end" }: { items: ChatAttachmentView[]; msg?: ChatMessage; align?: "start" | "end" }) {
  const t = useT();
  const store = useChatStoreApi();
  const images = items.filter((a) => a.kind === "image" && a.url);

  // 大图查看器（features/media/media-viewer.ts）：从这张图起，左右翻本会话全部图片、翻到头自动往前加载；
  // 媒体索引里找不到（旧 bridge / 刚发还没进 jsonl）就只翻气泡里这几张
  const openViewer = async (index: number) => {
    const a = images[index];
    const agent = store.state.activeAgent;
    // 历史气泡（id = h<首 seq>，seqEnd = 尾 seq）按区间精确找；区间里没有就 404、退回只翻这几张，不会打开同名旧图
    const seqFrom = msg ? Number(/^h(\d+)/.exec(msg.id)?.[1]) : NaN;
    const seq = msg?.seqEnd ?? seqFrom;
    const anchor = { name: fileNameOf(a.url!), ...(msg?.sid && Number.isFinite(seqFrom) && Number.isFinite(seq) ? { session: msg.sid, seqFrom, seq } : {}) };
    const text = { t, onLocate: (it: MediaItem) => void store.jumpToContext(it.sessionId, it.seq) };
    if (agent && anchor.name && (await openMediaViewer({ agent }, anchor, text))) return;
    const slides = images.map((x) => ({ key: x.url!, url: x.url!, saveUrl: x.url!, name: x.name }));
    await openStaticViewer(slides, index, { t });
  };

  return (
    <div className={`flex max-w-[85%] flex-wrap gap-2 ${align === "start" ? "justify-start" : "justify-end"}`}>
      {items.map((a, i) =>
        a.kind === "image" ? (
          <AttachedImage key={i} a={a} onPreview={() => void openViewer(images.indexOf(a))} />
        ) : (
          <FileChip key={i} a={a} />
        ),
      )}
    </div>
  );
}
