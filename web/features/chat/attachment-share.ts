/**
 * 附件交给系统分享面板（iOS 上能「存储到文件」「用其他应用打开」「存储图像」）。图片的「保存」和文件 chip、文本预览共用。
 * iOS 只在用户手势刚发生时放行 share：先取 blob 再分享，大文件取完可能已过期 → "blocked"，调用方让用户再点一次。
 */

export type ShareResult = "shared" | "cancelled" | "unsupported" | "blocked";

type SharePayload = { files?: File[]; title?: string; text?: string };
/** navigator 里用到的两个方法；根 tsconfig 不带 DOM 类型（tests/web-attachment-open.test.ts 直接传假对象） */
export type ShareNav = { canShare?: (d: SharePayload) => boolean; share?: (d: SharePayload) => Promise<void> };

export async function shareFile(blob: Blob, name: string, text?: string, nav: ShareNav = globalThis.navigator as ShareNav): Promise<ShareResult> {
  const file = new File([blob], name, { type: blob.type || "application/octet-stream" });
  let data: SharePayload | null = null;
  if (nav.canShare?.({ files: [file] })) data = { files: [file] };
  else if (text !== undefined && typeof nav.share === "function") data = { title: name, text };
  if (!data || !nav.share) return "unsupported";
  try {
    await nav.share(data);
    return "shared";
  } catch (e) {
    // NotAllowedError = 手势已过期；AbortError = 用户关了分享面板；其他（系统拒绝该类型）按不支持处理，交给调用方退回下载
    const n = (e as Error)?.name;
    return n === "NotAllowedError" ? "blocked" : n === "AbortError" ? "cancelled" : "unsupported";
  }
}
