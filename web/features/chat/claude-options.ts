/**
 * 模型 / effort 选项——设置页「全局默认」、会话级切换器（TopBar）、新建 agent 弹窗
 * 共用的**唯一目录**(2026-09-15 合并:此前新建弹窗自维护一份别名列表,与这里漂移过,
 * 两边都漏了 Sonnet 5)。
 *
 * - id    = 完整 model id(settings.json / registry / /model 命令都认它)——切换器与全局默认用;
 * - alias = manager 侧别名(`create --model <alias>`,见 src/lib/claude-launch.ts MODEL_ALIASES)
 *           ——新建 agent 用。一律带版本号,钉死标签所指的那一代;裸家族名(opus/sonnet)
 *           在后端始终跟最新版,不放进 UI 以免标签与实际版本脱节。
 */
export const MODEL_CATALOG = [
  { id: "claude-fable-5-1", alias: "fable-5-1", label: "Fable 5.1" },
  { id: "claude-fable-5", alias: "fable-5", label: "Fable 5" },
  { id: "claude-opus-5", alias: "opus-5", label: "Opus 5" },
  { id: "claude-opus-4-8", alias: "opus-4-8", label: "Opus 4.8" },
  { id: "claude-opus-4-7", alias: "opus-4-7", label: "Opus 4.7" },
  { id: "claude-sonnet-5", alias: "sonnet-5", label: "Sonnet 5" },
  { id: "claude-sonnet-4-6", alias: "sonnet-4-6", label: "Sonnet 4.6" },
  { id: "claude-haiku-4-5-20251001", alias: "haiku-4-5", label: "Haiku 4.5" },
] as const;

/** 切换器 / 全局默认:value = 完整 model id。 */
export const MODEL_OPTIONS = MODEL_CATALOG.map((m) => ({ value: m.id, label: m.label }));

/** 新建 agent 弹窗:value = manager 别名,空 = 跟随全局 settings.json 默认。 */
export const MODEL_ALIAS_OPTIONS = [
  { value: "", label: "默认（跟随全局）" },
  ...MODEL_CATALOG.map((m) => ({ value: m.alias, label: m.label })),
];

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

/**
 * Pi 的思考档位（与 Claude Code 的 effort 不是一套值）：`off` 是 Pi 独有的最低档，
 * `ultracode` 是 CC 独有的运行档——两边不要互相套用。桥接注入的是扩展命令
 * `/claudestra-thinking <level>`。
 */
export const PI_THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;

/**
 * Pi 的 model id → 短标签。Pi 的写法是 `provider/model`（可选 `:thinking` 后缀，
 * 如 `cc-switch-open-code-go/deepseek-v4.1-flash:low`），整串塞进 TopBar 徽章只会被
 * 截成 `cc-switch-…` 什么都看不出来 ⇒ 只取 model 段。
 * 注意**不要**走 modelLabel：那套是 Claude Code 的别名表（Pi 的模型永远不在里面）。
 */
export function piModelLabel(id: string | null | undefined): string {
  if (!id) return "?";
  const tail = id.includes("/") ? id.slice(id.lastIndexOf("/") + 1) : id;
  return tail.replace(/:.*$/, "");
}
