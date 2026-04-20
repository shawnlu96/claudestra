/**
 * Claude Code built-in slash commands — Discord 适配目录
 *
 * 来自 docs.claude.com/en/commands.md。只收那些在 Discord 桥里有意义的命令
 * （不包括 `/clear`, `/exit`, `/config` 等纯 TUI 或危险动作）。
 *
 * 每条命令定义：
 *   - name: Discord slash 名（= CC slash 名，因为都是小写字母，无冲突）
 *   - description: ≤100 字符
 *   - options: Discord option 定义（参考 discord.js）
 *   - invokeName: 发给 Claude Code 的真实命令名（一般等于 name）
 *
 * argBuilder(opts): 把 Discord 收到的 option 拼成 Claude Code 命令后面的参数串。
 * 返回 `` 表示无参数；否则返回 ` args_string`（带前导空格，或空串）。
 */

export type OptType = "string" | "choices";

export interface OptionDef {
  name: string;
  description: string;
  type: OptType;
  required?: boolean;
  choices?: string[];
}

export interface BuiltinCmd {
  name: string;
  invokeName: string;
  description: string;
  options: OptionDef[];
  /** 把 Discord 选项组装成发给 CC 的文本 */
  argBuilder: (vals: Record<string, string>) => string;
}

const simpleStringArg =
  (key: string) =>
  (vals: Record<string, string>) =>
    vals[key] ? ` ${vals[key]}` : "";

/**
 * Claude Code 官方内置命令子集（保留 Discord 有价值的那些）。
 * 删改前先看 docs.claude.com/en/commands.md 确认语义还在。
 */
export const BUILTIN_COMMANDS: BuiltinCmd[] = [
  // —— 信息 / 诊断 —— 无参数
  { name: "cost", invokeName: "cost", description: "显示 token 用量统计", options: [], argBuilder: () => "" },
  { name: "context", invokeName: "context", description: "可视化当前 context 用量 + 优化建议", options: [], argBuilder: () => "" },
  { name: "usage", invokeName: "usage", description: "显示订阅用量和速率限制", options: [], argBuilder: () => "" },
  { name: "doctor", invokeName: "doctor", description: "诊断 Claude Code 安装和设置", options: [], argBuilder: () => "" },
  { name: "help", invokeName: "help", description: "Claude Code 帮助和命令列表", options: [], argBuilder: () => "" },
  { name: "recap", invokeName: "recap", description: "生成一行当前会话摘要", options: [], argBuilder: () => "" },
  { name: "insights", invokeName: "insights", description: "生成会话分析报告", options: [], argBuilder: () => "" },
  { name: "skills", invokeName: "skills", description: "列出当前可用的所有 skill", options: [], argBuilder: () => "" },
  { name: "stats", invokeName: "stats", description: "使用统计（每日用量、历史、streak）", options: [], argBuilder: () => "" },
  { name: "reload-plugins", invokeName: "reload-plugins", description: "重载所有 plugin 以应用更改", options: [], argBuilder: () => "" },
  { name: "sandbox", invokeName: "sandbox", description: "切换 sandbox 模式", options: [], argBuilder: () => "" },

  // —— 动作 ——
  {
    name: "review",
    invokeName: "review",
    description: "本地 review 一个 PR（可选传 PR 号/URL）",
    options: [{ name: "pr", description: "PR 号或 URL", type: "string" }],
    argBuilder: simpleStringArg("pr"),
  },
  {
    name: "security-review",
    invokeName: "security-review",
    description: "分析当前 diff 找安全漏洞",
    options: [],
    argBuilder: () => "",
  },
  {
    name: "plan",
    invokeName: "plan",
    description: "进入 plan 模式，可选带描述",
    options: [{ name: "description", description: "计划描述", type: "string" }],
    argBuilder: simpleStringArg("description"),
  },
  {
    name: "btw",
    invokeName: "btw",
    description: "问一个侧面问题（不进入主对话历史）",
    options: [{ name: "question", description: "要问的问题", type: "string", required: true }],
    argBuilder: simpleStringArg("question"),
  },
  {
    name: "mcp",
    invokeName: "mcp",
    description: "管理 MCP server 连接 / OAuth（如 restart <name>）",
    options: [{ name: "args", description: "子命令 + 参数，例如 'restart mindbase'", type: "string" }],
    argBuilder: simpleStringArg("args"),
  },
{
    name: "rename",
    invokeName: "rename",
    description: "重命名当前 session",
    options: [{ name: "name", description: "新名字", type: "string" }],
    argBuilder: simpleStringArg("name"),
  },
  {
    name: "resume",
    invokeName: "resume",
    description: "按 ID / 名字恢复会话",
    options: [{ name: "session", description: "session ID 或名字", type: "string" }],
    argBuilder: simpleStringArg("session"),
  },
  {
    name: "compact",
    invokeName: "compact",
    description: "摘要当前对话以释放 context（可选指导）",
    options: [{ name: "instructions", description: "摘要时的侧重点指导", type: "string" }],
    argBuilder: simpleStringArg("instructions"),
  },
  {
    name: "feedback",
    invokeName: "feedback",
    description: "向 Anthropic 提交反馈",
    options: [{ name: "report", description: "反馈内容", type: "string" }],
    argBuilder: simpleStringArg("report"),
  },

  // —— 设置切换（带 choices） ——
  {
    name: "effort",
    invokeName: "effort",
    description: "设置 model effort 级别",
    options: [
      {
        name: "level",
        description: "effort 级别",
        type: "choices",
        choices: ["low", "medium", "high", "xhigh", "max", "auto"],
      },
    ],
    argBuilder: simpleStringArg("level"),
  },
  {
    name: "fast",
    invokeName: "fast",
    description: "切换 fast mode",
    options: [
      { name: "state", description: "on 或 off", type: "choices", choices: ["on", "off"] },
    ],
    argBuilder: simpleStringArg("state"),
  },
  {
    name: "tui",
    invokeName: "tui",
    description: "切换 terminal UI 渲染器",
    options: [
      { name: "mode", description: "default 或 fullscreen", type: "choices", choices: ["default", "fullscreen"] },
    ],
    argBuilder: simpleStringArg("mode"),
  },
  {
    name: "model",
    invokeName: "model",
    description: "切换模型（如 opus / sonnet）",
    options: [{ name: "name", description: "模型名", type: "string" }],
    argBuilder: simpleStringArg("name"),
  },
];

/** 名字快速查表 */
export const BUILTIN_COMMAND_BY_NAME: Record<string, BuiltinCmd> = Object.fromEntries(
  BUILTIN_COMMANDS.map((c) => [c.name, c])
);
