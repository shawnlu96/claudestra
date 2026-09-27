"use client";
import { useEffect, useState, type ImgHTMLAttributes, type Ref } from "react";
import { isApiUrl } from "@/lib/chat/attachments";
import { apiRaw } from "@/lib/api/client";

/**
 * 附件要带设备凭据取（HttpOnly cookie；中继模式下还要拼机器基址），而且 token 永不进 URL：
 * API 路径的图片 / 文件先 fetch 成 blob，再用 object URL 渲染 / 下载；blob: / data: / 外链原样用。
 * 同一 URL 页面存活期内只取一次（多条消息引用同一张图 / 重挂载不重拉），object URL 随页面存活。
 */
const cache = new Map<string, Promise<string>>();

/** API 附件 → object URL；非 API 地址原样返回。失败抛错（调用方降级成文件 chip） */
export function resolveAuthUrl(url: string): Promise<string> {
  if (!isApiUrl(url)) return Promise.resolve(url);
  let p = cache.get(url);
  if (!p) {
    p = apiRaw(url.slice("/api/v1".length)).then(async (res) => {
      if (!res.ok) throw new Error(`attachment ${res.status}`);
      return URL.createObjectURL(await res.blob());
    });
    p.catch(() => cache.delete(url)); // 失败不缓存：下次重挂载再试（bridge 刚重启 / 文件稍后落盘）
    cache.set(url, p);
  }
  return p;
}

/** 已解析的 object URL（渲染期同步取，PhotoSwipe 要现成的 src）；没解析过就是原地址 */
const resolved = new Map<string, string>();
export function resolvedAuthUrl(url: string): string {
  return resolved.get(url) ?? url;
}

export function useAuthUrl(url: string | undefined): { src: string | null; error: boolean } {
  const [state, setState] = useState<{ src: string | null; error: boolean }>(() => ({ src: url && !isApiUrl(url) ? url : (url && resolved.get(url)) || null, error: false }));
  useEffect(() => {
    if (!url) return;
    let dead = false;
    resolveAuthUrl(url)
      .then((src) => {
        resolved.set(url, src);
        if (!dead) setState({ src, error: false });
      })
      .catch(() => {
        if (!dead) setState({ src: null, error: true });
      });
    return () => {
      dead = true;
    };
  }, [url]);
  return state;
}

/** <img> 的带凭据版：加载中不渲染，失败调 onError（父级降级成文件 chip）。ref 透传到真实 <img>（PhotoSwipe 要读 naturalWidth） */
export function AuthImg({ src, onError, ref, ...rest }: ImgHTMLAttributes<HTMLImageElement> & { src: string; ref?: Ref<HTMLImageElement> }) {
  const r = useAuthUrl(src);
  useEffect(() => {
    if (r.error) onError?.(new Event("error") as unknown as React.SyntheticEvent<HTMLImageElement, Event>);
  }, [r.error, onError]);
  if (!r.src) return null;
  // eslint-disable-next-line @next/next/no-img-element
  return <img ref={ref} src={r.src} onError={onError} {...rest} />;
}

/** 下载 / 分享一个附件：先取回 blob（带凭据），再交给系统分享面板或浏览器下载 */
export async function fetchAuthBlob(url: string): Promise<Blob> {
  const res = await (isApiUrl(url) ? apiRaw(url.slice("/api/v1".length)) : fetch(url));
  if (!res.ok) throw new Error(`attachment ${res.status}`);
  return res.blob();
}

export function saveBlob(blob: Blob, name: string): void {
  const u = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = u;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(u), 10_000);
}
