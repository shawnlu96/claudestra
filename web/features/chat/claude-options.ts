/**
 * 模型 / effort 选项——设置页「全局默认」与会话级切换器（TopBar）共用。
 * value = 完整 model id（settings.json / registry / /model 命令都认它）。
 */
export const MODEL_OPTIONS = [
  { value: "claude-fable-5-1", label: "Fable 5.1" },
  { value: "claude-fable-5", label: "Fable 5" },
  { value: "claude-opus-5", label: "Opus 5" },
  { value: "claude-opus-4-8", label: "Opus 4.8" },
  { value: "claude-sonnet-4-6", label: "Sonnet 4.6" },
  { value: "claude-haiku-4-5-20251001", label: "Haiku 4.5" },
] as const;

export const EFFORT_OPTIONS = ["low", "medium", "high", "xhigh", "max"] as const;

/**
 * v2.21.1+ 会话级切换器(TopBar)额外可用的档位(peer owner 请求 2026-08-30):
 * ultracode = xhigh 算力 + 动态 workflow 编排,CC 语义「this session only」——
 * 只走 /effort 注入,不进全局默认(settings.json 不认)、不进启动 flag。
 * 需要 CC 的 dynamic workflows 开启,没开时 bridge 会把 CC 的拒绝原因透传回来。
 */
export const RUNTIME_EFFORT_OPTIONS = [...EFFORT_OPTIONS, "ultracode"] as const;

/** model id → 短标签（未知 id 去掉 claude- 前缀原样显示，透传未来新模型）。 */
export function modelLabel(id: string | null | undefined): string {
  if (!id) return "?";
  const hit = MODEL_OPTIONS.find((o) => o.value === id);
  return hit ? hit.label : id.replace(/^claude-/, "");
}
