"use client";
import { useEffect, useState } from "react";
import { fetchAuthBlob } from "../chat/components/auth-img";

/**
 * 带凭据取一个 API 资源成 object URL，url 变成 null / 换了 / 组件卸载就回收。
 * 媒体网格不用 AuthImg 的全局缓存：那份缓存的 object URL 页面存活期内从不回收，翻几百张缩略图内存只增不减（iOS PWA 会被杀）。
 * 缩略图服务忙（503）时隔一会儿重试几次，别直接显示成坏图；转不了（422：像素超限、PDF、sips 失败）单独报 "unconvertible"，
 * 格子上写「无法生成缩略图」而不是「文件已不在本机」。
 */
const RETRIES = 3;

export type BlobError = null | "unconvertible" | "failed";

export function useBlobUrl(url: string | null): { src: string | null; error: BlobError } {
  const [state, setState] = useState<{ url: string | null; src: string | null; error: BlobError }>({ url: null, src: null, error: null });
  useEffect(() => {
    if (!url) return;
    let dead = false;
    let made: string | null = null;
    const attempt = (n: number) => {
      fetchAuthBlob(url)
        .then((b) => {
          if (dead) return;
          made = URL.createObjectURL(b);
          setState({ url, src: made, error: null });
        })
        .catch((e: Error) => {
          if (dead) return;
          if (/\b503\b/.test(e.message) && n < RETRIES) setTimeout(() => !dead && attempt(n + 1), 1500 * (n + 1));
          else setState({ url, src: null, error: /\b422\b/.test(e.message) ? "unconvertible" : "failed" });
        });
    };
    attempt(0);
    return () => {
      dead = true;
      if (made) URL.revokeObjectURL(made);
    };
  }, [url]);
  // 结果只对它自己的 url 算数：url 刚换时还没取到新的，别拿旧图顶着
  return state.url === url ? { src: state.src, error: state.error } : { src: null, error: null };
}
