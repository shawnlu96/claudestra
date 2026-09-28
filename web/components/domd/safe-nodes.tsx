"use client";
/**
 * do-md 链接 / 图片节点的覆盖（Domd 默认挂上，聊天消息与附件预览共用；规则在 lib/chat/md-guard.ts）。
 * - 链接：内核把任意协议原样放进 data-href、点击时临时建 <a target=_blank> 且不带 rel；这里只放行 http(s) / mailto，
 *   渲染成真 <a rel="noopener noreferrer">，其余按纯文本。
 * - 图片：外链（可能来自网页、peer、guest）是追踪信标，先占位、点了才加载且不带 Referer；本机附件带凭据取
 *   （内核直接 <img src="/api/v1/…"> 经中继少了机器前缀会 404）；data: / blob: 照常。
 */
import { useState, type SyntheticEvent } from "react";
import { getRenderElementProps, MarkdownType, RenderChildren, type RenderElementProps } from "@do-md/core-react";
import { imageHost, imageSrcKind, safeLinkHref } from "@/lib/chat/md-guard";
import { useT } from "@/lib/i18n";
import { AuthImg } from "@/features/chat/components/auth-img";

function SafeLink({ parsedData }: RenderElementProps) {
  const props: Record<string, unknown> = { ...getRenderElementProps(parsedData) };
  delete props.href; // 原始地址不落进 DOM：放行的才作为 href 写回
  const href = safeLinkHref(parsedData.htmlProps_?.href);
  if (!href) {
    // 不带 DOMD-Link 的样式（它按 <a> 调的色，落在 span 上浅色主题里几乎看不见）：就是一段普通文字
    return (
      <span {...props} className={undefined}>
        <RenderChildren parsedData={parsedData} />
      </span>
    );
  }
  return (
    <a {...props} href={href} target="_blank" rel="noopener noreferrer">
      <RenderChildren parsedData={parsedData} />
    </a>
  );
}

function ImageIcon() {
  // lucide image
  return (
    <svg viewBox="0 0 24 24" width={14} height={14} fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden className="shrink-0">
      <rect width="18" height="18" x="3" y="3" rx="2" ry="2" />
      <circle cx="9" cy="9" r="2" />
      <path d="m21 15-3.086-3.086a2 2 0 0 0-2.828 0L6 21" />
    </svg>
  );
}

function SafeImg({ parsedData }: RenderElementProps) {
  const t = useT();
  const [load, setLoad] = useState(false);
  const { src, alt, ...props } = getRenderElementProps(parsedData) as Record<string, unknown>;
  const url = typeof src === "string" ? src.trim() : "";
  const label = typeof alt === "string" ? alt : "";
  const kind = imageSrcKind(url);
  if (kind === "attachment") return <AuthImg {...props} src={url} alt={label} />;
  // eslint-disable-next-line @next/next/no-img-element
  if (kind === "inline" || (kind === "external" && load)) return <img {...props} src={url} alt={label} referrerPolicy="no-referrer" />;
  if (kind === "external") {
    const host = imageHost(url);
    // 用 span 不用 button：图片常嵌在链接里（`[![a](…)](…)`），<a> 里放 <button> 不合法；点加载也不能顺带打开外面的链接
    const reveal = (e: SyntheticEvent) => {
      e.preventDefault();
      e.stopPropagation();
      setLoad(true);
    };
    return (
      <span
        role="button"
        tabIndex={0}
        contentEditable={false}
        title={url}
        onClick={reveal}
        onKeyDown={(e) => (e.key === "Enter" || e.key === " ") && reveal(e)}
        className="my-1 inline-flex max-w-full cursor-pointer items-center gap-1.5 rounded-md border border-dashed border-base-content/25 px-2 py-1 text-xs text-base-content/70"
      >
        <ImageIcon />
        <span className="truncate">{host ? t("点一下加载外链图片 · {host}", { host }) : t("点一下加载外链图片")}</span>
      </span>
    );
  }
  return label ? <span className="text-base-content/60">[{label}]</span> : null;
}

/** 传给 DOMDProvider 的 renderComponent */
export const SAFE_NODES = { [MarkdownType.Link]: SafeLink, [MarkdownType.Img]: SafeImg };
