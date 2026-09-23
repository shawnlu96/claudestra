"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { cachedClaudeModels, loadClaudeModels, type Catalog, type ClaudeModelOption } from "./claude-models-load";

/**
 * Claude Code 的模型目录——来自 Bridge `/claude-models`（它读 CC 自己拉的那份目录，
 * 与 TUI 里 `/model` 菜单同源，见 src/lib/model-catalog.ts）。此前这里是一张写死的表，
 * 与后端别名表一起落后上游（Opus 5.5 出来两张表都没有）。拉取与缓存见 claude-models-load.ts。
 */
export type { ClaudeModelOption };

/**
 * 模型目录 + 状态。loading=请求未完成；error≠null 表示上次没拉到，可 retry()。
 * retryWhen 由 false 变 true 时（如切换器面板被打开）若处于失败状态，自动重拉**一次**——
 * 只一次：再失败 error 会重新变非空，不设标记就会失败→重拉→失败地连环请求。
 */
export function useClaudeModelCatalog(retryWhen = false): Catalog & { loading: boolean; retry: () => void } {
  const [state, setState] = useState<Catalog & { loading: boolean }>(() => {
    const cached = cachedClaudeModels();
    return cached ? { models: cached, error: null, loading: false } : { models: [], error: null, loading: true };
  });
  const run = useCallback(() => {
    let live = true;
    void loadClaudeModels().then((c) => live && setState({ ...c, loading: false }));
    return () => {
      live = false;
    };
  }, []);
  useEffect(run, [run]);
  const retry = useCallback(() => {
    setState((s) => ({ ...s, error: null, loading: true }));
    run();
  }, [run]);
  const retried = useRef(false);
  useEffect(() => {
    if (!retryWhen) retried.current = false;
    else if (state.error && !retried.current) {
      retried.current = true;
      retry();
    }
  }, [retryWhen, state.error, retry]);
  return { ...state, retry };
}

/** 只要列表的调用方（新建弹窗 / 设置页，都是打开时才挂载，重新打开即重拉）。 */
export function useClaudeModels(): ClaudeModelOption[] {
  return useClaudeModelCatalog().models;
}
