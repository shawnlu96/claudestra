/**
 * 导出的「打包」环节（无 React）：把离屏渲染好的 DOM 变成一个自包含 HTML 文件。
 *  - collectCss：把页面当前生效的全部样式抄进去——Next 编译出的 CSS chunk、do-md 用
 *    adoptedStyleSheets 挂的构造样式表、Prism 主题；跨域样式表读不到 cssRules，退回 <link>。
 *  - inlineImages：附件图片走带登录态的 BFF 端点，离线文件打不开 → 取回来转 data URL
 *    内联（单张超上限只留 alt）。
 *  - buildHtmlDoc：拼成完整文档，主题按导出那一刻的明 / 暗定死，附打印样式。
 *  - deliverFile / printHtml：给到用户。分享 / 打印都要用户手势，调用方放在按钮里。
 */

const IMG_INLINE_MAX = 2 * 1024 * 1024;

type SheetLike = { href: string | null; cssRules: CSSRuleList };

function sheetText(sheet: SheetLike): string | null {
  try {
    return Array.from(sheet.cssRules, (r) => r.cssText).join("\n");
  } catch {
    return null; // 跨域样式表（如 Google Fonts）读不到规则，调用方退回 <link>
  }
}

/**
 * 优先拿**原文**：同源的 <link> 样式表 fetch 回来、<style> 直接读 textContent。
 * 不能靠 cssRules[].cssText 再序列化——浏览器会把 `color-mix(in srgb, currentColor 10%, transparent)`
 * 写成 `color-mix(currentcolor 10%, transparent)`，别的解析器（Safari）当非法丢掉，留下 Lightning CSS
 * 的兜底 `background: currentColor`，行内按钮就成了黑底（owner 2026-09-25 实报）。
 * adoptedStyleSheets（do-md）没有原文，只能序列化。
 */
export async function collectCss(doc: Document): Promise<{ css: string; links: string[] }> {
  const parts: string[] = [];
  const links: string[] = [];
  const origin = doc.location?.origin ?? "";
  for (const sheet of Array.from(doc.styleSheets)) {
    if (sheet.href) {
      const sameOrigin = (() => {
        try {
          return new URL(sheet.href, doc.baseURI).origin === origin;
        } catch {
          return false; // 解析不了的 href 当跨域，退回 <link>
        }
      })();
      if (sameOrigin) {
        try {
          const res = await fetch(sheet.href, { credentials: "include" });
          if (res.ok) {
            parts.push(await res.text());
            continue;
          }
        } catch {
          /* 拿不到原文就走下面的序列化兜底 */
        }
      }
      const text = sameOrigin ? sheetText(sheet) : null;
      if (text !== null) parts.push(text);
      else links.push(sheet.href);
      continue;
    }
    const node = sheet.ownerNode as HTMLElement | null;
    const raw = node?.textContent;
    if (raw) parts.push(raw);
    else {
      const text = sheetText(sheet);
      if (text) parts.push(text);
    }
  }
  for (const sheet of doc.adoptedStyleSheets ?? []) {
    const text = sheetText(sheet);
    if (text) parts.push(text);
  }
  return { css: parts.join("\n"), links };
}

async function toDataUrl(src: string): Promise<string | null> {
  try {
    const res = await fetch(src, { credentials: "include" });
    if (!res.ok) return null;
    const blob = await res.blob();
    if (blob.size > IMG_INLINE_MAX) return null;
    return await new Promise<string>((resolve, reject) => {
      const fr = new FileReader();
      fr.onload = () => resolve(String(fr.result));
      fr.onerror = () => reject(fr.error);
      fr.readAsDataURL(blob);
    });
  } catch {
    return null; // 取不到就降级成 alt 文本，导出不中断
  }
}

/** 把容器里所有非 data: 的图片就地换成 data URL；换不了的换成 alt 文本。 */
export async function inlineImages(root: HTMLElement): Promise<void> {
  const imgs = Array.from(root.querySelectorAll("img"));
  await Promise.all(
    imgs.map(async (img) => {
      const src = img.getAttribute("src") || "";
      if (!src || src.startsWith("data:")) return;
      const data = await toDataUrl(src);
      if (data) img.setAttribute("src", data);
      else {
        const alt = img.ownerDocument.createElement("span");
        alt.textContent = `[${img.getAttribute("alt") || "image"}]`;
        img.replaceWith(alt);
      }
    }),
  );
}

/** 导出文档专属样式：限宽居中、关动画、打印分页。 */
const EXPORT_CSS = `
.cstra-export-page{max-width:820px;margin:0 auto;padding:24px 16px 48px}
.cstra-export-page *{animation:none!important;transition:none!important}
@media print{
  @page{margin:14mm}
  .cstra-export-page{max-width:none;padding:0}
  /* 不许整条消息内分页是错的：一条 assistant 常比一页还高，浏览器先把整块推到下一页
     （上一页大片留白，owner 2026-09-25 实报），推过去还是得在里面断。只保护小单元。 */
  [data-tool-row],[data-bubble="user"],img,pre{break-inside:avoid}
  p,li{orphans:3;widows:3}
  h1,h2,h3,h4{break-after:avoid}
}
`;

export function buildHtmlDoc(opts: {
  title: string;
  bodyHtml: string;
  css: string;
  links: string[];
  htmlAttrs: Record<string, string>;
  bodyClass: string;
}): string {
  const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/"/g, "&quot;");
  const attrs = Object.entries(opts.htmlAttrs)
    .map(([k, v]) => ` ${k}="${esc(v)}"`)
    .join("");
  const links = opts.links.map((h) => `<link rel="stylesheet" href="${esc(h)}">`).join("\n");
  return `<!doctype html>
<html${attrs}>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(opts.title)}</title>
${links}
<style>
${opts.css}
${EXPORT_CSS}
</style>
</head>
<body class="${esc(opts.bodyClass)}">
<div class="cstra-export-page">
${opts.bodyHtml}
</div>
</body>
</html>`;
}

/** 文件名：会话名 + 时间，去掉文件系统不认的字符 */
export function exportFileName(agent: string, ts = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  const stamp = `${ts.getFullYear()}${pad(ts.getMonth() + 1)}${pad(ts.getDate())}-${pad(ts.getHours())}${pad(ts.getMinutes())}`;
  const safe = agent.replace(/[\\/:*?"<>|\s]+/g, "-").replace(/^-+|-+$/g, "") || "chat";
  return `${safe}-${stamp}.html`;
}

/** 触屏设备走系统分享面板（存到「文件」/ 发给别人）；桌面直接下载——桌面 Chrome / Safari 也有
 *  share API，但弹 macOS 分享面板不如直接落到下载目录。须在用户手势里调。 */
export async function deliverFile(file: File): Promise<"shared" | "downloaded"> {
  const nav = navigator as Navigator & { canShare?: (d: ShareData) => boolean };
  const touch = typeof matchMedia === "function" && matchMedia("(pointer: coarse)").matches;
  if (touch && nav.canShare?.({ files: [file] })) {
    await nav.share({ files: [file], title: file.name });
    return "shared";
  }
  const url = URL.createObjectURL(file);
  const a = document.createElement("a");
  a.href = url;
  a.download = file.name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
  return "downloaded";
}

/** 把 HTML 放进隐藏 iframe 调系统打印（用户在打印对话框里「存为 PDF」）。须在用户手势里调。 */
export function printHtml(html: string): void {
  const frame = document.createElement("iframe");
  frame.style.cssText = "position:fixed;right:0;bottom:0;width:0;height:0;border:0;visibility:hidden";
  frame.srcdoc = html;
  frame.onload = () => {
    const win = frame.contentWindow;
    if (!win) return;
    // 打印完（或取消）再移除；Safari 的 afterprint 不一定来，兜底 60s
    win.addEventListener("afterprint", () => frame.remove());
    setTimeout(() => frame.remove(), 60_000);
    win.focus();
    win.print();
  };
  document.body.appendChild(frame);
}
