import type { TaskDetail } from "./collab-detail-model";

/**
 * 主场本机卡读本机台账详情的结果标记（followup-reliability-UXCARD3），团队源（team-source-shared.ts homeMirror.task）写、详情读：
 * - stale：这次本机读失败，返回的是上次本机成功的详情；at = 那次成功的时刻。再读成功换新详情，标记随之没有；
 * - failed：从没读成功过（第一次打开就失败），返回的是中心详情：界面不得说成「在本机 / 非主场」。
 * 写法同 detail-pause-target.ts：按详情对象挂，不改 CollabSource 接口和 use-collab.ts。
 */
export type HomeRead = { kind: "stale"; at: number } | { kind: "failed" };

const marks = new WeakMap<TaskDetail, HomeRead>();
export function markHomeRead(d: TaskDetail, mark: HomeRead): void { marks.set(d, mark); }
export function homeReadOf(d: TaskDetail | null | undefined): HomeRead | null { return (d && marks.get(d)) ?? null; }
