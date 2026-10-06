import { closeCollab } from "../collab-nav";

const wrapped = new WeakMap<() => void, () => void>();
/** 同一个 fn 永远包出同一个函数：Sidebar 的 onSelect 引用不变，不为这个多一次重渲 */
export function closingCollab(fn: () => void): () => void {
  let w = wrapped.get(fn);
  if (!w) {
    w = () => {
      closeCollab();
      fn();
    };
    wrapped.set(fn, w);
  }
  return w;
}
