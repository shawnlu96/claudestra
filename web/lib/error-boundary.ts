/**
 * 错误兜底层：子树渲染抛错时换成 fallback，别让整棵 React 树卸载成白屏。
 * 挂了三层（components/boundaries.tsx）：根 = 整页「出错了 · 重新加载」，聊天主区 / 协作视图各一个，单条消息气泡一个。
 * 只兜渲染 / 生命周期里的错；事件回调、异步里的错由 window 的 error / unhandledrejection 上报（lib/runtime-error.ts）。
 * 不写 JSX：tests/web-dom-error-boundary.test.ts 在根 tsconfig（没开 jsx）下直接挂载它（guard 登记的 TESTS_WEB_DOM 例外）。
 */
import { Component, type ErrorInfo, type ReactNode } from "react";

export interface ErrorBoundaryProps {
  children?: ReactNode;
  fallback: (error: Error, reset: () => void) => ReactNode;
  onError?: (error: Error, componentStack: string) => void;
  /** 变了就清掉错误重渲一次：切会话、消息内容更新后自动再试，不用用户手点 */
  resetKey?: unknown;
}

interface State {
  error: Error | null;
}

const toError = (e: unknown): Error => (e instanceof Error ? e : new Error(String(e)));

export class ErrorBoundary extends Component<ErrorBoundaryProps, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: unknown): State {
    return { error: toError(error) };
  }

  componentDidCatch(error: unknown, info: ErrorInfo) {
    this.props.onError?.(toError(error), info.componentStack ?? "");
  }

  // 只重置「更新之前就已经在错误态」的：换 key 的同一次更新里刚抛的错不算，否则会立刻重渲、再抛、再报一遍
  componentDidUpdate(prev: ErrorBoundaryProps, prevState: State) {
    if (prevState.error && this.state.error && !Object.is(prev.resetKey, this.props.resetKey)) this.setState({ error: null });
  }

  reset = () => this.setState({ error: null });

  render() {
    return this.state.error ? this.props.fallback(this.state.error, this.reset) : this.props.children;
  }
}

/** 按 key 只放行第一次（气泡层上报去重：同一条坏消息流式更新时会反复重试）；超过 limit 个 key 就整体清空，长会话里不无限增长 */
export function onlyOnce(limit = 500): (key: string) => boolean {
  const seen = new Set<string>();
  return (key) => {
    if (seen.has(key)) return false;
    if (seen.size >= limit) seen.clear();
    seen.add(key);
    return true;
  };
}
