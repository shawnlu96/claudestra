"use client";
import { useRef, useState } from "react";
import type { ChatAttachmentView } from "../type";
import { useT } from "@/lib/i18n";
import { isApiUrl } from "@/lib/chat/attachments";
import { AuthImg, fetchAuthBlob, resolvedAuthUrl, saveBlob } from "./auth-img";

/* 用户气泡里的附件回显：图片缩略图 + PhotoSwipe 全屏预览 / 文件 chip / iOS 分享保存。
   附件在 bridge 的 /api/v1/attachments/<name>，要带设备凭据取（AuthImg 先 fetch 成 blob 再渲染；下载同理），token 永不进 URL。 */

/** 附件文件 chip（非图片 / 图片加载失败的降级）。有 url 可点击下载。 */
function FileChip({ a }: { a: ChatAttachmentView }) {
  const cls =
    "flex max-w-[220px] items-center gap-2 rounded-[12px] border border-base-content/10 bg-base-300 px-3 py-2 text-[12.5px] text-base-content/80";
  if (!a.url) {
    return (
      <span title={a.name} className={cls}>
        📎 <span className="truncate">{a.name}</span>
      </span>
    );
  }
  const url = a.url;
  const download = (e: React.MouseEvent) => {
    if (!isApiUrl(url)) return; // blob: / data: 的让浏览器自己下
    e.preventDefault();
    void fetchAuthBlob(url)
      .then((b) => saveBlob(b, a.name))
      .catch(() => window.open(url, "_blank")); // 取不到就交给浏览器打开，至少能看到 404 而不是无反应
  };
  return (
    <a href={url} download={a.name} title={a.name} className={cls} onClick={download}>
      📎 <span className="truncate">{a.name}</span>
    </a>
  );
}

/** 图片附件：内联缩略图,点击全屏预览;加载失败(旧文件被清)降级为文件 chip。 */
function AttachedImage({ a, onPreview, imgRef }: { a: ChatAttachmentView; onPreview: () => void; imgRef: (el: HTMLImageElement | null) => void }) {
  const [err, setErr] = useState(false);
  if (err || !a.url) return <FileChip a={a} />;
  return (
    <AuthImg
      ref={imgRef}
      src={a.url}
      alt={a.name}
      onClick={onPreview}
      onError={() => setErr(true)}
      className="max-h-52 max-w-[220px] cursor-zoom-in rounded-[12px] border border-base-content/10 object-cover"
    />
  );
}

/** 把当前图片分享/保存：iOS 上走系统分享面板(可存相册),不支持时新开原图。 */
async function shareImage(url: string, name: string): Promise<void> {
  try {
    const blob = await fetchAuthBlob(url);
    const file = new File([blob], name || "image.png", { type: blob.type || "image/png" });
    if (navigator.canShare?.({ files: [file] })) {
      await navigator.share({ files: [file] });
      return;
    }
    saveBlob(blob, file.name);
  } catch {
    /* 用户取消分享面板也会 throw,静默；取不到图就什么都不做 */
  }
}

export function AttachmentStrip({ items }: { items: ChatAttachmentView[] }) {
  const t = useT();
  const images = items.filter((a) => a.kind === "image" && a.url);
  const imgEls = useRef(new Map<string, HTMLImageElement>());

  // PhotoSwipe(2026-07-14 owner 对上一个库的裁决:「太垃圾了」×3):相册级手势——捏合/双击缩放、拖拽平移、下拉关闭。
  // 需要原图尺寸 → 从已加载的缩略图 naturalWidth/Height 取；src 用已解析的 object URL（凭据已在取 blob 时带过）。
  const openViewer = async (index: number) => {
    const { default: PhotoSwipe } = await import("photoswipe");
    const pswp = new PhotoSwipe({
      dataSource: images.map((a) => {
        const el = imgEls.current.get(a.url!);
        return { src: resolvedAuthUrl(a.url!), width: el?.naturalWidth || 1600, height: el?.naturalHeight || 1200, alt: a.name, pid: a.url };
      }),
      index,
      bgOpacity: 0.95,
      arrowPrev: images.length > 1,
      arrowNext: images.length > 1,
      zoom: false, // 手势缩放为主，按钮占位
      pinchToClose: true,
      closeOnVerticalDrag: true,
      // 单击即关(owner 2026-07-14:「单击一下也关闭」)——手机上关图片只能下拉不顺手
      tapAction: "close",
      imageClickAction: "close",
      bgClickAction: "close",
    });
    // 自定义「保存」按钮:iOS PWA 里 lightbox 的图长按不出系统菜单,Web Share API 的分享面板才有「存储图像」到相册
    pswp.on("uiRegister", () => {
      pswp.ui?.registerElement({
        name: "save-btn",
        order: 8,
        isButton: true,
        tagName: "button",
        html: t("保存"),
        onClick: () => {
          const slide = pswp.currSlide?.data as { pid?: string; alt?: string } | undefined;
          if (slide?.pid) void shareImage(slide.pid, String(slide.alt || "image.png"));
        },
      });
    });
    pswp.init();
  };

  return (
    <div className="flex max-w-[85%] flex-wrap justify-end gap-2">
      {items.map((a, i) =>
        a.kind === "image" ? (
          <AttachedImage
            key={i}
            a={a}
            imgRef={(el) => {
              if (el && a.url) imgEls.current.set(a.url, el);
            }}
            onPreview={() => void openViewer(images.indexOf(a))}
          />
        ) : (
          <FileChip key={i} a={a} />
        ),
      )}
    </div>
  );
}
