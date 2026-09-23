/**
 * 侧栏拖拽改 project 的**判定**（纯函数 + 模块级拖拽态，无 React；DOM 事件接线在
 * components/agent-dnd.tsx）。只做桌面端 HTML5 拖拽：手机端左滑 / 长按手势已占满，
 * 改 project 走长按菜单的「移动到」。单测见 tests/web-agent-menu.test.ts。
 */

export interface DragAgent {
  name: string;
  projectId: string | null;
}

/** dataTransfer 类型：只认自己的拖拽，文件 / 文字拖进侧栏不触发。 */
export const DND_MIME = "application/x-cstra-agent";

let cur: DragAgent | null = null;
export function beginAgentDrag(d: DragAgent): void {
  cur = d;
}
export function endAgentDrag(): void {
  cur = null;
}
export function currentDrag(): DragAgent | null {
  return cur;
}

/**
 * 放到目标（project 组头 = 该 project；agent 行 = 该行所属 project）上该改成哪个 project。
 * 同 project / 没在拖 / 目标无归属（master、未分组）/ 放到自己身上 → null（不可放）。
 */
export function dropTarget(
  d: DragAgent | null,
  target: { projectId?: string | null; agentName?: string },
): string | null {
  if (!d) return null;
  if (target.agentName && target.agentName === d.name) return null;
  const pid = target.projectId ?? null;
  if (!pid || pid === d.projectId) return null;
  return pid;
}
