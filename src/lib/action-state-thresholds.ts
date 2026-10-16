/**
 * 卡片状态投影（agents-ACTIONSTATE1，src/lib/action-state.ts）用的两条时长阈值，只在 src 定义。
 * 取值与 web/features/collab/collab-model.ts 的同名常量相同（tests/action-state-thresholds.test.ts 读源文件核对）；
 * 前端改读 actionState 后那边的推导整段删掉，不登记 twin。
 */

/** 在等别人的阶段（WAIT_STAGES）停留严格超过这么久算等待超时 */
export const STUCK_MS = 30 * 60_000;
/** 返工停满这么久才算出问题：与 RLOCK2 停滞让锁阈值（2 小时无进展）一致；不满的是正常返工 */
export const FIX_STUCK_MS = 2 * 60 * 60_000;
