/**
 * 项目页标签的两份模块级状态（不持久化，刷新即忘）：
 * - 请求：别处（今天页的模块行）打开项目前先登记「落在哪个标签、选中哪个模块」，CollabView 挂载时取一次（use-dag-ui.ts）；
 * - 记忆：同一个项目里切走再回来，回到上次停的标签。按项目键（团队版是团队源的键），换项目各记各的。
 */
import type { DagTab } from "../dag/use-dag-ui";

export interface TabRequest {
  tab: DagTab;
  /** tab = module 时要选中的模块（产品看板的 feature id）；不给 = 只切标签 */
  featureId?: string | null;
}

const requests = new Map<string, TabRequest>();
const remembered = new Map<string, DagTab>();

export function requestProjectTab(project: string, req: TabRequest): void {
  requests.set(project, req);
}

/** 只看不取：useState 初始化在 StrictMode 下会跑两次，取走留给挂载后的 effect（clearProjectTab） */
export const peekProjectTab = (project: string): TabRequest | null => requests.get(project) ?? null;
export const clearProjectTab = (project: string): void => void requests.delete(project);

export const rememberTab = (project: string, tab: DagTab): void => void remembered.set(project, tab);
export const rememberedTab = (project: string): DagTab | null => remembered.get(project) ?? null;
