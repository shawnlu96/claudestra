/**
 * effort 选项——设置页「全局默认」、会话级切换器（TopBar）、新建 agent 弹窗共用。
 * 模型清单不在这里：从 Bridge 拉 CC 自己的目录（claude-models.ts / useClaudeModels），
 * 此前这里写死的 MODEL_CATALOG 与后端别名表一起落后上游（2026-09-22 Opus 5.5 两边都没有）。
 */
export const EFFORT_OPTIONS = ["low", "medium", "high", "xhigh", "max"] as const;

/**
 * v2.21.1+ 会话级切换器(TopBar)额外可用的档位(peer owner 请求 2026-08-30):
 * ultracode = xhigh 算力 + 动态 workflow 编排,CC 语义「this session only」——
 * 只走 /effort 注入,不进全局默认(settings.json 不认)、不进启动 flag。
 * 需要 CC 的 dynamic workflows 开启,没开时 bridge 会把 CC 的拒绝原因透传回来。
 */
export const RUNTIME_EFFORT_OPTIONS = [...EFFORT_OPTIONS, "ultracode"] as const;

/** model id → 短标签：在目录里就用目录的名字；不在（目录还没到 / 未知 id）去掉 claude- 前缀原样显示。 */
export function modelLabel(id: string | null | undefined, models: readonly { value: string; label: string }[] = []): string {
  if (!id) return "?";
  return models.find((o) => o.value === id)?.label ?? id.replace(/^claude-/, "");
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
