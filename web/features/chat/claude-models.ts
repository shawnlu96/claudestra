"use client";
import { useEffect, useState } from "react";

/**
 * Claude Code 的模型目录——来自 Bridge `/claude-models`（它读 CC 自己拉的那份目录，
 * 与 TUI 里 `/model` 菜单同源，见 src/lib/model-catalog.ts）。此前这里是一张写死的表，
 * 与后端别名表一起落后上游（Opus 5.5 出来两张表都没有）。
 */
export type ClaudeModelOption = { value: string; label: string; section: string };

// 整页共用一次请求（TopBar / 设置页 / 新建弹窗同时挂载时不重复拉）；失败清空，下次重试
let pending: Promise<ClaudeModelOption[]> | null = null;

function load(): Promise<ClaudeModelOption[]> {
  pending ??= fetch("/api/claude-models")
    .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
    .then((j: { data?: { models?: Array<{ id: string; name: string; section: string }> } }) =>
      (j.data?.models ?? []).map((m) => ({ value: m.id, label: m.name, section: m.section })),
    )
    .catch(() => {
      pending = null;
      return [];
    });
  return pending;
}

/** 加载完成前返回 []——调用方照常渲染当前值（modelLabel 对未知 id 有兜底）。 */
export function useClaudeModels(): ClaudeModelOption[] {
  const [models, setModels] = useState<ClaudeModelOption[]>([]);
  useEffect(() => {
    let live = true;
    void load().then((m) => live && setModels(m));
    return () => {
      live = false;
    };
  }, []);
  return models;
}
