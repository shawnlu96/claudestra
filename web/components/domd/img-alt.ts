/**
 * 图片的 alt（tests/web-domd-img-alt.test.ts）：do-md 的 Img 节点只带 src，原文 `![alt](src)` 在它 mdSymbols_ 里某个
 * MdSymbol 兄弟节点上。按节点对原文，不按 src 查表：同一 src 的几张图、src 带括号 / title / 尖括号都各取各的。
 * 解析树只读、整棵不变，按根缓存一次索引，每张图只查自己带的几个符号。
 */
type Node = { htmlType_?: string; uuid_?: string; text_?: string; mdSymbols_?: string[]; htmlProps_?: Record<string, unknown>; children_?: Node[] };

const index = new WeakMap<object, Map<string, string>>();

function imageSymbols(root: Node): Map<string, string> {
  let map = index.get(root);
  if (map) return map;
  map = new Map();
  const stack: Node[] = [root];
  while (stack.length) {
    const n = stack.pop()!;
    if (n.htmlType_ === "MdSymbol" && n.uuid_ && n.text_?.startsWith("![")) map.set(n.uuid_, n.text_);
    for (const c of n.children_ ?? []) stack.push(c);
  }
  index.set(root, map);
  return map;
}

/** img 在 root 这棵解析树里的 alt；对不上原文给空串 */
export function imageAltOf(root: unknown, img: unknown): string {
  const node = img as Node;
  const src = node?.htmlProps_?.src;
  if (!root || typeof root !== "object" || typeof src !== "string") return "";
  const texts = imageSymbols(root as Node);
  const tail = `](${src})`;
  // mdSymbols_ 还带着外层（链接、强调）的符号，挑以 `![` 开头、以本图 src 结尾的那个
  for (const id of node.mdSymbols_ ?? []) {
    const raw = texts.get(id);
    if (raw?.endsWith(tail)) return raw.slice(2, raw.length - tail.length);
  }
  return "";
}
