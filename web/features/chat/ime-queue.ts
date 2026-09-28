/**
 * 表单往输入框里的程序化改写。composer 的 setText 组合期不写 DOM（写了 iOS 会丢组合串），组合结束后
 * input 事件又拿 DOM 值覆盖 textRef——组合期的改写会整个丢掉，所以先排队、组合结束下一帧补做；排队期间
 * 勾选框按 preview 显示，发送前 drain 并进要发的文字。改写不能把光标甩到末尾：按改动位置平移。
 * 纯逻辑，单测见 tests/web-form-compose.test.ts。iOS 听写不派 composition 事件，只能真机验。
 */
type Fn = (prev: string) => string;

export interface CaretBox {
  value: string;
  selectionStart: number | null;
  selectionEnd: number | null;
  setSelectionRange(start: number, end: number): void;
}

/** 改写后光标的新位置：改动全在光标后 → 不动；全在光标前 → 按长度差平移；光标落在改动区里 → 放到改动区末尾 */
export function shiftCaret(before: string, after: string, pos: number): number {
  const max = Math.min(before.length, after.length);
  let p = 0;
  while (p < max && before[p] === after[p]) p++;
  let s = 0;
  while (s < max - p && before[before.length - 1 - s] === after[after.length - 1 - s]) s++;
  if (pos <= p) return pos;
  if (pos >= before.length - s) return pos + after.length - before.length;
  return after.length - s;
}

export function createEditQueue(apply: (fn: Fn) => void, composing: { readonly current: boolean }, box?: { readonly current: CaretBox | null }) {
  let pending: Fn[] = [];
  const all = (fns: Fn[]): Fn => (prev) => fns.reduce((acc, f) => f(acc), prev);
  const run = (fn: Fn) => {
    const ta = box?.current;
    const before = ta?.value ?? "";
    const [a, b] = [ta?.selectionStart ?? before.length, ta?.selectionEnd ?? before.length];
    apply(fn);
    if (ta && ta.value !== before) ta.setSelectionRange(shiftCaret(before, ta.value, a), shiftCaret(before, ta.value, b));
  };
  return {
    edit(fn: Fn) {
      if (composing.current) pending.push(fn);
      else run(fn);
    },
    flush() {
      if (!pending.length || composing.current) return;
      const fns = pending;
      pending = [];
      run(all(fns));
    },
    /** 排队中的改写作用在 text 上的结果：组合期点过的勾立刻看得到，再点一次是取消而不是重复 */
    preview(text: string): string {
      return all(pending)(text);
    },
    /** 发送前把排队中的改写并进要发的文字并清空队列 */
    drain(text: string): string {
      const out = all(pending)(text);
      pending = [];
      return out;
    },
  };
}

export type EditQueue = ReturnType<typeof createEditQueue>;
