/**
 * 渲染前先让 do-md 在 try/catch 里解析一遍，护栏（lib/chat/md-guard.ts）没认出来的炸弹在这里接住：
 * - 解析时栈溢出 / 抛错 → 纯文本；
 * - 解析树太深 → 纯文本。深树的栈溢出发生在 React 提交阶段（recursivelyTraversePassiveMountEffects），
 *   ErrorBoundary 和 try/catch 都接不住，整棵 React 树会被卸掉，只能渲染前按深度拦。
 * 实测：`- ` 嵌套 400 层（树深约 800）起溢出；真实文档树深 8～20。代价是多解析一次（和渲染同量级，小消息 < 1 ms）。
 */
import { EditorStore } from "@do-md/core-react";

export const MD_MAX_TREE_DEPTH = 160;

type Node = { children_?: Node[] };
export type StoreProps = ConstructorParameters<typeof EditorStore>[0];

function treeDepth(root: Node): number {
  let max = 0;
  const stack: [Node, number][] = [[root, 1]];
  while (stack.length) {
    const [node, d] = stack.pop()!;
    if (d > max) max = d;
    if (max > MD_MAX_TREE_DEPTH) return max;
    for (const c of node.children_ ?? []) stack.push([c, d + 1]);
  }
  return max;
}

/** do-md 的解析树（和 DOMDProvider 里的一样），可能栈溢出 / 抛错 */
export function parseMd(props: StoreProps): unknown {
  return new EditorStore(props).renderData_;
}

/** 这段 md 交给 do-md 能不能安全渲染；参数和 DOMDProvider 的一样（解析结果只取决于它们） */
export function domdSafe(props: StoreProps): boolean {
  try {
    return treeDepth(parseMd(props) as Node) <= MD_MAX_TREE_DEPTH;
  } catch {
    return false; // 解析就栈溢出 / 抛错：调用方退回纯文本并提示，错误本身没有别的用处
  }
}
