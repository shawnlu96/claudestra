/* 侧栏左滑的全局登记（从 agent-row.tsx 原样搬出）：模块级单例——AgentRow 的每个行实例与 Sidebar
   必须拿到同一个对象，才能做到「同一时刻只允许一行滑开」。 */

/**
 * v2.21.3+ 当前滑开的那一行的收回函数——同一时刻只允许一行滑开(iOS Mail / 微信同款):
 * 列表滚动、别的行出现纵向手势或被点击,都先把它收回。
 */
export const swipeReg = {
  cur: null as (() => void) | null,
  set(fn: () => void) { this.cur = fn; },
  clear(fn: () => void) { if (this.cur === fn) this.cur = null; },
  closeAll() { this.cur?.(); },
  /** 收回除 fn 之外的滑开行 */
  closeOthers(fn: () => void) { if (this.cur && this.cur !== fn) this.cur(); },
};
