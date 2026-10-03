/**
 * 截图自动检查（i28-TV1 验收 3，供以后所有 ui 卡复用）：在 Playwright 页面里跑，返回命中的问题，空数组 = 通过。
 * - overlap：可见文字框两两相交（按文本节点逐行取框；被遮罩盖住、被滚动容器裁掉的不算可见）
 * - idTitle：一段可见文字整个就是 UUID / 长十六进制 / 带前缀的 UUID（拿原始 id 当标题）
 * - overflow：页面横向溢出
 * - squeeze：一段文字被挤到每行只剩一两个字（按钮 / 标签被压窄、竖着排）
 * 用法：expect(await shotIssues(page)).toEqual([])
 */
import type { Page } from "playwright-core";

export interface ShotIssue { kind: "overlap" | "idTitle" | "overflow" | "squeeze"; detail: string }

/** 和 web/features/collab/team-source-adapter.ts 的 looksLikeId 同一规则（这里要整段塞进浏览器，所以只传正则源码） */
const ID_SOURCES = ["^[0-9a-f]{8}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{12}$", "^[0-9a-f]{16,}$", "^[a-z]+[-_:][0-9a-f]{8}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{12}$"];

/** 浏览器里跑的那段：写成字符串，避免 tests/ 的 tsconfig 去要 dom 类型 */
const SCRIPT = `(({ ids, minOverlap }) => {
  const res = ids.map((s) => new RegExp(s, "i"));
  const issues = [];
  const doc = document.documentElement;
  const sw = Math.max(doc.scrollWidth, document.body.scrollWidth);
  if (sw > innerWidth + 1) issues.push({ kind: "overflow", detail: "scrollWidth " + sw + " > " + innerWidth });
  const boxes = [];
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  const visibleIn = (el, r) => {
    for (let p = el; p && p !== document.body; p = p.parentElement) {
      const cs = getComputedStyle(p);
      if (cs.visibility === "hidden" || cs.display === "none" || Number(cs.opacity) === 0) return null;
      if (cs.overflowX !== "visible" || cs.overflowY !== "visible") {
        const c = p.getBoundingClientRect();
        r = { left: Math.max(r.left, c.left), right: Math.min(r.right, c.right), top: Math.max(r.top, c.top), bottom: Math.min(r.bottom, c.bottom) };
        if (r.right - r.left < 1 || r.bottom - r.top < 1) return null;
      }
    }
    r = { left: Math.max(r.left, 0), right: Math.min(r.right, innerWidth), top: Math.max(r.top, 0), bottom: Math.min(r.bottom, innerHeight) };
    if (r.right - r.left < 1 || r.bottom - r.top < 1) return null;
    const hit = document.elementFromPoint((r.left + r.right) / 2, (r.top + r.bottom) / 2);
    if (!hit || hit === el || el.contains(hit) || hit.contains(el)) return r;
    // Transparent sibling text does not hide underlying glyphs. Only a fully covering opaque layer can exclude a box.
    for (let p = hit; p && !p.contains(el); p = p.parentElement) {
      const cs = getComputedStyle(p), cover = p.getBoundingClientRect();
      const color = cs.backgroundColor.match(/rgba?\\(([^)]+)\\)/);
      const parts = color ? color[1].split(",").map(Number) : [];
      const opaque = parts.length === 3 || (parts.length === 4 && parts[3] === 1);
      let opacity = 1;
      for (let ancestor = p; ancestor; ancestor = ancestor.parentElement) opacity *= Number(getComputedStyle(ancestor).opacity);
      if (opaque && opacity === 1 && cover.left <= r.left && cover.right >= r.right
        && cover.top <= r.top && cover.bottom >= r.bottom) return null;
    }
    return r;
  };
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    const text = (n.textContent || "").trim();
    const el = n.parentElement;
    if (!text || !el || el.closest("script,style,noscript")) continue;
    const range = document.createRange();
    range.selectNodeContents(n);
    let shown = false;
    const rects = Array.from(range.getClientRects());
    const lines = new Set(rects.filter((x) => x.width > 0).map((x) => Math.round(x.top))).size;
    if (lines >= 2 && [...text].length / lines <= 2 && visibleIn(el, el.getBoundingClientRect())) issues.push({ kind: "squeeze", detail: text + " (" + lines + " lines)" });
    for (const raw of rects) {
      const r = visibleIn(el, raw);
      if (!r) continue;
      shown = true;
      boxes.push({ r, el, text });
    }
    if (shown && res.some((re) => re.test(text))) issues.push({ kind: "idTitle", detail: text });
  }
  for (let i = 0; i < boxes.length; i++) for (let j = i + 1; j < boxes.length; j++) {
    const a = boxes[i], b = boxes[j];
    if (a.el === b.el && a.text === b.text) continue;
    const w = Math.min(a.r.right, b.r.right) - Math.max(a.r.left, b.r.left);
    const h = Math.min(a.r.bottom, b.r.bottom) - Math.max(a.r.top, b.r.top);
    if (w > minOverlap && h > minOverlap) issues.push({ kind: "overlap", detail: JSON.stringify(a.text.slice(0, 40)) + " × " + JSON.stringify(b.text.slice(0, 40)) });
  }
  return issues;
})`;

/** minOverlap：两框在横竖两个方向都重叠超过这么多像素才算（排版的亚像素贴边不算） */
export async function shotIssues(page: Page, minOverlap = 2): Promise<ShotIssue[]> {
  return page.evaluate<ShotIssue[]>(`${SCRIPT}(${JSON.stringify({ ids: ID_SOURCES, minOverlap })})`);
}
