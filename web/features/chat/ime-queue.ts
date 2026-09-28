/**
 * 输入法组合期的程序化改写排队。composer 的 setText 组合期不写 DOM（写了 iOS 会丢组合串），
 * 组合结束后 input 事件又拿 DOM 值覆盖 textRef——组合期间的改写（勾表单）会整个丢掉。
 * 所以组合期先排队，组合结束的下一帧按顺序补做。纯逻辑，单测见 tests/web-form-compose.test.ts。
 */
export function createEditQueue(apply: (fn: (prev: string) => string) => void, composing: { readonly current: boolean }) {
  let pending: ((prev: string) => string)[] = [];
  return {
    edit(fn: (prev: string) => string) {
      if (composing.current) pending.push(fn);
      else apply(fn);
    },
    flush() {
      if (!pending.length || composing.current) return;
      const fns = pending;
      pending = [];
      apply((prev) => fns.reduce((s, f) => f(s), prev));
    },
  };
}
