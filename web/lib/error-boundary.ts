/**
 * 错误兜底层：子树渲染抛错时换成 fallback，别让整棵 React 树卸载成白屏。
 * 挂了三层（components/boundaries.tsx）：根 = 整页「出错了 · 重新加载」，聊天 / 协作视图各一个，单条消息气泡一个。
 * 只兜渲染 / 生命周期里的错；事件回调、异步里的错由 window 的 error / unhandledrejection 上报（lib/runtime-error.ts）。
 * React 的 Component 由调用方传入、本文件不 import react：tests/web-error-boundary.test.ts 在根目录（没有 react）直接挂载它，
 * 测试只能引用不依赖 react 的 web 模块（scripts/guard/rules/deps.ts 的 tests-web-pure）。
 */
type ReactNode = import("react").ReactNode;
type ErrorInfo = import("react").ErrorInfo;

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

export function createErrorBoundary(Base: typeof import("react").Component) {
  return class ErrorBoundary extends Base<ErrorBoundaryProps, State> {
    state: State = { error: null };

    static getDerivedStateFromError(error: unknown): State {
      return { error: toError(error) };
    }

    componentDidCatch(error: unknown, info: ErrorInfo) {
      this.props.onError?.(toError(error), info.componentStack ?? "");
    }

    componentDidUpdate(prev: ErrorBoundaryProps) {
      if (this.state.error && !Object.is(prev.resetKey, this.props.resetKey)) this.setState({ error: null });
    }

    reset = () => this.setState({ error: null });

    render() {
      return this.state.error ? this.props.fallback(this.state.error, this.reset) : this.props.children;
    }
  };
}
